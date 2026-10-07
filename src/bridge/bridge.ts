/**
 * The bridge itself.
 *
 * Northbound it is a standards-compliant ACP **agent** that Zed talks to.
 * Southbound it is an ACP **client** driving `kiro-cli acp`. All Kiro-specific
 * vocabulary is confined to the southbound side and to the translation modules;
 * Zed only ever sees stable ACP v1.
 */

import {
  agent,
  ndJsonStream,
  RequestError,
  type AgentConnection,
  type AgentContext,
} from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { createRequire } from "node:module";
import type { Diagnostics } from "../diagnostics/logging.js";
import { KiroConnection } from "../kiro/connection.js";
import { KiroNotFoundError } from "../kiro/discovery.js";
import { engineOrder } from "../kiro/process.js";
import {
  KIRO_METHODS,
  kiroCommandsAvailableSchema,
  kiroMcpOauthRequestSchema,
  kiroMetadataSchema,
  oauthUrlOf,
  stateFromCommandResult,
} from "../kiro/protocol.js";
import { KIRO_V3_METHODS, TRANSCRIPT_UPDATE_KINDS, type KiroDialect } from "../kiro/protocol-v3.js";
import { normalizeToolCallPaths, type PathContext } from "./paths.js";
import {
  applyConfigOption,
  buildConfigOptions,
  buildModeState,
  InvalidConfigValueError,
  reconcileEffortAfterModelChange,
  refreshAll,
  refreshAgents,
  refreshEffort,
  refreshModels,
  UnknownConfigOptionError,
} from "./config.js";
import {
  buildAvailableCommands,
  commandFromPrompt,
  planCommand,
  RESTART_COMMAND,
  type ParsedCommand,
} from "./commands.js";
import { initialV3State, V3Adapter } from "./v3-adapter.js";
import {
  checkIntervalMs,
  describeChange,
  diffRoster,
  fetchModelIds,
  hasChanges,
  type RosterDiff,
} from "./model-watch.js";
import { humaniseModelId, preferSuppliedLabel } from "./labels.js";
import { discoverSkills, type DiscoveredSkill } from "./skills.js";
import { authRequiredMessage, buildAuthMethods, isAuthError, KIRO_LOGIN_METHOD_ID } from "./auth.js";
import {
  buildUsageUpdate,
  contextUsageFrom,
  formatCreditSummary,
  impliedContextWindow,
} from "./usage.js";
import {
  buildOauthElicitation,
  deduplicateMcpServers,
  formatMcpStatus,
  kiroManagedServerNames,
} from "./mcp.js";
import { SessionRegistry, type BridgeSession } from "./session.js";

export interface BridgeOptions {
  diagnostics: Diagnostics;
  /** Explicit `kiro-cli` path; otherwise discovered. */
  kiroPath?: string | undefined;
  /** `v2`, `v3`, or `auto` (V3 first, v2 fallback). Defaults to v2 (see kiro/process.ts). */
  agentEngine?: string | undefined;
  /** Working directory for the Kiro child. Defaults to the bridge's own cwd. */
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

/** Upper bound for Kiro's `initialize`. V3 unpacks its harness on first run. */
const INIT_TIMEOUT_MS = 90_000;

/** Updates that arrive for a session id before `session/new` has returned. */
type Unclaimed = { kind: "update"; update: Record<string, unknown> } | { kind: "mcp"; params: unknown };

export class KiroBridge {
  private readonly diagnostics: Diagnostics;
  private readonly options: BridgeOptions;
  private readonly sessions = new SessionRegistry();
  private readonly kiroProcessCwd: string;

  private kiro: KiroConnection | undefined;
  /** In-flight spawn+initialize, shared so concurrent requests start one Kiro. */
  private connecting: Promise<KiroConnection> | undefined;
  /** Kiro's last `initialize` result, for the northbound handshake. */
  private kiroInit: schema.InitializeResponse | undefined;
  /** The engine that first started successfully; respawns reuse it. */
  private lockedEngine: string | undefined;
  /** Which server generation the current connection speaks. */
  private dialect: KiroDialect = "v2";
  private readonly v3: V3Adapter;
  /** Kiro output for sessions whose `session/new` has not returned yet. */
  private readonly unclaimed = new Map<string, Unclaimed[]>();
  private pendingSessionCreations = 0;
  /** Prompts in flight per session, so a restart never kills someone's turn. */
  private readonly inflight = new Map<string, number>();
  /** Most recently prompted session, where Kiro-initiated links are shown. */
  private lastActiveSessionId: string | undefined;
  private zed: AgentConnection | undefined;
  /** Capabilities Zed advertised, needed to decide what we may call back. */
  private clientCapabilities: schema.ClientCapabilities | undefined;
  private shuttingDown = false;
  /** Monotonic counter for elicitation ids, so each OAuth prompt is distinct. */
  private elicitationCounter = 0;
  /** Ensures the "Kiro not found" guidance is printed once, not per request. */
  private reportedMissingKiro = false;

  /** Model ids the running Kiro process loaded; reset whenever Kiro is replaced. */
  private loadedModels: string[] | undefined;
  /** Change between `loadedModels` and the account's current list, once detected. */
  private pendingRoster: RosterDiff | undefined;
  private lastModelCheck = 0;
  private modelCheck: Promise<void> | undefined;
  private reloading: Promise<void> | undefined;
  private readonly modelCheckIntervalMs: number;

  constructor(options: BridgeOptions) {
    this.options = options;
    this.diagnostics = options.diagnostics;
    this.kiroProcessCwd = options.cwd ?? process.cwd();
    this.modelCheckIntervalMs = checkIntervalMs(options.env ?? process.env);
    this.v3 = new V3Adapter({
      diagnostics: this.diagnostics,
      ensureKiro: () => this.ensureKiro(),
      sendUpdate: (session, update) => this.sendUpdate(session, update),
      postNotice: (session, text) => this.notifyAgentMessage(session.sessionId, text),
      offerUrl: (session, url, message) => this.offerUrl(session, url, message),
    });
  }

  /** Zed-facing context for pushing notifications. */
  private get client(): AgentContext {
    if (!this.zed) throw new Error("bridge not connected");
    return this.zed.client;
  }

  private pathContext(sessionId: string | undefined): PathContext {
    return {
      sessionCwd: this.sessions.cwdFor(sessionId, this.kiroProcessCwd),
      kiroProcessCwd: this.kiroProcessCwd,
    };
  }

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  /**
   * Serves ACP on the given stdio streams, spawning Kiro lazily on `initialize`.
   *
   * Resolves when the northbound connection closes.
   */
  async serve(
    stdin: NodeJS.ReadableStream = process.stdin,
    stdout: NodeJS.WritableStream = process.stdout,
  ): Promise<void> {
    const stream = ndJsonStream(
      Writable.toWeb(stdout as import("node:stream").Writable) as WritableStream<Uint8Array>,
      Readable.toWeb(stdin as import("node:stream").Readable) as ReadableStream<Uint8Array>,
    );

    const app = agent({ name: "kiro-acp-bridge" })
      .onRequest("initialize", async (ctx) => await this.handleInitialize(ctx.params))
      .onRequest("authenticate", async (ctx) => await this.handleAuthenticate(ctx.params))
      .onRequest("session/new", async (ctx) => await this.handleNewSession(ctx.params))
      .onRequest("session/load", async (ctx) => await this.handleLoadSession(ctx.params))
      .onRequest("session/prompt", async (ctx) => await this.handlePrompt(ctx.params))
      .onRequest(
        "session/set_config_option",
        async (ctx) => await this.handleSetConfigOption(ctx.params),
      )
      .onRequest("session/set_mode", async (ctx) => await this.handleSetMode(ctx.params))
      .onRequest("session/list", async (ctx) => await this.handleSessionList(ctx.params))
      .onRequest("session/close", async (ctx) => await this.handleCloseSession(ctx.params))
      .onRequest("session/delete", async (ctx) => await this.handleDeleteSession(ctx.params))
      .onNotification("session/cancel", async (ctx) => await this.handleCancel(ctx.params));

    this.zed = app.connect(stream);
    this.diagnostics.info("bridge listening on stdio");

    await this.zed.closed;
    this.diagnostics.info("northbound connection closed");
    await this.shutdown();
  }

  /**
   * Returns a live, initialized Kiro connection, starting one if needed.
   *
   * A dead connection is never returned: after Kiro exits (crash, restart,
   * sign-in) the next caller transparently starts a new one. Previously the dead
   * connection was cached forever, so every new thread failed until Zed itself
   * restarted the agent.
   */
  private async ensureKiro(): Promise<KiroConnection> {
    if (this.kiro && !this.kiro.process.hasExited) return this.kiro;
    this.kiro = undefined;
    this.connecting ??= this.connectKiro().finally(() => {
      this.connecting = undefined;
    });
    return await this.connecting;
  }

