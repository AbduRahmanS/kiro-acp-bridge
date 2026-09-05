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
import type { Diagnostics } from "../diagnostics/logging.js";
import { KiroConnection } from "../kiro/connection.js";
import { KiroNotFoundError } from "../kiro/discovery.js";
import {
  KIRO_METHODS,
  kiroCommandsAvailableSchema,
  kiroMcpOauthRequestSchema,
  kiroMetadataSchema,
  oauthUrlOf,
  stateFromCommandResult,
} from "../kiro/protocol.js";
import { normalizeToolCallPaths, type PathContext } from "./paths.js";
import {
  applyConfigOption,
  buildConfigOptions,
  buildModeState,
  InvalidConfigValueError,
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
  type ParsedCommand,
} from "./commands.js";
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
  /** Agent engine override. Defaults to v2 (see kiro/process.ts). */
  agentEngine?: string | undefined;
  /** Working directory for the Kiro child. Defaults to the bridge's own cwd. */
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export class KiroBridge {
  private readonly diagnostics: Diagnostics;
  private readonly options: BridgeOptions;
  private readonly sessions = new SessionRegistry();
  private readonly kiroProcessCwd: string;

  private kiro: KiroConnection | undefined;
  private zed: AgentConnection | undefined;
  /** Capabilities Zed advertised, needed to decide what we may call back. */
  private clientCapabilities: schema.ClientCapabilities | undefined;
  private shuttingDown = false;
  /** Monotonic counter for elicitation ids, so each OAuth prompt is distinct. */
  private elicitationCounter = 0;
  /** Ensures the "Kiro not found" guidance is printed once, not per request. */
  private reportedMissingKiro = false;

  constructor(options: BridgeOptions) {
    this.options = options;
    this.diagnostics = options.diagnostics;
    this.kiroProcessCwd = options.cwd ?? process.cwd();
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
      .onNotification("session/cancel", async (ctx) => await this.handleCancel(ctx.params));

    this.zed = app.connect(stream);
    this.diagnostics.info("bridge listening on stdio");

    await this.zed.closed;
    this.diagnostics.info("northbound connection closed");
    await this.shutdown();
  }

  /** Spawns Kiro and wires its client-side callbacks back toward Zed. */
  private async ensureKiro(): Promise<KiroConnection> {
    if (this.kiro) return this.kiro;

    try {
      this.kiro = await KiroConnection.spawn({
        diagnostics: this.diagnostics,
        executablePath: this.options.kiroPath,
        agentEngine: this.options.agentEngine,
        cwd: this.kiroProcessCwd,
        env: this.options.env ?? process.env,
        onUnexpectedExit: (info) => this.onKiroDied(info),
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
          extensionNotification: (method, params) => this.onKiroExtension(method, params),
        },
      });
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

    return this.kiro;
  }

  private onKiroDied(info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }): void {
    if (this.shuttingDown) return;
    this.diagnostics.error("kiro-cli exited unexpectedly", {
      code: info.code,
      signal: info.signal,
    });
    // Surface it in the thread so the failure is visible in Zed, not just in logs.
    for (const session of this.sessions.all()) {
      void this.notifyAgentMessage(
        session.sessionId,
        `**Kiro CLI stopped unexpectedly** (exit code ${info.code ?? "none"}${info.signal ? `, signal ${info.signal}` : ""}).\n\n` +
          "The bridge cannot continue this session. Start a new thread to reconnect.\n" +
          (info.stderrTail ? `\nLast output from Kiro:\n\`\`\`\n${info.stderrTail}\n\`\`\`` : ""),
      ).catch(() => {});
    }
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
      const kiro = await this.ensureKiro();
      kiroInit = await kiro.initialize({
        protocolVersion: 1,
        clientCapabilities: params.clientCapabilities,
        clientInfo: {
          name: "kiro-acp-bridge",
          title: "Kiro ACP Bridge",
          version: BRIDGE_VERSION,
        },
      });
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

    if (kiroInit.protocolVersion < 1) {
      throw RequestError.internalError(
        { kiroProtocolVersion: kiroInit.protocolVersion },
        `Kiro advertised unsupported ACP protocol version ${kiroInit.protocolVersion}; the bridge requires version 1 or later.`,
      );
    }

    const kiroCaps = kiroInit.agentCapabilities ?? {};

    // Northbound: report what the *bridge* supports. Prompt and MCP capabilities
    // are Kiro's, because we cannot manufacture them. Everything the bridge adds
    // on top is declared here.
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
        // Kiro reports an empty sessionCapabilities even though
        // `_kiro.dev/session/list` works. The bridge implements the standard
        // method on top of it, so it advertises the capability honestly.
        sessionCapabilities: {
          list: {},
        },
      },
      // Kiro advertises its own `kiro-login` method only when authentication is
      // actually required; with a signed-in CLI it returns an empty list. Since
      // the client must decide what to render from one response — and since
      // kiro-cli may be absent entirely — the bridge always offers a terminal
      // method so a sign-in path exists in every state.
      authMethods: buildAuthMethods(kiroInit.authMethods, params.clientCapabilities),
      agentInfo: {
        name: "Kiro",
        title: `Kiro ${kiroInit.agentInfo?.version ?? ""}`.trim(),
        version: BRIDGE_VERSION,
      },
    };

    this.diagnostics.info("northbound initialize complete", {
      kiroVersion: kiroInit.agentInfo?.version,
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
    const kiro = await this.ensureKiro();

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

    return response;
  }

  // -------------------------------------------------------------------------
  // MCP
  // -------------------------------------------------------------------------

  /** Removes MCP servers Kiro already manages, to avoid starting duplicates. */
  private async dedupeMcp(params: schema.NewSessionRequest): Promise<schema.NewSessionRequest> {
    const servers = params.mcpServers ?? [];
    if (servers.length === 0) return params;

    // Kiro's startup status is the only view we have of its own server set. It is
    // per-session, so on the very first session it may be unavailable; forwarding
    // everything is the safe default in that case.
    let managed: string[] = [];
    try {
      const anySession = this.sessions.all()[0];
      if (anySession) {
        const status = await this.kiro?.mcpStartupStatus(anySession.sessionId);
        managed = kiroManagedServerNames(status);
      }
    } catch {
      /* best effort */
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
    if (!kiro) return;

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

    // Effort depends on the now-current model, so it is read last.
    await refreshEffort(kiro, session).catch(() => undefined);
    if (plan.variant === "effort" && typeof plan.args.level === "string") {
      // /effort returns no data block; the requested level is authoritative when
      // Kiro reported success.
      if (result.success !== false && session.effort.available.includes(plan.args.level)) {
        session.effort.current = plan.args.level;
      }
    }

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
    try {
      await applyConfigOption(kiro, session, "agent", params.modeId);
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
    const configOptions = buildConfigOptions(session);
    if (configOptions.length === 0) return;
    await this.client.notify("session/update", {
      sessionId: session.sessionId as schema.SessionId,
      update: { sessionUpdate: "config_option_update", configOptions },
    });
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
    throw err;
  }

  private async handleLoadSession(
    params: schema.LoadSessionRequest,
  ): Promise<schema.LoadSessionResponse> {
    this.diagnostics.trace("zed->bridge", { method: "session/load", params });
    const kiro = await this.ensureKiro();

    const loaded = await kiro.loadSession(params);
    const session = this.sessions.create(params.sessionId, params.cwd);
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

  // -------------------------------------------------------------------------
  // Prompt / cancel
  // -------------------------------------------------------------------------

  private async handlePrompt(params: schema.PromptRequest): Promise<schema.PromptResponse> {
    this.diagnostics.trace("zed->bridge", { method: "session/prompt", params });
    const kiro = await this.ensureKiro();
    const session = this.sessions.get(params.sessionId);

    // A slash command that mutates selector state is executed through Kiro's
    // command API instead of being sent to the model. Everything else — including
    // Kiro's informational commands and skills — is forwarded verbatim, because
    // Kiro's own prompt handler already interprets them.
    if (session) {
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
    try {
      response = await kiro.prompt(params);
    } catch (err) {
      this.rethrowKiroError(err, "session/prompt");
    }
    this.diagnostics.trace("bridge->zed", { method: "session/prompt:response", params: response });

    // Context grows with every turn, so refresh the usage figures afterwards.
    if (session) this.scheduleUsageRefresh(session);

    return response;
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
    await this.client.notify("session/update", {
      sessionId: sessionId as schema.SessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
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

/** Kept in sync with package.json by the release process. */
export const BRIDGE_VERSION = "0.1.0";

/**
 * ACP's "authentication required" error code.
 *
 * Clients use this specific code to decide when to present the auth methods
 * advertised in `initialize`.
 */
const AUTH_REQUIRED_CODE = -32000;
