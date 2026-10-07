/**
 * The CLI V3 adapter.
 *
 * Kiro's migration guide is explicit: "keep separate CLI v2 and CLI V3 adapters
 * while you support both server generations". This is the V3 one. The v2 path in
 * `bridge.ts` + `config.ts` is untouched by it; the bridge picks one per
 * connection from what `initialize` advertised.
 *
 * Northbound nothing changes for Zed: the same `agent` / `model` / `effort`
 * option ids, the same slash-command names, standard ACP only. Southbound this
 * speaks V3's native config options and negotiated `_kiro/*` extensions.
 *
 * Pure translation lives in `v3-config.ts` and `v3-commands.ts`; this module only
 * sequences I/O and owns the ordering rules described where they apply.
 */

import type * as schema from "@agentclientprotocol/sdk";
import type { Diagnostics } from "../diagnostics/logging.js";
import type { KiroConnection } from "../kiro/connection.js";
import {
  creditsOfTurn,
  v3McpStatusSchema,
  v3OpenExternalUrlSchema,
  v3SessionInfoOf,
  type KiroV3McpServer,
} from "../kiro/protocol-v3.js";
import type { ParsedCommand } from "./commands.js";
import { CONFIG_IDS } from "./config.js";
import type { BridgeSession, V3SessionState } from "./session.js";
import { formatCreditSummary } from "./usage.js";
import {
  AUTOPILOT_OPTION_ID,
  AUTOPILOT_SUPERVISED_VALUE,
  buildV3ConfigOptions,
  buildV3ModeState,
  currentOf,
  effortAfterModelSwitch,
  matchValue,
  nameOf,
  nativeFor,
  resolveV3Change,
  valuesOf,
  type NativeOption,
  type Role,
} from "./v3-config.js";
import {
  buildV3AvailableCommands,
  formatHelp,
  formatV3Context,
  formatV3Mcp,
  formatValueList,
  planV3Command,
} from "./v3-commands.js";

/** What the adapter needs from the bridge. Kept narrow so it can be faked in tests. */
export interface V3Host {
  readonly diagnostics: Diagnostics;
  ensureKiro(): Promise<KiroConnection>;
  /** Sends a session update to Zed, queued until Zed knows the session. */
  sendUpdate(session: BridgeSession, update: schema.SessionUpdate): Promise<void>;
  /** Posts a bridge-authored message into the thread. */
  postNotice(session: BridgeSession, text: string): Promise<void>;
  /**
   * Asks Zed to open a URL with a visible user action (URL elicitation), or
   * prints it in the thread when Zed cannot. Resolves to whether it was accepted.
   */
  offerUrl(session: BridgeSession, url: string, message: string): Promise<boolean>;
}

/** Outcome of intercepting a slash command. */
export type V3Intercept = { kind: "handled" } | { kind: "forward" } | { kind: "prompt"; text: string };

export function initialV3State(): V3SessionState {
  return {
    native: [],
    effortExplicit: false,
    commands: [],
    mcpServers: undefined,
    reportedMcpFailures: new Map(),
    creditsUsed: 0,
    mutating: 0,
    nativeSeq: 0,
    commandSignature: "",
  };
}

function stateOf(session: BridgeSession): V3SessionState {
  if (!session.v3) session.v3 = initialV3State();
  return session.v3;
}

const ROLE_LABEL: Record<Role, string> = { model: "Model", agent: "Agent", effort: "Effort" };

export class V3Adapter {
  /** `_kiro/*` methods the connected server advertised. */
  extensionMethods: string[] = [];

  constructor(private readonly host: V3Host) {}

  // -------------------------------------------------------------------------
  // State views
  // -------------------------------------------------------------------------

  configOptions(session: BridgeSession): schema.SessionConfigOption[] {
    return buildV3ConfigOptions(stateOf(session).native);
  }

  modeState(session: BridgeSession): schema.SessionModeState | undefined {
    return buildV3ModeState(stateOf(session).native);
  }

  /**
   * Adopts the option array from a session response.
   *
   * Pass the `nativeSeq` captured before the request: if a
   * `config_option_update` arrived meanwhile it is at least as new, and is kept.
   * This matters on load, where 2.28 answers *without* the model option and
   * sends it ~75 ms later as a notification.
   */
  adoptNative(session: BridgeSession, native: NativeOption[], seqBefore?: number): void {
    const state = stateOf(session);
    if (seqBefore !== undefined && state.nativeSeq !== seqBefore) return;
    state.native = native;
  }

  /** Current notification counter, to capture before a session request. */
  seq(session: BridgeSession): number {
    return stateOf(session).nativeSeq;
  }

