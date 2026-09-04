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

import type { KiroCommand, KiroModelInfo, KiroMode } from "../kiro/protocol.js";

export interface SessionModelState {
  currentModelId: string | undefined;
  availableModels: KiroModelInfo[];
  /** Credit multiplier label per model id, e.g. `"2.20x credits"`. */
  creditGroups: Map<string, string>;
  /** Context window in tokens per model id, when known. */
  contextWindows: Map<string, number>;
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
}

export class BridgeSession {
  readonly sessionId: string;
  readonly cwd: string;

  readonly models: SessionModelState = {
    currentModelId: undefined,
    availableModels: [],
    creditGroups: new Map(),
    contextWindows: new Map(),
  };

  readonly agents: SessionAgentState = {
    currentAgentId: undefined,
    availableAgents: [],
    groups: new Map(),
  };

  readonly effort: SessionEffortState = {
    current: undefined,
    available: [],
  };

  /** Slash commands Kiro advertised for this session. */
  kiroCommands: KiroCommand[] = [];

  /** Latest context-usage percentage from `_kiro.dev/metadata`. */
  contextUsagePercentage: number | undefined;

  /** Absolute token count from the last `/context` reading, when available. */
  usedTokens: number | undefined;

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
