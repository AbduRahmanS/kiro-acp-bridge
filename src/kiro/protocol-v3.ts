/**
 * Kiro's CLI V3 ACP dialect.
 *
 * V3 is a different server generation, not a newer version of the v2 dialect in
 * `protocol.ts`. Both negotiate ACP protocol version 1, so the generation is
 * identified by what `initialize` advertises — never by a version string.
 *
 * Every shape here was captured from `kiro-cli 2.28.0 acp --agent-engine v3
 * --auth-method=cli` on the wire, and cross-checked against Kiro's "Migrate an
 * ACP client to CLI V3" guide. Where the two disagree, observed behaviour wins and
 * the discrepancy is noted.
 *
 * What V3 changed, in the terms that matter to this bridge:
 *
 *  - Model, mode and effort are **native ACP config options** with a working
 *    `session/set_config_option`. The v2 translation layer is not needed.
 *  - `session/list`, `session/close` and `session/delete` are native.
 *  - The `_kiro.dev/*` catalogue is gone. Optional methods are negotiated through
 *    `agentCapabilities._meta.kiro.extensionMethods` and live under `_kiro/*`.
 *  - Context usage and turn metering arrive as standard `session_info_update`
 *    notifications, dispatched by `_meta.kiro.kind`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Launch and detection
// ---------------------------------------------------------------------------

/**
 * Extra launch arguments for the V3 engine.
 *
 * `--auth-method=cli` keeps token handling inside the Kiro process. Without it
 * the client must answer `_kiro/auth/getAccessToken`, which would put access
 * tokens on the bridge's wire — exactly what this bridge refuses to touch.
 */
export const V3_LAUNCH_ARGS = ["--auth-method=cli"] as const;

export const KIRO_V3_METHODS = {
  setConfigOption: "session/set_config_option",
  /** Request: context breakdown and context-file management. Needs `subcommand`. */
  sessionContext: "_kiro/session/context",
  /** Request: compact the conversation. */
  sessionCompact: "_kiro/session/compact",
  /** Request: plan and credit standing. Same `data` shape as v2's `/usage`. */
  accountGetUsage: "_kiro/account/getUsage",
  /** Notification: full MCP status snapshot, replacing the previous one. */
  mcpStatus: "_kiro/mcp/status",
  /** Agent-to-client request: open a URL (OAuth). Only sent if the client opts in. */
  openExternalUrl: "_kiro/openExternalUrl",
  /** Notification: the model service is throttling. */
  rateLimit: "_kiro/error/rate_limit",
  customAgentNotFound: "_kiro/customAgent/not_found",
  customAgentConfigError: "_kiro/customAgent/config_error",
} as const;

/** The subset of `initialize` the bridge reads to recognise a V3 server. */
const v3InitMetaSchema = z.object({
  agentCapabilities: z
    .object({
      _meta: z
        .object({
          kiro: z
            .object({
              extensionMethods: z.array(z.string()),
            })
            .passthrough(),
        })
        .passthrough(),
    })
    .passthrough(),
});

/**
 * Kiro's advertised extension methods, or undefined when this is not a V3 server.
 *
 * The array's presence is the generation marker: the v2 server has no
 * `_meta.kiro` block at all.
 */
export function v3ExtensionMethods(init: unknown): string[] | undefined {
  const parsed = v3InitMetaSchema.safeParse(init);
  return parsed.success ? parsed.data.agentCapabilities._meta.kiro.extensionMethods : undefined;
}

export type KiroDialect = "v2" | "v3";

/** Which dialect a Kiro `initialize` response speaks. */
export function detectDialect(init: unknown): KiroDialect {
  return v3ExtensionMethods(init) ? "v3" : "v2";
}

// ---------------------------------------------------------------------------
// Config options
// ---------------------------------------------------------------------------

/**
 * `_meta.kiro` on a model option value.
 *
 * Observed: `{rateMultiplier: 2, rateUnit: "Credit", hasEffort: true,
 * effortSchemaPath: "output_config", effortLevels: [...], defaultEffortLevel:
 * "medium", thinkingToggleable: false}`. Notably absent: the context window.
 */
export const v3ModelMetaSchema = z
  .object({
    rateMultiplier: z.number().optional(),
    rateUnit: z.string().optional(),
    hasEffort: z.boolean().optional(),
    effortLevels: z.array(z.string()).optional(),
    defaultEffortLevel: z.string().optional(),
  })
  .passthrough();
export type V3ModelMeta = z.infer<typeof v3ModelMetaSchema>;

/** `_meta.kiro` on a mode option value. `source` is `bundled`, `user`, `workspace`, … */
export const v3ModeMetaSchema = z.object({ source: z.string().optional() }).passthrough();