  /**
   * Waits briefly until the model option is known.
   *
   * After `session/load` V3 delivers the model option in a follow-up
   * notification; callers that need it immediately (the restart notice) wait
   * for it rather than report an empty roster.
   */
  async waitForModelOption(session: BridgeSession, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!nativeFor(stateOf(session).native, "model") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // -------------------------------------------------------------------------
  // Changing options
  // -------------------------------------------------------------------------

  /**
   * Sends one native change and adopts Kiro's reply.
   *
   * The reply is ignored if a `config_option_update` arrived while it was in
   * flight: that notification is at least as new, because Kiro emits on a single
   * ordered stream.
   */
  private async send(kiro: KiroConnection, session: BridgeSession, id: string, value: string | boolean): Promise<void> {
    const state = stateOf(session);
    const seq = state.nativeSeq;
    const native = await kiro.setConfigOption(session.sessionId, id, value);
    if (state.nativeSeq === seq && native.length > 0) state.native = native;
  }

  /**
   * Applies a change requested with a bridge-facing id.
   *
   * Validation happens before Kiro is contacted (V3 accepts a bogus model and
   * breaks the session). A model switch then reconciles effort so a level the
   * user chose survives when the new model supports it.
   */
  async setOption(
    session: BridgeSession,
    configId: string,
    value: string | boolean,
  ): Promise<{ changed: boolean; notice?: string }> {
    const state = stateOf(session);
    const change = resolveV3Change(state.native, configId, value);

    const nativeOption = state.native.find((o) => o.id === change.nativeId);
    if (nativeOption?.currentValue === change.value) {
      // Selecting the shown effort is still a statement of intent worth keeping.
      if (change.role === "effort") state.effortExplicit = true;
      return { changed: false };
    }

    const kiro = await this.host.ensureKiro();
    const before = {
      level: currentOf(state.native, "effort"),
      explicit: state.effortExplicit,
      model: currentOf(state.native, "model"),
    };

    state.mutating++;
    try {
      await this.send(kiro, session, change.nativeId, change.value);
      if (change.role === "effort") state.effortExplicit = true;

      let notice: string | undefined;
      if (currentOf(state.native, "model") !== before.model) {
        // A model switch, direct or via a mode that pins a model.
        const decision = effortAfterModelSwitch(before, state.native);
        state.effortExplicit = decision.explicit;
        const effortId = nativeFor(state.native, "effort")?.id;
        if (decision.reapply && typeof effortId === "string") {
          await this.send(kiro, session, effortId, decision.reapply);
        }
        notice = decision.notice;
      }
      session.bumpGeneration();
      return notice ? { changed: true, notice } : { changed: true };
    } finally {
      state.mutating--;
    }
  }

  /**
   * Bridge safety policy for new sessions: start supervised.
   *
   * V3 defaults `autopilot` to `on`, which runs every tool without asking. The v2
   * engine always asked through Zed, so moving a user to V3 must not quietly
   * remove that. Users who want autopilot set it in Zed's
   * `default_config_options`, which Zed applies after this.
   */
  async applySafeDefaults(session: BridgeSession): Promise<void> {
    const state = stateOf(session);
    const option = state.native.find((o) => o.id === AUTOPILOT_OPTION_ID);
    if (!option || option.currentValue === AUTOPILOT_SUPERVISED_VALUE) return;
    if (!valuesOf(option).some((v) => v.value === AUTOPILOT_SUPERVISED_VALUE)) {
      this.host.diagnostics.warn("autopilot option has no supervised value; leaving Kiro's default", {
        values: valuesOf(option).map((v) => v.value),
      });
      return;
    }
    const kiro = await this.host.ensureKiro();
    state.mutating++;
    try {
      await this.send(kiro, session, AUTOPILOT_OPTION_ID, AUTOPILOT_SUPERVISED_VALUE);
      this.host.diagnostics.info("started session supervised (autopilot off)", { sessionId: session.sessionId });
    } finally {
      state.mutating--;
    }
  }

  async pushConfigOptions(session: BridgeSession): Promise<void> {
    await this.host.sendUpdate(session, {
      sessionUpdate: "config_option_update",
      configOptions: this.configOptions(session),
    } as schema.SessionUpdate);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  private catalogue(session: BridgeSession): schema.AvailableCommand[] {
    const state = stateOf(session);
    return buildV3AvailableCommands(
      { native: state.native, extensionMethods: this.extensionMethods },
      state.commands,
    );
  }

  /** Publishes the merged catalogue; skipped when nothing changed unless forced. */
  async publishCommands(session: BridgeSession, force = false): Promise<void> {
    const state = stateOf(session);
    const commands = this.catalogue(session);
    const signature = commands.map((c) => c.name).join(" ");
    if (!force && signature === state.commandSignature) return;
    state.commandSignature = signature;
    await this.host.sendUpdate(session, {
      sessionUpdate: "available_commands_update",
      availableCommands: commands,
    } as schema.SessionUpdate);
  }

  /** Handles a slash command typed into the thread. */
  async intercept(session: BridgeSession, parsed: ParsedCommand): Promise<V3Intercept> {
    const state = stateOf(session);
    const plan = planV3Command(parsed, { native: state.native, extensionMethods: this.extensionMethods });

    switch (plan.kind) {
      case "forward":
        return { kind: "forward" };

      case "list":
        await this.host.postNotice(session, formatValueList(state.native, plan.role));
        return { kind: "handled" };

      case "set": {
        const found = matchValue(state.native, plan.role, plan.input);
        if (!found.match) {
          await this.host.postNotice(
            session,
            `\`${plan.input}\` does not match one ${ROLE_LABEL[plan.role].toLowerCase()}. ` +
              `Options: ${found.candidates.map((c) => `\`${c}\``).join(", ") || "(none)"}.`,
          );
          return { kind: "handled" };
        }
        const res = await this.setOption(session, CONFIG_IDS[plan.role], found.match);
        await this.pushConfigOptions(session);
        await this.publishCommands(session);
        const label = nameOf(state.native, plan.role, currentOf(state.native, plan.role));
        await this.host.postNotice(
          session,
          [`${ROLE_LABEL[plan.role]} ${res.changed ? "changed to" : "is already"} **${label}**.`, res.notice]
            .filter(Boolean)
            .join("\n\n"),
        );
        return { kind: "handled" };
      }

      case "plan": {
        if (currentOf(state.native, "agent") !== "plan") {
          const res = await this.setOption(session, CONFIG_IDS.agent, "plan");
          await this.pushConfigOptions(session);
          await this.publishCommands(session);
          if (res.notice) await this.host.postNotice(session, res.notice);
        }
        if (plan.prompt) return { kind: "prompt", text: plan.prompt };
        await this.host.postNotice(session, `Agent changed to **${nameOf(state.native, "agent", "plan")}**.`);
        return { kind: "handled" };
      }

      case "context": {
        const kiro = await this.host.ensureKiro();
        const show = await kiro.v3ContextShow(session.sessionId);
        await this.host.postNotice(session, formatV3Context(show, session.contextUsagePercentage));
        return { kind: "handled" };
      }

      case "compact": {
        const kiro = await this.host.ensureKiro();
        const res = await kiro.v3Compact(session.sessionId);
        await this.host.postNotice(
          session,
          res.success === false
            ? `Kiro could not compact the conversation right now${res.message ? `: ${res.message}` : "."}`
            : (res.message ?? "Conversation compacted."),
        );
        return { kind: "handled" };
      }

      case "usage":
        await this.reportUsage(session);
        return { kind: "handled" };

      case "mcp":
        await this.host.postNotice(session, formatV3Mcp(state.mcpServers));
        return { kind: "handled" };

      case "help":
        await this.host.postNotice(session, formatHelp(this.catalogue(session)));
        return { kind: "handled" };
    }
  }

  /**
   * `/usage`: plan and credits, this thread's credits, and context percentage.
   *
   * `_kiro/account/getUsage` is Kiro's documented replacement for `/usage` but
   * 2.28 does not list it in `extensionMethods`, though it answers. It is called
   * anyway and any failure degrades to the parts that are known.
   */
  private async reportUsage(session: BridgeSession): Promise<void> {
    const state = stateOf(session);
    const parts: string[] = [];
    try {
      const kiro = await this.host.ensureKiro();
      const credits = formatCreditSummary(await kiro.v3Usage(session.sessionId));
      if (credits) parts.push(credits);
    } catch (err) {
      this.host.diagnostics.debug("v3 getUsage failed", { message: (err as Error).message });
    }
    if (state.creditsUsed > 0) {
      parts.push(`**This thread:** ${Math.round(state.creditsUsed * 100) / 100} credits`);
    }
    if (session.contextUsagePercentage !== undefined) {
      parts.push(`**Context:** ${Math.round(session.contextUsagePercentage * 10) / 10}% of the context window used`);
    }
    await this.host.postNotice(
      session,
      parts.length > 0 ? parts.join("\n\n") : "Kiro reported no usage information for this session.",
    );
  }

  // -------------------------------------------------------------------------
  // Kiro -> Zed
  // -------------------------------------------------------------------------

  /**
   * Handles state-carrying updates. Returns false for anything the bridge should
   * forward unchanged (the transcript and unknown kinds).
   */
  async onSessionUpdate(session: BridgeSession, update: Record<string, unknown>): Promise<boolean> {
    const state = stateOf(session);
    switch (update.sessionUpdate) {
      case "config_option_update": {
        // Kiro's ids differ from the bridge's (`mode`, `effortLevel`), and Zed
        // replaces its options wholesale, so the raw update must never pass.
        if (Array.isArray(update.configOptions)) {
          state.native = update.configOptions as NativeOption[];
          state.nativeSeq++;
        }
        if (state.mutating === 0) {
          await this.pushConfigOptions(session);
          await this.publishCommands(session);
        }
        return true;
      }
      case "available_commands_update": {
        state.commands = Array.isArray(update.availableCommands)
          ? (update.availableCommands as schema.AvailableCommand[])
          : [];
        await this.publishCommands(session, true);
        return true;
      }
      case "session_info_update": {
        const info = v3SessionInfoOf(update);
        if (info?.kind === "context_usage" && typeof info.usagePercentage === "number") {
          session.contextUsagePercentage = info.usagePercentage;
        } else if (info?.kind === "turn_completion") {
          state.creditsUsed += creditsOfTurn(info);
        }
        // Only the standard fields mean anything to Zed. Lifecycle kinds carry
        // nothing but vendor `_meta`, so they are consumed here.
        if (update.title !== undefined || update.updatedAt !== undefined) {
          await this.host.sendUpdate(session, {
            sessionUpdate: "session_info_update",
            ...(update.title !== undefined ? { title: update.title } : {}),
            ...(update.updatedAt !== undefined ? { updatedAt: update.updatedAt } : {}),
          } as schema.SessionUpdate);
        }
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * `_kiro/mcp/status`: a full snapshot that replaces the previous one.
   *
   * Each failure is reported once per distinct error, so an unchanged failure in
   * the next snapshot does not repeat in the thread.
   */
  async onMcpStatus(session: BridgeSession, params: unknown): Promise<void> {
    const parsed = v3McpStatusSchema.safeParse(params);
    if (!parsed.success) return;
    const state = stateOf(session);
    state.mcpServers = parsed.data.servers;

    const fresh: KiroV3McpServer[] = [];
    for (const server of parsed.data.servers) {
      if (server.status !== "failed") {
        state.reportedMcpFailures.delete(server.name);
        continue;
      }
      const key = `${server.failedAuthorization === true}|${server.errorMessage ?? ""}`;
      if (state.reportedMcpFailures.get(server.name) === key) continue;
      state.reportedMcpFailures.set(server.name, key);
      fresh.push(server);
    }

    const plain: string[] = [];
    for (const server of fresh) {
      const url = server.authorizationUrl;
      if (server.failedAuthorization && url && /^https:\/\//i.test(url)) {
        // Never logged: an authorisation URL can embed client ids and PKCE data.
        await this.host.offerUrl(
          session,
          url,
          `**${server.name}** needs authorisation. Open the link to sign in, then return here.`,
        );
      } else if (server.failedAuthorization) {
        plain.push(`- **${server.name}** needs authorisation; authorise it from \`kiro-cli --v3\` with \`/mcp\`.`);
      } else {
        plain.push(`- **${server.name}**: ${server.errorMessage ?? "failed to start"}`);
      }
    }
    if (plain.length > 0) {
      await this.host.postNotice(session, [`**MCP server${plain.length > 1 ? "s" : ""} unavailable:**`, ...plain].join("\n"));
    }
  }

  /**
   * `_kiro/openExternalUrl`: Kiro wants a URL opened, typically for MCP OAuth.
   *
   * Opened only through a visible user action in Zed, and only for http(s).
   */
  async openExternalUrl(session: BridgeSession | undefined, params: unknown): Promise<Record<string, never>> {
    const parsed = v3OpenExternalUrlSchema.safeParse(params);
    if (!parsed.success || !/^https?:\/\//i.test(parsed.data.url)) {
      throw new Error("Only http(s) URLs can be opened.");
    }
    if (!session) throw new Error("No active thread to show the link in.");
    const accepted = await this.host.offerUrl(session, parsed.data.url, "Kiro needs you to open a link to continue.");
    if (!accepted) throw new Error("The user declined to open the link.");
    return {};
  }

  /** Server names Kiro manages itself, so Zed's copies are not started twice. */
  managedMcpNames(sessions: readonly BridgeSession[]): string[] {
    const names = new Set<string>();
    for (const s of sessions) {
      for (const server of s.v3?.mcpServers ?? []) {
        // `client` entries are the ones the bridge forwarded from Zed.
        if (server.origin?.origin !== "client") names.add(server.name);
      }
    }
    return [...names];
  }
}
