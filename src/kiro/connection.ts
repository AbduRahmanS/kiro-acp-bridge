/**
 * The southbound half of the bridge: an ACP *client* connection to `kiro-cli acp`.
 *
 * This wraps the child process plus a client-side ACP connection and exposes
 * typed helpers for Kiro's dialect. Callers northbound of here never construct
 * `_kiro.dev/*` payloads by hand.
 */

import { client, ndJsonStream, type ClientConnection, type ClientContext } from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";
import type { Diagnostics } from "../diagnostics/logging.js";
import { KiroProcess, type KiroProcessOptions } from "./process.js";
import {
  KIRO_METHODS,
  buildExecute,
  kiroContextDataSchema,
  kiroExecuteResponseSchema,
  kiroMcpStartupStatusSchema,
  kiroModelListDataSchema,
  kiroNewSessionResponseSchema,
  kiroOptionsResponseSchema,
  kiroSessionListSchema,
  kiroUsageDataSchema,
  type KiroContextData,
  type KiroExecuteResponse,
  type KiroMcpStartupStatus,
  type KiroModelListData,
  type KiroNewSessionResponse,
  type KiroOption,
  type KiroOptionCommand,
  type KiroSessionList,
  type KiroUsageData,
} from "./protocol.js";

/** Handlers the bridge must supply so Kiro's client-side calls reach Zed. */
export interface KiroClientHandlers {
  sessionUpdate(params: schema.SessionNotification): Promise<void> | void;
  requestPermission(params: schema.RequestPermissionRequest): Promise<schema.RequestPermissionResponse>;
  readTextFile(params: schema.ReadTextFileRequest): Promise<schema.ReadTextFileResponse>;
  writeTextFile(params: schema.WriteTextFileRequest): Promise<schema.WriteTextFileResponse>;
  createTerminal?(params: schema.CreateTerminalRequest): Promise<schema.CreateTerminalResponse>;
  terminalOutput?(params: schema.TerminalOutputRequest): Promise<schema.TerminalOutputResponse>;
  releaseTerminal?(params: schema.ReleaseTerminalRequest): Promise<schema.ReleaseTerminalResponse>;
  waitForTerminalExit?(params: schema.WaitForTerminalExitRequest): Promise<schema.WaitForTerminalExitResponse>;
  killTerminal?(params: schema.KillTerminalRequest): Promise<schema.KillTerminalResponse>;
  /** Any `_kiro.dev/*` or other unrecognised notification. */
  extensionNotification(method: string, params: unknown): void;
}

export interface KiroConnectionOptions extends KiroProcessOptions {
  handlers: KiroClientHandlers;
}

export class KiroConnection {
  readonly process: KiroProcess;
  private readonly conn: ClientConnection;
  private readonly diagnostics: Diagnostics;
  private initializeResult: schema.InitializeResponse | undefined;

  private constructor(proc: KiroProcess, conn: ClientConnection, diagnostics: Diagnostics) {
    this.process = proc;
    this.conn = conn;
    this.diagnostics = diagnostics;
  }