  /**
   * Starts Kiro and completes its handshake, trying engines in order.
   *
   * With `auto`, V3 is tried first and v2 is the fallback when V3 cannot start.
   * An authentication failure is not a reason to fall back — the same account
   * would fail on v2 too — so it surfaces as ACP "authentication required".
   * The first engine that works is locked in, so a respawn never silently
   * changes the dialect underneath existing threads.
   */
  private async connectKiro(): Promise<KiroConnection> {
    const engines = this.lockedEngine ? [this.lockedEngine] : engineOrder(this.options.agentEngine);
    let lastError: unknown;

    for (const engine of engines) {
      const conn = this.spawnKiro(engine);
      try {
        const init = await withTimeout(
          conn.initialize({
            protocolVersion: 1,
            clientCapabilities: southboundCapabilities(this.clientCapabilities),
            clientInfo: { name: "kiro-acp-bridge", title: "Kiro ACP Bridge", version: BRIDGE_VERSION },
          }),
          INIT_TIMEOUT_MS,
          `kiro-cli (${engine} engine) did not answer initialize within ${INIT_TIMEOUT_MS / 1000}s`,
        );
        if (init.protocolVersion < 1) {
          throw new Error(`Kiro advertised unsupported ACP protocol version ${init.protocolVersion}.`);
        }
        this.kiro = conn;
        this.kiroInit = init;
        this.lockedEngine = engine;
        this.dialect = conn.dialect;
        this.v3.extensionMethods = conn.extensionMethods;
        this.loadedModels = undefined;
        this.diagnostics.info("kiro connected", {
          engine,
          dialect: this.dialect,
          version: init.agentInfo?.version,
          extensionMethods: this.v3.extensionMethods.length,
        });
        return conn;
      } catch (err) {
        lastError = err;
        // Give a failing child a moment to print why, then make sure it is gone.
        await Promise.race([conn.process.waitForExit(), sleep(750)]);
        const stderrTail = conn.process.stderrTail();
        await conn.shutdown().catch(() => {});
        if (isAuthError(err) || isAuthError(stderrTail)) {
          this.diagnostics.warn("kiro is not signed in", { engine });
          throw new RequestError(AUTH_REQUIRED_CODE, "Authentication required", { details: authRequiredMessage() });
        }
        this.diagnostics.warn("kiro engine failed to start", {
          engine,
          message: (err as Error).message,
          stderrTail: stderrTail.split("\n").slice(-5).join("\n"),
          willTryNext: engine !== engines.at(-1),
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Kiro failed to start.");
  }

  /** Spawns one Kiro process and wires its client-side callbacks back toward Zed. */
  private spawnKiro(engine: string): KiroConnection {
    // Assigned right after spawn; exit events are always delivered later.
    let self: KiroConnection | undefined;
    try {
      self = KiroConnection.spawnSync({
        diagnostics: this.diagnostics,
        executablePath: this.options.kiroPath,
        agentEngine: engine,
        cwd: this.kiroProcessCwd,
        env: this.options.env ?? process.env,
        onUnexpectedExit: (info) => this.onKiroDied(self, info),
        handlers: {
          sessionUpdate: (params) => this.forwardSessionUpdate(params),
          requestPermission: (params) => this.forwardPermission(params),
          readTextFile: (params) => this.client.request("fs/read_text_file", params),
          writeTextFile: (params) => this.client.request("fs/write_text_file", params),
          createTerminal: (params) => this.client.request("terminal/create", params),
          terminalOutput: (params) => this.client.request("terminal/output", params),
          releaseTerminal: (params) => this.client.request("terminal/release", params),
          waitForTerminalExit: (params) => this.client.request("terminal/wait_for_exit", params),
          killTerminal: (params) => this.client.request("terminal/kill", params),
          // Kiro only sends these when Zed advertised elicitation, since Zed's
          // capabilities are passed through. Unforwarded they would fail with
          // "method not found" and break whatever Kiro was asking about.
          createElicitation: (params) => this.client.request("elicitation/create", params),
          completeElicitation: (params) => this.client.notify("elicitation/complete", params),
          openExternalUrl: (params) => {
            const session = this.lastActiveSessionId ? this.sessions.get(this.lastActiveSessionId) : this.sessions.all()[0];
            return this.v3.openExternalUrl(session, params);
          },
          extensionNotification: (method, params) => this.onKiroExtension(method, params),
        },
      });
      return self;
    } catch (err) {
      if (err instanceof KiroNotFoundError) {
        // Kiro is spawned lazily, on the first `initialize`, so this failure
        // arrives inside a JSON-RPC request rather than at process startup. The
        // actionable text would therefore be buried in an error payload and
        // never reach stderr — which is exactly where Zed's ACP log viewer and
        // most users look. Write it there explicitly, once, before rethrowing.
        if (!this.reportedMissingKiro) {
          this.reportedMissingKiro = true;
          process.stderr.write(`\n${err.message}\n\n`);
        }
        throw RequestError.internalError(
          { searched: err.searched },
          err.message.split("\n")[0] ?? "Kiro CLI was not found.",
        );
      }
      throw err;
    }
  }

  private onKiroDied(
    conn: KiroConnection | undefined,
    info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string },
  ): void {
    if (this.shuttingDown) return;
    // A failed start attempt, or a process already replaced: nothing to recover.
    if (!conn || conn !== this.kiro) return;
    this.diagnostics.error("kiro-cli exited unexpectedly", { code: info.code, signal: info.signal });
    this.kiro = undefined;
    for (const session of this.sessions.all()) session.detached = true;

    // Surface it in the thread so the failure is visible in Zed, not just in logs.
    for (const session of this.sessions.all()) {
      void this.notifyAgentMessage(
        session.sessionId,
        `**Kiro CLI stopped unexpectedly** (exit code ${info.code ?? "none"}${info.signal ? `, signal ${info.signal}` : ""}).\n\n` +
          "The bridge starts Kiro again on your next message and reconnects this thread.\n" +
          (info.stderrTail ? `\nLast output from Kiro:\n\`\`\`\n${info.stderrTail}\n\`\`\`` : ""),
      ).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Restart and re-attach
  // -------------------------------------------------------------------------

  /** Re-attaches a session whose Kiro process went away, before it is used. */
  private async ensureAttached(session: BridgeSession): Promise<void> {
    if (this.reloading) await this.reloading.catch(() => {});
    if (session.detached) await this.reattach(session);
  }

  // -------------------------------------------------------------------------
  // New models
  // -------------------------------------------------------------------------

  /** Model ids currently offered in a session's picker. */
  private modelIdsOf(session: BridgeSession): string[] {
    const option =
      this.dialect === "v3"
        ? this.v3.configOptions(session).find((o) => o.id === "model")
        : buildConfigOptions(session).find((o) => o.id === "model");
    const opts = (option as { options?: unknown } | undefined)?.options;
    if (!Array.isArray(opts)) return [];
    return opts.flatMap((o: { value?: string; options?: Array<{ value?: string }> }) =>
      o.options ? o.options.map((x) => x.value ?? "") : [o.value ?? ""],
    ).filter(Boolean);
  }

  /** Display name of a model id, as the picker shows it. */
  private modelName(session: BridgeSession | undefined, id: string): string {
    if (session) {
      const option =
        this.dialect === "v3"
          ? this.v3.configOptions(session).find((o) => o.id === "model")
          : buildConfigOptions(session).find((o) => o.id === "model");
      const opts = (option as { options?: unknown } | undefined)?.options;
      if (Array.isArray(opts)) {
        for (const o of opts as Array<{ value?: string; name?: string; options?: Array<{ value?: string; name?: string }> }>) {
          for (const v of o.options ?? [o]) if (v.value === id && v.name) return v.name;
        }
      }
    }
    return preferSuppliedLabel(id, undefined, humaniseModelId);
  }

  /** Records what the running Kiro loaded, from the first session that shows it. */
  private recordLoadedModels(session: BridgeSession): void {
    if (this.loadedModels) return;
    const ids = this.modelIdsOf(session);
    if (ids.length > 0) this.loadedModels = ids;
  }

  /**
   * Compares the running Kiro's models with the account's current list, at most
   * once per interval, in the background. Never blocks a request.
   */
  private maybeCheckModels(): void {
    if (this.modelCheckIntervalMs === 0 || this.modelCheck || !this.loadedModels) return;
    if (Date.now() - this.lastModelCheck < this.modelCheckIntervalMs) return;
    const kiro = this.kiro;
    if (!kiro) return;
    this.lastModelCheck = Date.now();
    const loaded = this.loadedModels;
    this.modelCheck = fetchModelIds(kiro.process.discovery.path, this.options.env ?? process.env)
      .then((current) => {
        if (!current || current.length === 0 || loaded !== this.loadedModels) return;
        const diff = diffRoster(loaded, current);
        if (!hasChanges(diff)) return;
        this.diagnostics.info("model list changed", diff);
        this.pendingRoster = diff;
        // Existing threads get told once, on their next use.
        const text = describeChange(diff, (id) => this.modelName(this.sessions.all()[0], id), false);
        for (const s of this.sessions.all()) s.pendingNotice = text;
      })
      .catch(() => {})
      .finally(() => {
        this.modelCheck = undefined;
      });
  }

  /** True when no thread has a turn running, so Kiro can be replaced safely. */
  private isIdle(): boolean {
    return [...this.inflight.values()].every((n) => n === 0);
  }

  /**
   * Reloads Kiro if the model list changed and nothing is running.
   *
   * Called when a thread is created, which is when a user expects the latest
   * models. Other threads stay intact: they re-attach lazily on next use.
   * Returns the notice to show in the new thread, if a reload happened.
   */
  private async reloadForNewModelsIfIdle(): Promise<string | undefined> {
    const diff = this.pendingRoster;
    if (!diff || !this.isIdle() || this.reloading) return undefined;
    this.pendingRoster = undefined;
    this.diagnostics.info("reloading kiro for new models", diff);
    this.reloading = this.replaceKiro().finally(() => {
      this.reloading = undefined;
    });
    await this.reloading;
    for (const s of this.sessions.all()) s.pendingNotice = undefined;
    return diff.added.length > 0 || diff.removed.length > 0 ? describeChange(diff, (id) => this.modelName(undefined, id)) : undefined;
  }

  /** Shuts the current Kiro down; every session re-attaches on next use. */
  private async replaceKiro(): Promise<void> {
    const old = this.kiro;
    this.kiro = undefined;
    this.loadedModels = undefined;
    for (const s of this.sessions.all()) s.detached = true;
    await old?.shutdown().catch(() => {});
    await this.ensureKiro();
  }

  /**
   * Loads a session into the current Kiro process with the inputs it was created
   * with. Kiro replays the transcript during `session/load`; Zed already shows
   * it, so transcript updates are dropped until the load returns (replay always
   * precedes the response on Kiro's ordered stream).
   */
  private async reattach(session: BridgeSession): Promise<void> {
    const kiro = await this.ensureKiro();
    const params = {
      sessionId: session.sessionId as schema.SessionId,
      cwd: session.cwd,
      mcpServers: session.mcpServers,
    };
    session.suppressReplay = true;
    try {
      if (this.dialect === "v3") {
        session.v3 ??= initialV3State();
        const seq = this.v3.seq(session);
        const res = await kiro.v3LoadSession(params);
        this.v3.adoptNative(session, res.configOptions, seq);
      } else {
        const confirmed = session.effort.confirmed ? session.effort.current : undefined;
        const loaded = await kiro.loadSession(params);
        if (loaded?.models) {
          session.models.currentModelId = loaded.models.currentModelId;
          session.models.availableModels = loaded.models.availableModels;
        }
        if (loaded?.modes) {
          session.agents.currentAgentId = loaded.modes.currentModeId;
          session.agents.availableAgents = loaded.modes.availableModes;
        }
        await refreshAll(kiro, session);
        // v2 cannot report effort, so re-assert a level the user chose.
        if (confirmed && session.effort.available.includes(confirmed)) {
          const res = await kiro.execute(session.sessionId, "effort", { level: confirmed });
          if (res.success !== false) {
            session.effort.current = confirmed;
            session.effort.confirmed = true;
          }
        }
      }
      session.detached = false;
      session.bumpGeneration();
      this.diagnostics.info("session re-attached", { sessionId: session.sessionId, dialect: this.dialect });
    } catch (err) {
      if (isAuthError(err)) this.rethrowKiroError(err, "session/load");
      throw RequestError.internalError(
        { sessionId: session.sessionId },
        `Could not reconnect this thread to Kiro (${(err as Error).message}). Start a new thread to continue.`,
      );
    } finally {
      session.suppressReplay = false;
    }
  }

  /**
   * `/restart-kiro`: restarts the Kiro child, keeping the bridge and the thread.
   *
   * Kiro loads its model roster once per process, so this is how newly released
   * models appear without restarting Zed. Refused while another thread has a turn
   * running, because restarting would kill that turn. Other threads re-attach
   * lazily on their next request.
   */
  private async restartKiro(session: BridgeSession): Promise<void> {
    const busy = [...this.inflight.entries()].some(([id, n]) => n > 0 && id !== session.sessionId);
    if (busy) {
      await this.notifyAgentMessage(
        session.sessionId,
        "Kiro is working in another thread. Try `/restart-kiro` again when that turn finishes.",
      );
      return;
    }

    this.diagnostics.info("restarting kiro on request", { sessionId: session.sessionId });
    const before = this.modelIdsOf(session);
    await this.replaceKiro();
    this.pendingRoster = undefined;
    for (const s of this.sessions.all()) s.pendingNotice = undefined;

    await this.reattach(session);
    if (this.dialect === "v3") await this.v3.waitForModelOption(session);
    this.recordLoadedModels(session);
    this.lastModelCheck = Date.now();
    await this.pushConfigOptions(session);
    await this.publishCommands(session).catch(() => {});

    const after = this.modelIdsOf(session);
    const diff = diffRoster(before, after);
    const names = after.map((id) => this.modelName(session, id));
    const summary = hasChanges(diff)
      ? describeChange(diff, (id) => this.modelName(session, id))
      : "The model list is unchanged.";
    await this.notifyAgentMessage(
      session.sessionId,
      `**Kiro restarted.** ${summary}` + (names.length > 0 ? `\n\nModels available: ${names.join(", ")}.` : ""),
    );
  }

  // -------------------------------------------------------------------------
  // initialize
  // -------------------------------------------------------------------------

  private async handleInitialize(
    params: schema.InitializeRequest,
  ): Promise<schema.InitializeResponse> {
    this.diagnostics.trace("zed->bridge", { method: "initialize", params });
    this.clientCapabilities = params.clientCapabilities;

    let kiroInit: schema.InitializeResponse | undefined;
    try {
      await this.ensureKiro();
      kiroInit = this.kiroInit;
    } catch (err) {
      // A failed handshake with Kiro must not fail the handshake with the client.
      //
      // ACP's `initialize` is capability negotiation, and it is also how the
      // client learns which auth methods exist. If we reject it, the client has
      // no way to offer the user a sign-in flow and simply reports a dead agent.
      // Instead: complete the handshake with conservative capabilities plus the
      // terminal auth method, and let the real failure surface at `session/new`
      // where it can be explained. The actionable guidance has already gone to
      // stderr by this point.
      this.diagnostics.error("kiro handshake failed; completing initialize in degraded mode", {
        message: (err as Error).message,
      });
      const degraded: schema.InitializeResponse = {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
        },
        authMethods: buildAuthMethods(undefined, params.clientCapabilities),
        agentInfo: { name: "Kiro", title: "Kiro (unavailable)", version: BRIDGE_VERSION },
      };
      this.diagnostics.trace("bridge->zed", { method: "initialize", params: degraded });
      return degraded;
    }

    if (!kiroInit) throw RequestError.internalError(undefined, "Kiro did not complete its handshake.");

    const kiroCaps = kiroInit.agentCapabilities ?? {};
    const kiroSessionCaps = (kiroCaps.sessionCapabilities ?? {}) as Record<string, unknown>;

    // Northbound: report what the *bridge* supports. Prompt and MCP capabilities
    // are Kiro's, because we cannot manufacture them. Everything the bridge adds
    // on top is declared here. No vendor `_meta` crosses to Zed.
    const response: schema.InitializeResponse = {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: kiroCaps.loadSession ?? false,
        promptCapabilities: kiroCaps.promptCapabilities ?? {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: kiroCaps.mcpCapabilities ?? { http: false, sse: false },
        sessionCapabilities: {
          // v2 reports none although `_kiro.dev/session/list` works, so the
          // bridge implements `session/list` itself; V3 has it natively.
          list: {},
          // `close` frees the bridge's state on v2 and is forwarded on V3.
          close: {},
          // Deletion only where Kiro implements it; there is no v2 route.
          ...(this.dialect === "v3" && kiroSessionCaps.delete !== undefined ? { delete: {} } : {}),
        },
      },
      // The terminal method (`kiro-cli login`) is the sign-in path that works in
      // every state. V3's own methods are not forwarded: with CLI-owned auth a
      // signed-out V3 exits before it can answer `authenticate` at all.
      authMethods: buildAuthMethods(
        this.dialect === "v3" ? [] : kiroInit.authMethods,
        params.clientCapabilities,
      ),
      agentInfo: {
        name: "Kiro",
        title: kiroInit.agentInfo?.version
          ? `Kiro ${kiroInit.agentInfo.version}${this.dialect === "v3" ? " (CLI V3)" : ""}`
          : this.dialect === "v3"
            ? "Kiro (CLI V3)"
            : "Kiro",
        version: BRIDGE_VERSION,
      },
    };

    this.diagnostics.info("northbound initialize complete", {
      kiroVersion: kiroInit.agentInfo?.version,
      engine: this.lockedEngine,
      dialect: this.dialect,
      promptCapabilities: response.agentCapabilities?.promptCapabilities,
      authMethods: response.authMethods?.map((m) => m.id),
    });
    this.diagnostics.trace("bridge->zed", { method: "initialize", params: response });
    return response;
  }

  /**
   * Handles `authenticate`.
   *
   * The terminal method is executed by the *client*, which re-runs this binary
   * with `--login`; there is nothing for us to do here but acknowledge it. Any
   * other method id is forwarded to Kiro in case it gains its own flows.
   */
  private async handleAuthenticate(
    params: schema.AuthenticateRequest,
  ): Promise<schema.AuthenticateResponse> {
    this.diagnostics.info("authenticate requested", { methodId: params.methodId });
    if (params.methodId === KIRO_LOGIN_METHOD_ID) {
      // Terminal auth is client-driven. Drop the cached connection so the next
      // request re-spawns Kiro and picks up the new credentials.
      await this.kiro?.shutdown().catch(() => {});
      this.kiro = undefined;
      for (const s of this.sessions.all()) s.detached = true;
      return {};
    }
    const kiro = await this.ensureKiro();
    await kiro.authenticate(params.methodId);
    return {};
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  private async handleNewSession(
    params: schema.NewSessionRequest,
  ): Promise<schema.NewSessionResponse> {
    this.diagnostics.trace("zed->bridge", { method: "session/new", params });
    // A new thread is when people expect the latest models, and the safest moment
    // to reload Kiro: nothing is attached to the new thread yet.
    const reloadNotice = await this.reloadForNewModelsIfIdle().catch((err) => {
      this.diagnostics.warn("reload for new models failed", { message: (err as Error).message });
      return undefined;
    });
    const kiro = await this.ensureKiro();
    const response =
      this.dialect === "v3" ? await this.newSessionV3(kiro, params) : await this.newSessionV2(kiro, params);
    const session = this.sessions.get(response.sessionId);
    if (session) {
      this.recordLoadedModels(session);
      if (reloadNotice) void this.notifyAgentMessage(session.sessionId, reloadNotice).catch(() => {});
    }
    this.maybeCheckModels();
    return response;
  }

  private async newSessionV2(
    kiro: KiroConnection,
    params: schema.NewSessionRequest,
  ): Promise<schema.NewSessionResponse> {
    // Kiro loads its own MCP servers from .kiro/settings/mcp.json and agent
    // configs. Forwarding Zed's list unfiltered would start duplicates, so drop
    // any Kiro already manages.
    const request = await this.dedupeMcp(params);

    let kiroSession;
    try {
      kiroSession = await kiro.newSession(request);
    } catch (err) {
      // Translate a credentials problem into ACP's dedicated code, so the client
      // offers the auth methods from `initialize` instead of showing an opaque
      // internal error to a user who simply needs to sign in.
      this.rethrowKiroError(err, "session/new");
    }
    const session = this.sessions.create(kiroSession.sessionId, params.cwd);
    session.mcpServers = request.mcpServers ?? [];

    // Seed the mirrored state from what session/new returned. Kiro sends the
    // legacy `models`/`modes` blocks here; Tasks 3–5 turn these into ACP config
    // options.
    if (kiroSession.models) {
      session.models.currentModelId = kiroSession.models.currentModelId;
      session.models.availableModels = kiroSession.models.availableModels;
    }
    if (kiroSession.modes) {
      session.agents.currentAgentId = kiroSession.modes.currentModeId;
      session.agents.availableAgents = kiroSession.modes.availableModes;
    }

    this.diagnostics.info("session created", {
      sessionId: kiroSession.sessionId,
      cwd: params.cwd,
      model: session.models.currentModelId,
      agent: session.agents.currentAgentId,
      modelCount: session.models.availableModels.length,
      agentCount: session.agents.availableAgents.length,
    });

    // Enrich the seed with the data only `commands/options` carries: credit
    // multipliers, agent grouping, the active markers, and the effort axis for
    // the active model. This must complete before responding, because the
    // response is where Zed learns the initial config state.
    await refreshAll(kiro, session);

    const configOptions = buildConfigOptions(session);
    const modes = buildModeState(session);

    this.diagnostics.info("session config options", {
      model: session.models.currentModelId,
      agent: session.agents.currentAgentId,
      effort: session.effort.current,
      effortAvailable: session.effort.available,
      optionIds: configOptions.map((o) => o.id),
    });

    const response: schema.NewSessionResponse = {
      sessionId: kiroSession.sessionId as schema.SessionId,
      ...(configOptions.length > 0 ? { configOptions } : {}),
      // Offered alongside configOptions for older clients. Zed ignores `modes`
      // when configOptions is present, which is the behaviour the spec asks for.
      ...(modes ? { modes } : {}),
    };
    this.diagnostics.trace("bridge->zed", { method: "session/new", params: response });

    // ACP has no `availableCommands` field on the session-creation response, so
    // the catalogue can only be delivered by notification. Deferred past the
    // response so it cannot race Zed's own session setup.
    this.scheduleCommandPublish(session);
    this.scheduleUsageRefresh(session);
    this.scheduleMcpStatusCheck(session);
    this.announce(session);

    return response;
  }

  /**
   * `session/new` on CLI V3.
   *
   * V3 can emit commands, MCP status and usage for the new id before this
   * request returns. Those are held as "unclaimed" until the session exists,
   * then replayed through the adapter. A stashed `config_option_update` is
   * skipped because the response itself carries the authoritative options.
   */
  private async newSessionV3(
    kiro: KiroConnection,
    params: schema.NewSessionRequest,
  ): Promise<schema.NewSessionResponse> {
    const request = await this.dedupeMcp(params);
    this.pendingSessionCreations++;
    let session: BridgeSession;
    try {
      let res;
      try {
        res = await kiro.v3NewSession(request);
      } catch (err) {
        this.rethrowKiroError(err, "session/new");
      }
      if (!res.sessionId) throw RequestError.internalError(undefined, "Kiro did not return a session id.");

      session = this.sessions.create(res.sessionId, params.cwd);
      session.v3 = initialV3State();
      session.mcpServers = request.mcpServers ?? [];
      this.v3.adoptNative(session, res.configOptions);

      for (const item of this.unclaimed.get(res.sessionId) ?? []) {
        if (item.kind === "mcp") await this.v3.onMcpStatus(session, item.params);
        else if (item.update.sessionUpdate !== "config_option_update") await this.v3.onSessionUpdate(session, item.update);
      }
      this.unclaimed.delete(res.sessionId);
    } finally {
      this.pendingSessionCreations--;
      if (this.pendingSessionCreations === 0) this.unclaimed.clear();
    }

    await this.v3.applySafeDefaults(session).catch((err) =>
      this.diagnostics.warn("could not apply the supervised default", { message: (err as Error).message }),
    );

    const configOptions = this.v3.configOptions(session);
    const modes = this.v3.modeState(session);
    this.diagnostics.info("session created", {
      sessionId: session.sessionId,
      dialect: "v3",
      cwd: params.cwd,
      optionIds: configOptions.map((o) => o.id),
    });

    this.announce(session);
    setTimeout(() => void this.v3.publishCommands(session, true).catch(() => {}), 0);
    return {
      sessionId: session.sessionId as schema.SessionId,
      ...(configOptions.length > 0 ? { configOptions } : {}),
      ...(modes ? { modes } : {}),
    };
  }

  /**
   * Marks a session as known to Zed once the current response has been written,
   * flushing anything produced meanwhile, in order.
   */
  private announce(session: BridgeSession): void {
    setTimeout(() => {
      if (!this.zed) return;
      const queued = session.outbox.splice(0);
      // Issued synchronously so nothing can interleave ahead of the backlog.
      for (const update of queued) {
        void this.client
          .notify("session/update", { sessionId: session.sessionId as schema.SessionId, update })
          .catch(() => {});
      }
      session.announced = true;
    }, 0);
  }

  /** Sends one session update to Zed, or queues it until the session is announced. */
  private async sendUpdate(session: BridgeSession, update: schema.SessionUpdate): Promise<void> {
    if (!this.zed) return;
    if (!session.announced) {
      session.outbox.push(update);
      return;
    }
    await this.client.notify("session/update", { sessionId: session.sessionId as schema.SessionId, update });
  }

  /**
   * Asks Zed to open a URL through a visible user action, or prints it in the
   * thread when Zed cannot. The URL is never logged.
   */
  private async offerUrl(session: BridgeSession, url: string, message: string): Promise<boolean> {
    const supportsUrl = this.clientCapabilities?.elicitation?.url !== undefined;
    if (supportsUrl) {
      try {
        const res = (await this.client.request("elicitation/create", {
          sessionId: session.sessionId as schema.SessionId,
          mode: "url",
          elicitationId: `kiro-url-${++this.elicitationCounter}`,
          url,
          message,
        } as schema.CreateElicitationRequest)) as { action?: string };
        return res.action === "accept";
      } catch (err) {
        this.diagnostics.warn("URL elicitation failed", { message: (err as Error).message });
      }
    }
    await this.notifyAgentMessage(session.sessionId, `${message}\n\n${url}`);
    return true;
  }

  // -------------------------------------------------------------------------
  // MCP
  // -------------------------------------------------------------------------

  /** Removes MCP servers Kiro already manages, to avoid starting duplicates. */
  private async dedupeMcp<T extends { mcpServers?: schema.NewSessionRequest["mcpServers"] | undefined }>(
    params: T,
  ): Promise<T> {
    const servers = params.mcpServers ?? [];
    if (servers.length === 0) return params;

    // Kiro's own server set is per-session, so on the very first session it may
    // be unknown; forwarding everything is the safe default in that case.
    let managed: string[] = [];
    if (this.dialect === "v3") {
      managed = this.v3.managedMcpNames(this.sessions.all());
    } else {
      try {
        const anySession = this.sessions.all()[0];
        if (anySession) {
          const status = await this.kiro?.mcpStartupStatus(anySession.sessionId);
          managed = kiroManagedServerNames(status);
        }
      } catch {
        /* best effort */
      }
    }

    const { forward, skipped } = deduplicateMcpServers(servers, managed);
    if (skipped.length > 0) {
      this.diagnostics.info("skipped MCP servers Kiro already manages", { skipped });
    }
    return { ...params, mcpServers: forward };
  }

  /** Reports MCP startup failures into the thread once a session is running. */
  private scheduleMcpStatusCheck(session: BridgeSession): void {
    setTimeout(() => {
      void (async () => {
        try {
          const status = await this.kiro?.mcpStartupStatus(session.sessionId);
          if (!status) return;
          this.diagnostics.info("mcp startup status", {
            allStarted: status.allStarted,
            failed: status.failed.length,
            pending: status.pending.length,
          });
          const notice = formatMcpStatus(status);
          if (notice) await this.notifyAgentMessage(session.sessionId, notice);
        } catch {
          /* non-fatal */
        }
      })();
    }, 1500);
  }

  /**
   * Translates a Kiro MCP OAuth request into an ACP URL elicitation.
   *
   * The client opens the URL and prompts the user; the bridge never opens a
   * browser itself and never sees a token.
   */
  private async handleOauthRequest(params: unknown): Promise<void> {
    const parsed = kiroMcpOauthRequestSchema.safeParse(params);
    if (!parsed.success) return;
    const sessionId = parsed.data.sessionId ?? this.sessions.all()[0]?.sessionId;
    if (!sessionId) return;

    const url = oauthUrlOf(parsed.data);
    const elicitation = buildOauthElicitation(
      sessionId,
      parsed.data.serverName,
      url,
      String(++this.elicitationCounter),
    );
    if (!elicitation) {
      this.diagnostics.warn("MCP OAuth request had no usable https URL");
      return;
    }

    // Deliberately not logging the URL: an authorisation URL can embed
    // client identifiers and PKCE challenges.
    this.diagnostics.info("forwarding MCP OAuth request as URL elicitation", {
      server: parsed.data.serverName,
    });

    const supportsUrlElicitation = this.clientCapabilities?.elicitation?.url !== undefined;
    if (!supportsUrlElicitation) {
      // Degrade rather than fail: give the user the link in the thread.
      await this.notifyAgentMessage(
        sessionId,
        `**${parsed.data.serverName ?? "An MCP server"}** needs authorisation. Open this URL to sign in:\n\n${url}`,
      );
      return;
    }

    try {
      await this.client.request("elicitation/create", elicitation);
    } catch (err) {
      this.diagnostics.warn("URL elicitation failed", { message: (err as Error).message });
      await this.notifyAgentMessage(
        sessionId,
        `**${parsed.data.serverName ?? "An MCP server"}** needs authorisation: ${url}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  /**
   * Reads real token counts and publishes an ACP `usage_update`.
   *
   * Kiro's `_kiro.dev/metadata` notification carries only a percentage, and the
   * brief forbids inferring counts from it. `/context` reports genuine per-bucket
   * token counts, so those are summed instead.
   */
  private async refreshUsage(session: BridgeSession): Promise<void> {
    if (!this.zed) return;
    const kiro = this.kiro;
    if (!kiro || session.detached || this.dialect !== "v2") return;

    const generation = session.currentGeneration();
    let contextData;
    try {
      contextData = await kiro.contextBreakdown(session.sessionId);
    } catch {
      return;
    }
    // Discard if the session moved on while we were awaiting.
    if (!session.isCurrent(generation)) return;

    const usage = contextUsageFrom(contextData);
    if (usage) {
      session.usedTokens = usage.usedTokens;
      const implied = impliedContextWindow(usage);
      const declared = session.activeContextWindow();
      // A large divergence means Kiro's two surfaces disagree; worth logging
      // rather than silently trusting the sum.
      if (implied && declared && Math.abs(implied - declared) / declared > 0.15) {
        this.diagnostics.warn("context token sum disagrees with Kiro's percentage", {
          summedTokens: usage.usedTokens,
          impliedWindow: implied,
          declaredWindow: declared,
        });
      }
    }

    const update = buildUsageUpdate(contextData, session.activeContextWindow());
    if (!update) {
      this.diagnostics.debug("no usage_update emitted (missing tokens or window)", {
        haveBuckets: usage !== undefined,
        window: session.activeContextWindow(),
      });
      return;
    }

    await this.client.notify("session/update", {
      sessionId: session.sessionId as schema.SessionId,
      update: { sessionUpdate: "usage_update", ...update },
    });
    this.diagnostics.debug("pushed usage_update", { used: update.used, size: update.size });
  }

  private scheduleUsageRefresh(session: BridgeSession): void {
    setTimeout(() => {
      void this.refreshUsage(session).catch(() => {});
    }, 1200);
  }

  /**
   * Answers `/usage` with Kiro's plan and credit standing.
   *
   * Credits are reported as text with their unit named, because ACP has no field
   * for an abstract balance and `Cost` requires an ISO currency. A monetary cost
   * is attached to the usage update only when Kiro reports real overage charges.
   */
  private async reportUsage(session: BridgeSession): Promise<void> {
    const kiro = await this.ensureKiro();
    const usageData = await kiro.usage(session.sessionId);
    const contextData = await kiro.contextBreakdown(session.sessionId);

    const parts: string[] = [];
    const credits = formatCreditSummary(usageData);
    if (credits) parts.push(credits);

    const ctx = contextUsageFrom(contextData);
    const window = session.activeContextWindow();
    if (ctx && window) {
      const pct = Math.round((ctx.usedTokens / window) * 1000) / 10;
      parts.push(
        `**Context:** ${ctx.usedTokens.toLocaleString("en-US")} / ${window.toLocaleString("en-US")} tokens (${pct}%)`,
      );
      const detail = ctx.buckets
        .filter((b) => b.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens)
        .map((b) => `- ${b.name}: ${b.tokens.toLocaleString("en-US")}`)
        .join("\n");
      if (detail) parts.push(detail);
    }

    if (parts.length === 0) {
      parts.push("Kiro reported no usage information for this session.");
    }

    await this.notifyAgentMessage(session.sessionId, parts.join("\n\n"));

    // Publish the machine-readable figures too, so Zed's context ring updates.
    const update = buildUsageUpdate(contextData, window, usageData);
    if (update) {
      await this.client.notify("session/update", {
        sessionId: session.sessionId as schema.SessionId,
        update: { sessionUpdate: "usage_update", ...update },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Session listing
  // -------------------------------------------------------------------------

  /**
   * Implements the standard `session/list` on top of `_kiro.dev/session/list`.
   *
   * Kiro reports `sessionCapabilities: {}` — advertising no session methods — yet
   * its own extension works. The bridge therefore provides the standard method so
   * Zed's thread-history import can see Kiro sessions. Kiro remains the sole store;
   * nothing is duplicated here.
   */
  private async handleSessionList(
    params: schema.ListSessionsRequest,
  ): Promise<schema.ListSessionsResponse> {
    this.diagnostics.trace("zed->bridge", { method: "session/list", params });
    const kiro = await this.ensureKiro();

    if (this.dialect === "v3") {
      let res: schema.ListSessionsResponse;
      try {
        res = await kiro.listSessions(params ?? {});
      } catch (err) {
        this.rethrowKiroError(err, "session/list");
      }
      const sessions = (res.sessions ?? []).map((s) => {
        const { _meta: _ignored, ...rest } = s as schema.SessionInfo & { _meta?: unknown };
        return rest as schema.SessionInfo;
      });
      return { sessions, ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}) };
    }

    let listed;
    try {
      listed = await kiro.sessionList();
    } catch (err) {
      this.rethrowKiroError(err, "session/list");
    }

    const cwdFilter = params?.cwd;
    const sessions: schema.SessionInfo[] = [];
    for (const s of listed.sessions) {
      // ACP requires a cwd on every entry, and Zed skips entries without one.
      if (!s.cwd) continue;
      if (cwdFilter && s.cwd !== cwdFilter) continue;
      sessions.push({
        sessionId: s.sessionId as schema.SessionId,
        cwd: s.cwd,
        ...(s.title ? { title: s.title } : {}),
        ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
      });
    }

    this.diagnostics.info("session/list", {
      returned: sessions.length,
      total: listed.sessions.length,
      cwdFilter,
    });
    return { sessions };
  }

  // -------------------------------------------------------------------------
  // Slash commands
  // -------------------------------------------------------------------------

  /**
   * Publishes the command catalogue after the current turn of the event loop.
   *
   * Deferred deliberately: `available_commands_update` must arrive *after* the
   * `session/new` response, or the client may not yet have a session to attach it
   * to.
   */
  private scheduleCommandPublish(session: BridgeSession): void {
    setTimeout(() => {
      void this.publishCommands(session).catch((err) =>
        this.diagnostics.warn("failed to publish commands", { message: (err as Error).message }),
      );
    }, 0);
  }

  /** Sends the merged Kiro-command + skill catalogue to Zed. */
  private async publishCommands(session: BridgeSession): Promise<void> {
    if (!this.zed) return;
    if (this.dialect === "v3") {
      await this.v3.publishCommands(session, true);
      return;
    }
    const skills = this.skillsFor(session);
    const availableCommands = buildAvailableCommands(session.kiroCommands, skills);
    if (availableCommands.length === 0) return;

    await this.client.notify("session/update", {
      sessionId: session.sessionId as schema.SessionId,
      update: { sessionUpdate: "available_commands_update", availableCommands },
    });
    this.diagnostics.info("published available commands", {
      kiroCommands: session.kiroCommands.length,
      skills: skills.length,
      total: availableCommands.length,
    });
  }

  /**
   * Discovers skills for a session's workspace.
   *
   * Re-read on each publish rather than cached, so a skill added or removed
   * mid-session is picked up the next time the catalogue is republished.
   */
  private skillsFor(session: BridgeSession): DiscoveredSkill[] {
    return discoverSkills(session.cwd, {
      onWarning: (message, detail) => this.diagnostics.warn(message, detail),
    });
  }

  /**
   * Runs a state-changing command through Kiro's command API.
   *
   * Returns true when the command was handled here, meaning the prompt must not
   * also be forwarded to the model.
   */
  private async interceptCommand(
    session: BridgeSession,
    parsed: ParsedCommand,
  ): Promise<boolean> {
    const plan = planCommand(parsed);
    if (plan.kind === "forward") return false;

    const kiro = await this.ensureKiro();
    this.diagnostics.info("intercepting state-changing command", {
      command: plan.command,
      variant: plan.variant,
    });

    const modelBefore = session.models.currentModelId;
    const previousEffort = { current: session.effort.current, confirmed: session.effort.confirmed };
    const result = await kiro.execute(session.sessionId, plan.variant, plan.args);

    // Report Kiro's own wording back to the user rather than inventing our own.
    const message = result.message?.trim();
    if (result.success === false) {
      await this.notifyAgentMessage(
        session.sessionId,
        message ? `**${message}**` : `Command \`/${plan.command}\` failed.`,
      );
    } else if (message) {
      await this.notifyAgentMessage(session.sessionId, message);
    }

    // Kiro announces nothing when model/agent/effort changes, so we must
    // reconstruct the state ourselves and tell Zed. Without this the selectors go
    // stale — the exact failure mode the brief calls out.
    session.bumpGeneration();

    // The command's own `data` block is authoritative. The `[active]` marker in
    // commands/options lags a change (reproduced with /plan), so a list refresh
    // alone would read back the previous value.
    const authoritative = stateFromCommandResult(result.data);

    // Refresh the option *lists* so newly available choices appear...
    await Promise.all([
      refreshModels(kiro, session).catch(() => undefined),
      refreshAgents(kiro, session).catch(() => undefined),
    ]);
    // ...then re-assert the authoritative current values over anything the
    // possibly-stale markers set.
    if (authoritative.modelId) session.models.currentModelId = authoritative.modelId;
    if (authoritative.agentId) session.agents.currentAgentId = authoritative.agentId;
    if (authoritative.contextUsagePercentage !== undefined) {
      session.contextUsagePercentage = authoritative.contextUsagePercentage;
    }

    // Effort depends on the now-current model, so it is read last. A model
    // change resets Kiro's effort, so a level the user chose is re-applied.
    const modelAfter = session.models.currentModelId;
    let effortNotice: string | undefined;
    if (modelAfter && modelAfter !== modelBefore) {
      effortNotice = await reconcileEffortAfterModelChange(kiro, session, previousEffort, modelAfter).catch(
        () => undefined,
      );
    } else {
      await refreshEffort(kiro, session).catch(() => undefined);
    }
    if (plan.variant === "effort" && typeof plan.args.level === "string") {
      // /effort returns no data block; the requested level is authoritative when
      // Kiro reported success.
      if (result.success !== false && session.effort.available.includes(plan.args.level)) {
        session.effort.current = plan.args.level;
        session.effort.confirmed = true;
      }
    }
    if (effortNotice) await this.notifyAgentMessage(session.sessionId, effortNotice);

    await this.pushConfigOptions(session);

    this.diagnostics.info("command changed state", {
      command: plan.command,
      model: session.models.currentModelId,
      agent: session.agents.currentAgentId,
      effort: session.effort.current,
    });

    return true;
  }

  // -------------------------------------------------------------------------
  // Config options
  // -------------------------------------------------------------------------

  /**
   * Applies a config change from Zed and echoes the full option set back.
   *
   * ACP requires the response to carry the complete `configOptions` array, and
   * Zed replaces its local state wholesale from it — so a partial reply would
   * silently drop selectors.
   */
  private async handleSetConfigOption(
    params: schema.SetSessionConfigOptionRequest,
  ): Promise<schema.SetSessionConfigOptionResponse> {
    this.diagnostics.trace("zed->bridge", { method: "session/set_config_option", params });
    const kiro = await this.ensureKiro();
    const session = this.requireSession(params.sessionId);
    await this.ensureAttached(session);

    if (this.dialect === "v3") {
      const rawValue = (params as unknown as Record<string, unknown>).value;
      if (typeof rawValue !== "string" && typeof rawValue !== "boolean") {
        throw RequestError.invalidParams({ configId: params.configId }, "A config option value must be a string or boolean.");
      }
      try {
        const result = await this.v3.setOption(session, params.configId, rawValue);
        if (result.notice) await this.notifyAgentMessage(session.sessionId, result.notice).catch(() => {});
        await this.v3.publishCommands(session).catch(() => {});
        this.diagnostics.info("config option applied", { configId: params.configId, value: rawValue, changed: result.changed });
      } catch (err) {
        if (err instanceof UnknownConfigOptionError) {
          throw RequestError.invalidParams({ configId: params.configId }, err.message);
        }
        if (err instanceof InvalidConfigValueError) {
          throw RequestError.invalidParams({ configId: params.configId, value: rawValue }, err.message);
        }
        this.rethrowKiroError(err, "session/set_config_option");
      }
      return { configOptions: this.v3.configOptions(session) };
    }

    // ACP allows either a bare value id or a tagged boolean payload. All of our
    // options are selects, so a string is expected.
    const raw = params as unknown as Record<string, unknown>;
    const value = typeof raw.value === "string" ? raw.value : undefined;
    if (value === undefined) {
      throw RequestError.invalidParams(
        { configId: params.configId },
        "This bridge only exposes select-type config options, which require a string value.",
      );
    }

    try {
      const result = await applyConfigOption(kiro, session, params.configId, value);
      if (result.notice) {
        // Effort was invalidated by a model switch. Say so in the thread rather
        // than changing the value silently.
        await this.notifyAgentMessage(session.sessionId, result.notice).catch(() => {});
      }
      this.diagnostics.info("config option applied", {
        configId: params.configId,
        value,
        changed: result.changed,
        model: session.models.currentModelId,
        effort: session.effort.current,
        agent: session.agents.currentAgentId,
      });
    } catch (err) {
      if (err instanceof UnknownConfigOptionError) {
        throw RequestError.invalidParams({ configId: params.configId }, err.message);
      }
      if (err instanceof InvalidConfigValueError) {
        throw RequestError.invalidParams({ configId: params.configId, value }, err.message);
      }
      this.rethrowKiroError(err, "session/set_config_option");
    }

    const configOptions = buildConfigOptions(session);
    this.diagnostics.trace("bridge->zed", {
      method: "session/set_config_option:response",
      params: { configOptions },
    });
    return { configOptions };
  }

  /**
   * Legacy mode selection, kept for clients that have not adopted config options.
   *
   * Routed through the same code path as the `agent` config option so the two
   * cannot diverge.
   */
  private async handleSetMode(
    params: schema.SetSessionModeRequest,
  ): Promise<schema.SetSessionModeResponse> {
    this.diagnostics.trace("zed->bridge", { method: "session/set_mode", params });
    const kiro = await this.ensureKiro();
    const session = this.requireSession(params.sessionId);
    await this.ensureAttached(session);
    try {
      if (this.dialect === "v3") await this.v3.setOption(session, "agent", params.modeId);
      else await applyConfigOption(kiro, session, "agent", params.modeId);
    } catch (err) {
      if (err instanceof InvalidConfigValueError) {
        throw RequestError.invalidParams({ modeId: params.modeId }, err.message);
      }
      throw err;
    }
    await this.pushConfigOptions(session);
    return {};
  }

  /**
   * Pushes the current config state to Zed.
   *
   * Used whenever state changes outside a `set_config_option` call — for example
   * when a slash command alters the model. This is what keeps Zed's selectors
   * from going stale, which matters because Kiro emits no notification of its own
   * when the model or agent changes.
   */
  private async pushConfigOptions(session: BridgeSession): Promise<void> {
    if (!this.zed) return;
    if (this.dialect === "v3") {
      await this.v3.pushConfigOptions(session);
      return;
    }
    const configOptions = buildConfigOptions(session);
    if (configOptions.length === 0) return;
    await this.sendUpdate(session, { sessionUpdate: "config_option_update", configOptions } as schema.SessionUpdate);
    this.diagnostics.debug("pushed config_option_update", {
      model: session.models.currentModelId,
      effort: session.effort.current,
      agent: session.agents.currentAgentId,
    });
  }

  private requireSession(sessionId: string): BridgeSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams({ sessionId }, `Unknown session '${sessionId}'.`);
    }
    return session;
  }

  /**
   * Rethrows a Kiro failure, translating credential problems into ACP's
   * `-32000 authentication required`.
   *
   * Applied at every point Kiro can fail, not just session creation. Tokens
   * commonly expire *during* a session (Kiro issue #10416), and without this a
   * mid-turn expiry surfaces as an opaque internal error rather than prompting
   * the user to sign in.
   */
  private rethrowKiroError(err: unknown, context: string): never {
    if (isAuthError(err)) {
      this.diagnostics.warn("kiro reported an authentication failure", { context });
      throw new RequestError(AUTH_REQUIRED_CODE, "Authentication required", {
        details: authRequiredMessage(),
      });
    }
    // CLI V3 uses -32000 for service failures too (observed: ModelRegistryUnavailableError,
    // ClientNetworkError). In ACP that code means "authentication required", so passing it
    // through would make Zed offer a sign-in for a network blip.
    const e = err as { code?: unknown; message?: unknown; data?: unknown };
    if (e?.code === AUTH_REQUIRED_CODE) {
      this.diagnostics.warn("kiro service error", { context, data: e.data });
      throw RequestError.internalError(e.data, typeof e.message === "string" ? e.message : "Kiro request failed.");
    }
    throw err;
  }

  private async handleLoadSession(
    params: schema.LoadSessionRequest,
  ): Promise<schema.LoadSessionResponse> {
    this.diagnostics.trace("zed->bridge", { method: "session/load", params });
    const kiro = await this.ensureKiro();
    const request = await this.dedupeMcp(params);

    // Zed chose this id, so it already knows the session: updates replayed
    // during the load can flow immediately, and the session must exist first so
    // they are routed and translated.
    const session = this.sessions.get(params.sessionId) ?? this.sessions.create(params.sessionId, params.cwd);
    session.announced = true;
    session.detached = false;
    session.mcpServers = request.mcpServers ?? [];

    if (this.dialect === "v3") {
      session.v3 ??= initialV3State();
      const seq = this.v3.seq(session);
      let res;
      try {
        res = await kiro.v3LoadSession(request);
      } catch (err) {
        this.sessions.delete(params.sessionId);
        this.rethrowKiroError(err, "session/load");
      }
      this.v3.adoptNative(session, res.configOptions, seq);
      setTimeout(() => void this.v3.publishCommands(session, true).catch(() => {}), 0);
      const configOptions = this.v3.configOptions(session);
      const modes = this.v3.modeState(session);
      return {
        ...(configOptions.length > 0 ? { configOptions } : {}),
        ...(modes ? { modes } : {}),
      };
    }

    let loaded;
    try {
      loaded = await kiro.loadSession(request);
    } catch (err) {
      this.sessions.delete(params.sessionId);
      this.rethrowKiroError(err, "session/load");
    }
    if (loaded?.models) {
      session.models.currentModelId = loaded.models.currentModelId;
      session.models.availableModels = loaded.models.availableModels;
    }
    if (loaded?.modes) {
      session.agents.currentAgentId = loaded.modes.currentModeId;
      session.agents.availableAgents = loaded.modes.availableModes;
    }

    await refreshAll(kiro, session);
    const configOptions = buildConfigOptions(session);
    const modes = buildModeState(session);
    return {
      ...(configOptions.length > 0 ? { configOptions } : {}),
      ...(modes ? { modes } : {}),
    };
  }

  /**
   * `session/close`: the client is done with a thread.
   *
   * Forwarded on V3 so Kiro can unload it; on v2 there is no Kiro method, so the
   * bridge only frees its own state. Never fails the client over Kiro's answer.
   */
  private async handleCloseSession(params: schema.CloseSessionRequest): Promise<schema.CloseSessionResponse> {
    this.diagnostics.trace("zed->bridge", { method: "session/close", params });
    const session = this.sessions.get(params.sessionId);
    if (this.dialect === "v3" && this.kiro && !session?.detached) {
      await this.kiro.closeSession(params.sessionId).catch((err) =>
        this.diagnostics.debug("kiro session/close failed", { message: (err as Error).message }),
      );
    }
    this.sessions.delete(params.sessionId);
    this.inflight.delete(params.sessionId);
    return {};
  }

  /** `session/delete`: advertised only on V3, which implements it natively. */
  private async handleDeleteSession(params: schema.DeleteSessionRequest): Promise<schema.DeleteSessionResponse> {
    this.diagnostics.trace("zed->bridge", { method: "session/delete", params });
    if (this.dialect !== "v3") throw RequestError.methodNotFound("session/delete");
    const kiro = await this.ensureKiro();
    try {
      await kiro.deleteSession(params.sessionId);
    } catch (err) {
      this.rethrowKiroError(err, "session/delete");
    }
    this.sessions.delete(params.sessionId);
    return {};
  }

  // -------------------------------------------------------------------------
  // Prompt / cancel
  // -------------------------------------------------------------------------

  private async handlePrompt(params: schema.PromptRequest): Promise<schema.PromptResponse> {
    this.diagnostics.trace("zed->bridge", { method: "session/prompt", params });
    const session = this.sessions.get(params.sessionId);
    if (session) {
      this.lastActiveSessionId = session.sessionId;
      if (session.pendingNotice) {
        const notice = session.pendingNotice;
        session.pendingNotice = undefined;
        await this.notifyAgentMessage(session.sessionId, `${notice}\n\n`).catch(() => {});
      }
      const parsed = commandFromPrompt(params.prompt);

      // Handled before anything touches Kiro: the point is to replace it.
      if (parsed?.name === RESTART_COMMAND) {
        try {
          await this.restartKiro(session);
        } catch (err) {
          await this.notifyAgentMessage(
            session.sessionId,
            `**Kiro could not be restarted:** ${(err as Error).message}`,
          ).catch(() => {});
        }
        return { stopReason: "end_turn" };
      }

      await this.ensureAttached(session);
      if (parsed && this.dialect === "v3") {
        const outcome = await this.interceptV3(session, parsed);
        if (outcome.kind === "handled") return { stopReason: "end_turn" };
        if (outcome.kind === "prompt") params = { ...params, prompt: [{ type: "text", text: outcome.text }] };
      }
    }

    let kiro: KiroConnection;
    try {
      kiro = await this.ensureKiro();
    } catch (err) {
      this.rethrowKiroError(err, "session/prompt");
    }

    // A slash command that mutates selector state is executed through Kiro's
    // command API instead of being sent to the model. Everything else — including
    // Kiro's informational commands and skills — is forwarded verbatim, because
    // Kiro's own prompt handler already interprets them.
    if (session && this.dialect === "v2") {
      const parsed = commandFromPrompt(params.prompt);
      if (parsed) {
        // `/usage` is rendered by the bridge rather than forwarded: Kiro's own
        // reply is a terse one-liner ("Plan: … | 1 usage breakdowns"), while the
        // structured data behind it supports a genuinely useful summary. Credits
        // are reported here as named credits, never as ACP monetary cost.
        if (parsed.name === "usage" && parsed.args === "") {
          try {
            await this.reportUsage(session);
            return { stopReason: "end_turn" };
          } catch (err) {
            this.diagnostics.warn("usage report failed; forwarding to Kiro", {
              message: (err as Error).message,
            });
          }
        }
        try {
          if (await this.interceptCommand(session, parsed)) {
            return { stopReason: "end_turn" };
          }
        } catch (err) {
          // A failed interception must not lose the user's input; fall through
          // and let Kiro's prompt path handle the text.
          this.diagnostics.warn("command interception failed; forwarding as prompt", {
            command: parsed.name,
            message: (err as Error).message,
          });
        }
      }
    }

    let response: schema.PromptResponse;
    this.inflight.set(params.sessionId, (this.inflight.get(params.sessionId) ?? 0) + 1);
    try {
      response = await kiro.prompt(params);
    } catch (err) {
      this.rethrowKiroError(err, "session/prompt");
    } finally {
      const n = (this.inflight.get(params.sessionId) ?? 1) - 1;
      if (n > 0) this.inflight.set(params.sessionId, n);
      else this.inflight.delete(params.sessionId);
    }
    this.diagnostics.trace("bridge->zed", { method: "session/prompt:response", params: response });

    // Context grows with every turn, so refresh the usage figures afterwards.
    // (V3 reports context usage itself, as `session_info_update`.)
    if (session && this.dialect === "v2") this.scheduleUsageRefresh(session);
    this.maybeCheckModels();

    return response;
  }

  /**
   * Runs a slash command on V3.
   *
   * A failure is reported in the thread and never falls through to the model:
   * on V3 an uninterpreted `/model x` would reach the LLM as prose.
   */
  private async interceptV3(
    session: BridgeSession,
    parsed: ParsedCommand,
  ): Promise<{ kind: "handled" } | { kind: "forward" } | { kind: "prompt"; text: string }> {
    try {
      return await this.v3.intercept(session, parsed);
    } catch (err) {
      if (isAuthError(err)) this.rethrowKiroError(err, "command");
      this.diagnostics.warn("v3 command failed", { command: parsed.name, message: (err as Error).message });
      await this.notifyAgentMessage(session.sessionId, `**\`/${parsed.name}\` failed:** ${(err as Error).message}`);
      return { kind: "handled" };
    }
  }

  private async handleCancel(params: schema.CancelNotification): Promise<void> {
    this.diagnostics.trace("zed->bridge", { method: "session/cancel", params });
    const kiro = this.kiro;
    if (!kiro) return;
    await kiro.cancel(params.sessionId);
  }

  // -------------------------------------------------------------------------
  // Kiro -> Zed
  // -------------------------------------------------------------------------

  /**
   * Forwards a `session/update`, correcting Kiro's path defects on the way.
   *
   * Streaming is forwarded immediately with no buffering, so the bridge adds no
   * perceptible latency to token output.
   */
  private async forwardSessionUpdate(params: schema.SessionNotification): Promise<void> {
    const update = params.update as unknown as Record<string, unknown>;
    const kind = update?.sessionUpdate;
    const session = this.sessions.get(params.sessionId);

    // The bridge is re-attaching this session: Zed already shows the transcript.
    if (session?.suppressReplay && typeof kind === "string" && TRANSCRIPT_UPDATE_KINDS.has(kind)) return;

    if (this.dialect === "v3") {
      if (!session) {
        if (this.pendingSessionCreations > 0 && typeof kind === "string" && !TRANSCRIPT_UPDATE_KINDS.has(kind)) {
          const list = this.unclaimed.get(params.sessionId) ?? [];
          if (list.length < 100) list.push({ kind: "update", update });
          this.unclaimed.set(params.sessionId, list);
          return;
        }
      } else if (await this.v3.onSessionUpdate(session, update)) {
        return;
      }
    }

    let outbound = params;
    if (kind === "tool_call" || kind === "tool_call_update") {
      const ctx = this.pathContext(params.sessionId);
      const fixed = normalizeToolCallPaths(update, ctx);
      if (fixed !== update) {
        outbound = { ...params, update: fixed as unknown as schema.SessionUpdate };
      }
    }

    this.diagnostics.trace("bridge->zed", { method: "session/update", params: outbound });
    await this.client.notify("session/update", outbound);
  }

  /**
   * Forwards a permission request to Zed.
   *
   * Kiro's permission decisions stay Kiro's: the bridge never auto-approves, and
   * never adds options Kiro did not offer. Zed renders the choice; Kiro enforces
   * it. Paths inside the embedded tool call are corrected so the user is shown
   * the file that will actually be touched — a correctness issue for an approval
   * prompt, not merely cosmetic.
   */
  private async forwardPermission(
    params: schema.RequestPermissionRequest,
  ): Promise<schema.RequestPermissionResponse> {
    const ctx = this.pathContext(params.sessionId);
    const toolCall = params.toolCall as unknown as Record<string, unknown>;
    const fixed = normalizeToolCallPaths(toolCall, ctx);
    const outbound =
      fixed === toolCall
        ? params
        : { ...params, toolCall: fixed as unknown as schema.ToolCallUpdate };

    this.diagnostics.trace("bridge->zed", { method: "session/request_permission", params: outbound });
    const result = await this.client.request("session/request_permission", outbound);
    this.diagnostics.trace("zed->bridge", {
      method: "session/request_permission:response",
      params: result,
    });
    return result;
  }

  /** Handles a `_kiro.dev/*` notification. */
  private onKiroExtension(method: string, params: unknown): void {
    switch (method) {
      case KIRO_METHODS.commandsAvailable: {
        const parsed = kiroCommandsAvailableSchema.safeParse(params);
        if (!parsed.success) return;
        const session = parsed.data.sessionId ? this.sessions.get(parsed.data.sessionId) : undefined;
        if (!session) return;
        session.kiroCommands = parsed.data.commands;
        this.diagnostics.debug("kiro commands available", { count: parsed.data.commands.length });
        // Kiro may re-send this at any time (e.g. after an agent switch changes
        // the available set), so republish rather than only seeding.
        void this.publishCommands(session).catch(() => {});
        return;
      }
      case KIRO_METHODS.metadata: {
        const parsed = kiroMetadataSchema.safeParse(params);
        if (!parsed.success) return;
        const session = parsed.data.sessionId ? this.sessions.get(parsed.data.sessionId) : undefined;
        if (session && parsed.data.contextUsagePercentage !== undefined) {
          session.contextUsagePercentage = parsed.data.contextUsagePercentage;
        }
        return;
      }
      case KIRO_METHODS.mcpOauthRequest: {
        void this.handleOauthRequest(params).catch((err) =>
          this.diagnostics.warn("failed to handle MCP OAuth request", {
            message: (err as Error).message,
          }),
        );
        return;
      }
      case KIRO_METHODS.mcpServerInitialized: {
        this.diagnostics.info("mcp server initialized", params);
        return;
      }
      case KIRO_METHODS.mcpServerInitFailure: {
        this.diagnostics.warn("mcp server failed to initialize", params);
        return;
      }
      case KIRO_V3_METHODS.mcpStatus: {
        const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId;
        const session = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
        if (!session) {
          if (typeof sessionId === "string" && this.pendingSessionCreations > 0) {
            const list = this.unclaimed.get(sessionId) ?? [];
            list.push({ kind: "mcp", params });
            this.unclaimed.set(sessionId, list);
          }
          return;
        }
        void this.v3.onMcpStatus(session, params).catch((err) =>
          this.diagnostics.warn("failed to handle MCP status", { message: (err as Error).message }),
        );
        return;
      }
      case KIRO_METHODS.rateLimit:
      case KIRO_V3_METHODS.rateLimit:
      case KIRO_V3_METHODS.customAgentNotFound:
      case KIRO_V3_METHODS.customAgentConfigError: {
        // Kiro also reports these in the turn itself, so a notice would duplicate.
        this.diagnostics.warn("kiro reported a problem", { method, params });
        return;
      }
      default:
        // Unknown Kiro extensions are logged, never dropped silently, so a new
        // Kiro release is visible in diagnostics without breaking the bridge.
        this.diagnostics.debug("unhandled kiro extension notification", { method });
        return;
    }
  }

  /** Emits a plain agent message into a session, used for bridge-level notices. */
  private async notifyAgentMessage(sessionId: string, text: string): Promise<void> {
    if (!this.zed) return;
    const update = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    } as schema.SessionUpdate;
    const session = this.sessions.get(sessionId);
    if (session) {
      await this.sendUpdate(session, update);
      return;
    }
    await this.client.notify("session/update", { sessionId: sessionId as schema.SessionId, update });
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.diagnostics.info("bridge shutting down");
    await this.kiro?.shutdown();
    this.diagnostics.close();
  }
}

/**
 * The bridge's own version, read from `package.json` at runtime.
 *
 * Previously this was a hardcoded constant with a comment claiming the release
 * process kept it in sync. No such step existed, and 0.1.1 duly shipped reporting
 * itself as 0.1.0. Since this value reaches the client as `agentInfo.version` and
 * appears in ACP logs, a stale number makes bug reports actively misleading — so
 * it is now derived rather than maintained.
 *
 * `dist/bridge/bridge.js` sits two levels below the package root, which holds for
 * both the published layout and a local build. A hardcoded fallback keeps the
 * bridge working if that ever stops being true, rather than failing to start over
 * a cosmetic value.
 */
function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
    /* fall through */
  }
  return "0.0.0-unknown";
}

export const BRIDGE_VERSION = readVersion();

/**
 * ACP's "authentication required" error code.
 *
 * Clients use this specific code to decide when to present the auth methods
 * advertised in `initialize`.
 */
const AUTH_REQUIRED_CODE = -32000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/** Rejects with `message` if `promise` has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Zed's capabilities, plus what the bridge itself handles for Kiro.
 *
 * `_meta.kiro.openExternalUrl` opts in to CLI V3's `_kiro/openExternalUrl`, which
 * the bridge turns into a URL elicitation. The v2 engine ignores the key.
 */
function southboundCapabilities(zed: schema.ClientCapabilities | undefined): schema.ClientCapabilities {
  const base = zed ?? {};
  const meta = (base._meta ?? {}) as Record<string, unknown>;
  const kiro = (meta.kiro ?? {}) as Record<string, unknown>;
  return { ...base, _meta: { ...meta, kiro: { ...kiro, openExternalUrl: true } } };
}
