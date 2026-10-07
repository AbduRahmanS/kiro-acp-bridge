/**
 * Per-session state owned by the bridge.
 *
 * The bridge must own this state rather than query Kiro on demand, for a reason
 * discovered during probing: **Kiro emits no notification when the active model
 * or agent changes.** Switching model via `session/set_model` or via
 * `/model <name>` produces only a `_kiro.dev/metadata` context-percentage
 * notification — nothing that identifies the new model.
 *
 * Since every mutation path runs through the bridge (Zed's `set_config_option`,
 * and slash commands which the bridge intercepts), the bridge is the single
 * gateway and can keep an authoritative mirror. That mirror is what lets us push
 * `config_option_update` to Zed so its selectors can never disagree with Kiro.
 */

import type * as schema from "@agentclientprotocol/sdk";
import type { KiroCommand, KiroModelInfo, KiroMode } from "../kiro/protocol.js";
import type { KiroV3McpServer } from "../kiro/protocol-v3.js";

export interface SessionModelState {
  currentModelId: string | undefined;
  availableModels: KiroModelInfo[];
  /** Credit multiplier label per model id, e.g. `"2.20x credits"`. */
  creditGroups: Map<string, string>;
  /** Context window in tokens per model id, when known. */
  contextWindows: Map<string, number>;
  /**
   * Effort levels per model id, from `commands/options {model}`.
   *
   * Only populated when Kiro reports per-model reasoning (2.28+). When it does,
   * a model *absent* from this map has no effort axis; when the map is empty the
   * bridge falls back to asking `commands/options {effort}`.
   */
  effortLevels: Map<string, string[]>;
}

export interface SessionAgentState {
  currentAgentId: string | undefined;
  availableAgents: KiroMode[];
  /** Provenance label per agent id, e.g. `"Built-in"`. */
  groups: Map<string, string>;
}

export interface SessionEffortState {
  /** Currently selected level, or undefined when the model has no effort axis. */
  current: string | undefined;
  /** Valid levels for the *current* model. Empty means no effort axis at all. */
  available: string[];
  /**
   * True only when Kiro is known to be running at `current`.
   *
   * The v2 engine never reports the active effort, so until the bridge has set a
   * level itself `current` is a guess. Treating a guess as fact used to make an
   * explicit choice of the guessed value a silent no-op, leaving Kiro on its own
   * per-model default while Zed displayed something else.
   */
  confirmed: boolean;
}

/** State kept only for sessions running on the CLI V3 engine. */
export interface V3SessionState {
  /** Config options exactly as Kiro last reported them. The source of truth. Untrusted shape. */
  native: Record<string, unknown>[];
  /** True when the user chose the current effort level, so it survives a model switch. */
  effortExplicit: boolean;
  /** Commands Kiro advertised through `available_commands_update`. */
  commands: schema.AvailableCommand[];
  /** Latest `_kiro/mcp/status` snapshot, replaced wholesale on each notification. */
  mcpServers: KiroV3McpServer[] | undefined;
  /** MCP failures already shown in the thread, by server name, to avoid repeats. */
  reportedMcpFailures: Map<string, string>;
  /** Credits consumed by this session's turns, summed from `turn_completion`. */
  creditsUsed: number;
  /** Bridge-initiated changes in flight; Kiro's echoes are not forwarded meanwhile. */
  mutating: number;
  /**
   * Incremented on every `config_option_update` from Kiro. A `set_config_option`
   * response is only adopted if no notification overtook it, so a slower reply
   * can never replace newer state.
   */
  nativeSeq: number;
  /** Names of the last command catalogue sent, to avoid re-sending an identical one. */
  commandSignature: string;
}

export class BridgeSession {
  readonly sessionId: string;
  readonly cwd: string;

  readonly models: SessionModelState = {
    currentModelId: undefined,
    availableModels: [],
    creditGroups: new Map(),
    contextWindows: new Map(),
    effortLevels: new Map(),
  };

  readonly agents: SessionAgentState = {
    currentAgentId: undefined,
    availableAgents: [],
    groups: new Map(),
  };

  readonly effort: SessionEffortState = {
    current: undefined,
    available: [],
    confirmed: false,
  };

  /** Slash commands Kiro advertised for this session. */
  kiroCommands: KiroCommand[] = [];

  /** Latest context-usage percentage from `_kiro.dev/metadata`. */
  contextUsagePercentage: number | undefined;

  /** Absolute token count from the last `/context` reading, when available. */
  usedTokens: number | undefined;

  /**
   * MCP servers the bridge forwarded to Kiro for this session.
   *
   * Kept so the session can be re-attached to a fresh Kiro process with the same
   * inputs; CLI V3 in particular does not persist client-supplied servers.
   */
  mcpServers: schema.NewSessionRequest["mcpServers"] = [];

  /**
   * True when the Kiro process that owned this session has gone away (restart or
   * crash). The next request re-attaches it with `session/load` before use.
   */
  detached = false;

  /** A bridge notice to show the next time this thread is used (e.g. new models loaded). */
  pendingNotice: string | undefined;

  /**
   * True while the bridge is re-attaching the session itself. Kiro replays the
   * transcript during `session/load`; Zed already shows it, so transcript updates
   * are dropped for the duration rather than duplicated in the thread.
   */
  suppressReplay = false;

  /** Present only when the session runs on the CLI V3 engine. */
  v3: V3SessionState | undefined;

  /**
   * False until Zed has received the `session/new` response.
   *
   * Kiro can emit state for a session before that response is sent, and Zed
   * drops updates for a session id it has not seen. Updates the bridge produces
   * meanwhile wait in `outbox` and are flushed, in order, once announced.
   */
  announced = false;
  readonly outbox: schema.SessionUpdate[] = [];

  /**
   * Monotonic generation counter.
   *
   * Async work (re-querying effort after a model switch, refreshing usage after
   * a turn) can complete after the state it was computing for has been
   * superseded. Handlers capture the generation before awaiting and discard their
   * result if it changed, so a slow reply can never clobber newer state.
   */
  private generation = 0;

  constructor(sessionId: string, cwd: string) {
    this.sessionId = sessionId;
    this.cwd = cwd;
  }

  /** Bumps and returns the new generation. Call on every state mutation. */
  bumpGeneration(): number {
    return ++this.generation;
  }

  /** Current generation, to be captured before an await. */
  currentGeneration(): number {
    return this.generation;
  }

  /** True when `gen` is still the newest generation. */
  isCurrent(gen: number): boolean {
    return this.generation === gen;
  }

  /** Context window of the active model, when known. */
  activeContextWindow(): number | undefined {
    if (!this.models.currentModelId) return undefined;
    return this.models.contextWindows.get(this.models.currentModelId);
  }
}

/** Registry of live sessions. */
export class SessionRegistry {
  private readonly sessions = new Map<string, BridgeSession>();

  create(sessionId: string, cwd: string): BridgeSession {
    const s = new BridgeSession(sessionId, cwd);
    this.sessions.set(sessionId, s);
    return s;
  }

  get(sessionId: string): BridgeSession | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  all(): BridgeSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Best-effort cwd lookup for a session id.
   *
   * Falls back to the supplied default when the session is unknown, which can
   * happen for updates that arrive during session setup.
   */
  cwdFor(sessionId: string | undefined, fallback: string): string {
    if (!sessionId) return fallback;
    return this.sessions.get(sessionId)?.cwd ?? fallback;
  }
}