  /** Spawns Kiro and establishes the client-side ACP connection. */
  static async spawn(options: KiroConnectionOptions): Promise<KiroConnection> {
    const proc = new KiroProcess(options);
    const { readable, writable } = proc.streams();
    const stream = ndJsonStream(writable, readable);
    const h = options.handlers;
    const diagnostics = options.diagnostics;

    const app = client({ name: "kiro-acp-bridge" })
      .onNotification("session/update", async (ctx) => {
        diagnostics.trace("kiro->bridge", { method: "session/update", params: ctx.params });
        await h.sessionUpdate(ctx.params);
      })
      .onRequest("session/request_permission", async (ctx) => {
        diagnostics.trace("kiro->bridge", { method: "session/request_permission", id: ctx.requestId, params: ctx.params });
        return await h.requestPermission(ctx.params);
      })
      .onRequest("fs/read_text_file", async (ctx) => await h.readTextFile(ctx.params))
      .onRequest("fs/write_text_file", async (ctx) => await h.writeTextFile(ctx.params));

    // Terminal support is optional; only wire it when the northbound client has it.
    if (h.createTerminal) app.onRequest("terminal/create", async (ctx) => await h.createTerminal!(ctx.params));
    if (h.terminalOutput) app.onRequest("terminal/output", async (ctx) => await h.terminalOutput!(ctx.params));
    if (h.releaseTerminal) app.onRequest("terminal/release", async (ctx) => await h.releaseTerminal!(ctx.params));
    if (h.waitForTerminalExit)
      app.onRequest("terminal/wait_for_exit", async (ctx) => await h.waitForTerminalExit!(ctx.params));
    if (h.killTerminal) app.onRequest("terminal/kill", async (ctx) => await h.killTerminal!(ctx.params));

    // Kiro's extension notifications. Registered explicitly so the SDK routes
    // them; unknown ones are still tolerated below.
    const extensionNotifications = [
      KIRO_METHODS.commandsAvailable,
      KIRO_METHODS.metadata,
      KIRO_METHODS.subagentListUpdate,
      KIRO_METHODS.mcpServerInitialized,
      KIRO_METHODS.mcpServerInitFailure,
      KIRO_METHODS.mcpOauthRequest,
      KIRO_METHODS.compactionStatus,
      KIRO_METHODS.clearStatus,
      KIRO_METHODS.rateLimit,
      KIRO_METHODS.agentSwitched,
    ];
    for (const method of extensionNotifications) {
      app.onNotification(method, { parse: (p: unknown) => p }, (ctx) => {
        diagnostics.trace("kiro->bridge", { method, params: ctx.params });
        h.extensionNotification(method, ctx.params);
      });
    }

    const conn = app.connect(stream);
    return new KiroConnection(proc, conn, diagnostics);
  }

  private get agent(): ClientContext {
    return this.conn.agent;
  }

  get closed(): Promise<void> {
    return this.conn.closed;
  }

  /** Kiro's `initialize` result, available after {@link initialize}. */
  get capabilities(): schema.InitializeResponse | undefined {
    return this.initializeResult;
  }

  // -------------------------------------------------------------------------
  // Standard ACP calls
  // -------------------------------------------------------------------------

  async initialize(params: schema.InitializeRequest): Promise<schema.InitializeResponse> {
    this.diagnostics.trace("bridge->kiro", { method: "initialize", params });
    const res = await this.agent.request("initialize", params);
    this.initializeResult = res;
    this.diagnostics.info("kiro initialize", {
      protocolVersion: res.protocolVersion,
      agentInfo: res.agentInfo,
      agentCapabilities: res.agentCapabilities,
      authMethods: res.authMethods,
    });
    return res;
  }

  /**
   * Creates a session.
   *
   * Returned through a permissive parser because Kiro adds a non-standard
   * `models` field that stricter typings would drop.
   */
  async newSession(params: schema.NewSessionRequest): Promise<KiroNewSessionResponse> {
    this.diagnostics.trace("bridge->kiro", { method: "session/new", params });
    const raw = await this.agent.request<unknown>("session/new", params);
    return kiroNewSessionResponseSchema.parse(raw);
  }

  async loadSession(params: schema.LoadSessionRequest): Promise<KiroNewSessionResponse | undefined> {
    this.diagnostics.trace("bridge->kiro", { method: "session/load", params });
    const raw = await this.agent.request<unknown>("session/load", params);
    if (!raw || typeof raw !== "object") return undefined;
    const parsed = kiroNewSessionResponseSchema.safeParse({
      sessionId: params.sessionId,
      ...(raw as Record<string, unknown>),
    });
    return parsed.success ? parsed.data : undefined;
  }

  async prompt(params: schema.PromptRequest): Promise<schema.PromptResponse> {
    this.diagnostics.trace("bridge->kiro", { method: "session/prompt", params });
    return await this.agent.request("session/prompt", params);
  }

  async cancel(sessionId: string): Promise<void> {
    this.diagnostics.trace("bridge->kiro", { method: "session/cancel", params: { sessionId } });
    await this.agent.notify("session/cancel", { sessionId: sessionId as schema.SessionId });
  }