/** Reads `_meta.kiro` from an option value, validated against `schema`. */
export function kiroMetaOf<T extends z.ZodTypeAny>(value: unknown, schema: T): z.infer<T> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const meta = (value as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const parsed = schema.safeParse((meta as { kiro?: unknown }).kiro);
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const v3ConfigOptionsSchema = z.array(z.record(z.unknown()));

/**
 * `session/new` and `session/load` as V3 sends them.
 *
 * `session/load` omits `sessionId`, as the migration guide warns, so callers keep
 * the requested id themselves.
 */
export const v3SessionResponseSchema = z
  .object({
    sessionId: z.string().optional(),
    modes: z
      .object({
        currentModeId: z.string().optional(),
        availableModes: z.array(z.record(z.unknown())).default([]),
      })
      .passthrough()
      .optional(),
    configOptions: v3ConfigOptionsSchema.default([]),
  })
  .passthrough();
export type V3SessionResponse = z.infer<typeof v3SessionResponseSchema>;

export const v3SetConfigOptionResponseSchema = z
  .object({ configOptions: v3ConfigOptionsSchema.default([]) })
  .passthrough();

// ---------------------------------------------------------------------------
// session_info_update kinds
// ---------------------------------------------------------------------------

/**
 * `_meta.kiro` of a `session_info_update`.
 *
 * Observed kinds: `context_usage`, `turn_completion`, `turn_start`, `turn_end`,
 * `focus_update`, `pending_interaction`, `interaction_resolved`,
 * `user_message_id_assigned`. Unknown kinds must be tolerated.
 *
 * `context_usage.breakdown[*].tokens` is **not** reliable: Kiro reconciles the
 * `percent` fields to `usagePercentage` but leaves stale token counts (observed
 * `yourPrompts: {tokens: 0, percent: 0.4}`). Only the percentages are used.
 */
export const v3SessionInfoMetaSchema = z
  .object({
    kind: z.string(),
    usagePercentage: z.number().optional(),
    promptTurnSummaries: z
      .array(z.object({ unit: z.string().optional(), usage: z.number().optional() }).passthrough())
      .optional(),
  })
  .passthrough();
export type V3SessionInfoMeta = z.infer<typeof v3SessionInfoMetaSchema>;

/** Reads the Kiro kind payload of a `session_info_update`, if it has one. */
export function v3SessionInfoOf(update: unknown): V3SessionInfoMeta | undefined {
  return kiroMetaOf(update, v3SessionInfoMetaSchema);
}

/** Credits consumed by one `turn_completion`, or 0. */
export function creditsOfTurn(info: V3SessionInfoMeta): number {
  let total = 0;
  for (const s of info.promptTurnSummaries ?? []) {
    if ((s.unit ?? "").toLowerCase() === "credit" && typeof s.usage === "number" && Number.isFinite(s.usage)) {
      total += s.usage;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Extension payloads
// ---------------------------------------------------------------------------

const v3BucketSchema = z.object({ tokens: z.number().optional(), percent: z.number().optional() }).passthrough();

/** `_kiro/session/context {subcommand: "show"}` result. */
export const v3ContextShowSchema = z
  .object({
    success: z.boolean().optional(),
    message: z.string().optional(),
    entries: z.array(z.unknown()).default([]),
    breakdown: z.record(v3BucketSchema).optional(),
  })
  .passthrough();
export type V3ContextShow = z.infer<typeof v3ContextShowSchema>;

/** `_kiro/session/compact` result. */
export const v3CompactSchema = z.object({ success: z.boolean().optional(), message: z.string().optional() }).passthrough();

/** One server in a `_kiro/mcp/status` snapshot. */
export const v3McpServerSchema = z
  .object({
    name: z.string(),
    status: z.string(),
    failedAuthorization: z.boolean().optional(),
    authorizationUrl: z.string().optional(),
    errorMessage: z.string().optional(),
    origin: z.object({ origin: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
export type KiroV3McpServer = z.infer<typeof v3McpServerSchema>;

export const v3McpStatusSchema = z.object({
  sessionId: z.string().optional(),
  servers: z.array(v3McpServerSchema).default([]),
});

export const v3OpenExternalUrlSchema = z.object({ url: z.string() });

export const v3RateLimitSchema = z.object({ sessionId: z.string().optional(), message: z.string().optional() });

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/**
 * Update kinds that are conversation *history* rather than current state.
 *
 * Dropped while the bridge re-attaches a session after restarting Kiro, because
 * Zed already shows them. State updates (`config_option_update`,
 * `available_commands_update`, `current_mode_update`, `session_info_update`)
 * still flow.
 */
export const TRANSCRIPT_UPDATE_KINDS = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);