  async authenticate(methodId: string): Promise<unknown> {
    return await this.agent.request<unknown>("authenticate", { methodId });
  }

  // -------------------------------------------------------------------------
  // Kiro dialect
  // -------------------------------------------------------------------------

  /** Legacy model selection. The bridge's northbound face never exposes this. */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.diagnostics.trace("bridge->kiro", {
      method: KIRO_METHODS.setModel,
      params: { sessionId, modelId },
    });
    await this.agent.request<unknown>(KIRO_METHODS.setModel, { sessionId, modelId });
  }

  /** Selects an agent. Kiro calls agents "modes". */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.diagnostics.trace("bridge->kiro", {
      method: KIRO_METHODS.setMode,
      params: { sessionId, modeId },
    });
    await this.agent.request<unknown>(KIRO_METHODS.setMode, { sessionId, modeId });
  }

  /** Argument options for one command. Empty array when the command takes none. */
  async commandOptions(sessionId: string, command: KiroOptionCommand): Promise<KiroOption[]> {
    const raw = await this.agent.request<unknown>(KIRO_METHODS.commandsOptions, {
      sessionId,
      command,
    });
    return kiroOptionsResponseSchema.parse(raw).options;
  }

  /** Executes a TUI command and returns its structured result. */
  async execute(
    sessionId: string,
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<KiroExecuteResponse> {
    const params = buildExecute(sessionId, command, args);
    this.diagnostics.trace("bridge->kiro", { method: KIRO_METHODS.commandsExecute, params });
    const raw = await this.agent.request<unknown>(KIRO_METHODS.commandsExecute, params);
    return kiroExecuteResponseSchema.parse(raw);
  }

  /** `/context`, the only source of absolute token counts. */
  async contextBreakdown(sessionId: string): Promise<KiroContextData | undefined> {
    const res = await this.execute(sessionId, "context", { verbose: false });
    const parsed = kiroContextDataSchema.safeParse(res.data);
    return parsed.success ? parsed.data : undefined;
  }

  /** `/usage`: plan, credits and genuine monetary overage figures. */
  async usage(sessionId: string): Promise<KiroUsageData | undefined> {
    const res = await this.execute(sessionId, "usage");
    const parsed = kiroUsageDataSchema.safeParse(res.data);
    return parsed.success ? parsed.data : undefined;
  }

  /** `/model` with no argument: a listing that includes context windows. */
  async modelList(sessionId: string): Promise<KiroModelListData | undefined> {
    const res = await this.execute(sessionId, "model");
    const parsed = kiroModelListDataSchema.safeParse(res.data);
    return parsed.success ? parsed.data : undefined;
  }

  /** Kiro's saved-session index, used to implement standard `session/list`. */
  async sessionList(): Promise<KiroSessionList> {
    const raw = await this.agent.request<unknown>(KIRO_METHODS.sessionList, {});
    return kiroSessionListSchema.parse(raw);
  }

  async settingsList(sessionId: string): Promise<Record<string, unknown>> {
    const raw = await this.agent.request<unknown>(KIRO_METHODS.settingsList, { sessionId });
    return (raw ?? {}) as Record<string, unknown>;
  }

  async mcpStartupStatus(sessionId: string): Promise<KiroMcpStartupStatus | undefined> {
    try {
      const raw = await this.agent.request<unknown>(KIRO_METHODS.mcpStartupStatus, { sessionId });
      return kiroMcpStartupStatusSchema.parse(raw);
    } catch {
      return undefined;
    }
  }

  /**
   * Calls a Kiro extension method the bridge does not model.
   *
   * Kept public so unknown-but-useful surfaces stay reachable without changing
   * this module, per the compatibility policy.
   */
  async rawRequest<T = unknown>(method: string, params: unknown): Promise<T> {
    return await this.agent.request<T>(method, params);
  }

  /** Shuts down the ACP connection and then the child process. */
  async shutdown(): Promise<void> {
    try {
      this.conn.close();
    } catch {
      /* already closing */
    }
    await this.process.shutdown();
  }
}
