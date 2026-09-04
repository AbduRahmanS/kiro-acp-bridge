/**
 * Kiro's ACP dialect: the legacy model/mode APIs and the `_kiro.dev/*`
 * extensions.
 *
 * Every shape here was captured from `kiro-cli 2.21.0 acp --agent-engine v2` on
 * the wire, not taken from documentation. Where Kiro's behaviour differs from
 * its own docs, the observed behaviour is encoded and the discrepancy noted.
 *
 * This module is the *only* place that knows Kiro-specific vocabulary. Anything
 * northbound of the translation layer speaks standard ACP.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Method names
// ---------------------------------------------------------------------------

export const KIRO_METHODS = {
  /** Legacy ACP model selection. Kiro implements this; current Zed does not. */
  setModel: "session/set_model",
  /** Legacy ACP mode selection. In Kiro, "modes" are agents. */
  setMode: "session/set_mode",

  /** Notification: the full slash-command catalogue for a session. */
  commandsAvailable: "_kiro.dev/commands/available",
  /** Request: argument options for one command (models, agents, efforts, …). */
  commandsOptions: "_kiro.dev/commands/options",
  /** Request: execute a TUI command, returning structured data. */
  commandsExecute: "_kiro.dev/commands/execute",

  /** Request: Kiro's own saved-session index. */
  sessionList: "_kiro.dev/session/list",
  /** Request: current Kiro settings values. */
  settingsList: "_kiro.dev/settings/list",
  settingsSet: "_kiro.dev/settings/set",

  /** Notification: per-session context-usage percentage (no absolute tokens). */
  metadata: "_kiro.dev/metadata",
  /** Notification: subagent roster changes. */
  subagentListUpdate: "_kiro.dev/subagent/list_update",

  /** Request: aggregate MCP startup state. */
  mcpStartupStatus: "_kiro.dev/mcp/startup_status",
  /** Notification: an MCP server finished initialising. */
  mcpServerInitialized: "_kiro.dev/mcp/server_initialized",
  /** Notification: an MCP server failed to initialise. */
  mcpServerInitFailure: "_kiro.dev/mcp/server_init_failure",
  /** Notification: an MCP server needs OAuth; carries a URL to visit. */
  mcpOauthRequest: "_kiro.dev/mcp/oauth_request",

  /** Notification: compaction progress. */
  compactionStatus: "_kiro.dev/compaction/status",
  /** Notification: history-clear progress. */
  clearStatus: "_kiro.dev/clear/status",
  /** Notification: rate limiting. */
  rateLimit: "_kiro.dev/error/rate_limit",
  /** Notification: the active agent changed. */
  agentSwitched: "_kiro.dev/agent/switched",

  /** Request: spawn a parallel session. Requires a `task`. */
  sessionSpawn: "_session/spawn",
  /** Request: queue steering text into a running turn. Requires a `message`. */
  sessionSteer: "_session/steer",
} as const;

// ---------------------------------------------------------------------------
// Legacy model / mode state (returned from session/new)
// ---------------------------------------------------------------------------

/**
 * Kiro's model descriptor from `session/new`.
 *
 * Note `name` is the raw model id (e.g. `"gpt-5.6-sol"`), not a display label;
 * Kiro does not send a human-friendly name here. The bridge derives labels
 * itself so Zed's picker reads well.
 */
export const kiroModelInfoSchema = z.object({
  modelId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
});
export type KiroModelInfo = z.infer<typeof kiroModelInfoSchema>;

export const kiroModelStateSchema = z.object({
  currentModelId: z.string().optional(),
  availableModels: z.array(kiroModelInfoSchema).default([]),
});
export type KiroModelState = z.infer<typeof kiroModelStateSchema>;

/** A Kiro "mode" is an agent: `kiro_default`, `kiro_planner`, custom agents, … */
export const kiroModeSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  _meta: z.record(z.unknown()).optional(),
});
export type KiroMode = z.infer<typeof kiroModeSchema>;

export const kiroModeStateSchema = z.object({
  currentModeId: z.string().optional(),
  availableModes: z.array(kiroModeSchema).default([]),
});
export type KiroModeState = z.infer<typeof kiroModeStateSchema>;

/** `session/new` / `session/load` response as Kiro actually sends it. */
export const kiroNewSessionResponseSchema = z.object({
  sessionId: z.string(),
  modes: kiroModeStateSchema.optional(),
  models: kiroModelStateSchema.optional(),
});
export type KiroNewSessionResponse = z.infer<typeof kiroNewSessionResponseSchema>;

// ---------------------------------------------------------------------------
// commands/available
// ---------------------------------------------------------------------------

/**
 * Per-command metadata. Richer than standard ACP can express: Kiro describes
 * subcommands, per-subcommand hints, and an options endpoint for completion.
 *
 * Observed `inputType` values: `"selection"` (pick from a list),
 * `"panel"` (renders a TUI panel), absent (no argument).
 * `local: true` marks commands the *client* is expected to handle itself
 * (`/chat`, `/quit`) rather than forwarding to Kiro.
 */
export const kiroCommandMetaSchema = z.object({
  optionsMethod: z.string().optional(),
  inputType: z.string().optional(),
  hint: z.string().optional(),
  local: z.boolean().optional(),
  subcommands: z.array(z.string()).optional(),
  subcommandHints: z.record(z.string()).optional(),
  subcommandDescriptions: z.record(z.string()).optional(),
});
export type KiroCommandMeta = z.infer<typeof kiroCommandMetaSchema>;

export const kiroCommandSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** Kiro spells this `meta`, not ACP's `_meta`. */
  meta: kiroCommandMetaSchema.optional(),
});
export type KiroCommand = z.infer<typeof kiroCommandSchema>;

export const kiroCommandsAvailableSchema = z.object({
  sessionId: z.string().optional(),
  commands: z.array(kiroCommandSchema).default([]),
});
export type KiroCommandsAvailable = z.infer<typeof kiroCommandsAvailableSchema>;

// ---------------------------------------------------------------------------
// commands/options
// ---------------------------------------------------------------------------

/**
 * The `command` field is a plain string enum. Sending `"/model"` fails; it must
 * be `"model"`. This is the complete accepted set, taken from the deserialiser's
 * own error message.
 */
export const KIRO_OPTION_COMMANDS = [
  "model",
  "agent",
  "context",
  "compact",
  "clear",
  "quit",
  "usage",
  "mcp",
  "tools",
  "prompts",
  "feedback",
  "chat",
  "rewind",
  "effort",
] as const;
export type KiroOptionCommand = (typeof KIRO_OPTION_COMMANDS)[number];

/**
 * One selectable option.
 *
 * `group` carries semantic payload that varies by command: for `model` it is the
 * credit multiplier (`"2.20x credits"`), for `agent` it is the provenance
 * (`"Built-in"`). The active entry is marked by an `[active]` suffix inside
 * `description` — Kiro provides no dedicated field for it.
 */
export const kiroOptionSchema = z.object({
  value: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  group: z.string().optional(),
});
export type KiroOption = z.infer<typeof kiroOptionSchema>;

export const kiroOptionsResponseSchema = z.object({
  options: z.array(kiroOptionSchema).default([]),
  hasMore: z.boolean().optional(),
});
export type KiroOptionsResponse = z.infer<typeof kiroOptionsResponseSchema>;

/** Marker Kiro appends to the active option's description. */
export const ACTIVE_MARKER = "[active]";

/** Strips the `[active]` marker, returning a clean description. */
export function stripActiveMarker(description: string | undefined): string | undefined {
  if (!description) return description;
  return description.replace(ACTIVE_MARKER, "").trimEnd() || undefined;
}

/** True when this option is the currently selected one. */
export function isActiveOption(option: KiroOption): boolean {
  return (option.description ?? "").includes(ACTIVE_MARKER);
}

// ---------------------------------------------------------------------------
// commands/execute
// ---------------------------------------------------------------------------

/**
 * `TuiCommand` is a serde *adjacently tagged* enum whose tag is `command` and
 * whose content is `args`, so the wire shape nests:
 *
 * ```json
 * { "sessionId": "…", "command": { "command": "model", "args": { "modelName": "gpt-5.6-sol" } } }
 * ```
 *
 * `args` is required even when empty.
 */
export interface KiroExecuteRequest {
  sessionId: string;
  command: { command: string; args: Record<string, unknown> };
}

export const kiroExecuteResponseSchema = z.object({
  success: z.boolean().optional(),
  /** Human-readable result. Kiro renders this in its TUI. */
  message: z.string().optional(),
  /** Structured payload; shape varies per command. */
  data: z.unknown().optional(),
});
export type KiroExecuteResponse = z.infer<typeof kiroExecuteResponseSchema>;

/** Builds a well-formed execute request. */
export function buildExecute(
  sessionId: string,
  command: string,
  args: Record<string, unknown> = {},
): KiroExecuteRequest {
  return { sessionId, command: { command, args } };
}

/** Argument key for each command whose value the bridge needs to set. */
export const KIRO_COMMAND_ARG_KEYS = {
  model: "modelName",
  effort: "level",
  rewind: "turnIndex",
  compact: "targetTokens",
  prompts: "promptName",
  context: "verbose",
  feedback: "feedbackType",
} as const;

// ---------------------------------------------------------------------------
// Structured payloads from specific commands
// ---------------------------------------------------------------------------

/** One bucket of `/context`. Buckets carry real absolute token counts. */
export const kiroContextBucketSchema = z.object({
  tokens: z.number().optional(),
  percent: z.number().optional(),
  items: z.array(z.unknown()).optional(),
});

/**
 * `/context` data.
 *
 * This is the only Kiro surface exposing *absolute* token counts; the
 * `_kiro.dev/metadata` notification carries a percentage only. Summing the
 * buckets reconstructs `used` for an ACP `usage_update`.
 */
export const kiroContextDataSchema = z.object({
  model: z.string().optional(),
  contextUsagePercentage: z.number().optional(),
  breakdown: z.record(kiroContextBucketSchema).optional(),
});
export type KiroContextData = z.infer<typeof kiroContextDataSchema>;

/**
 * One `/usage` resource line.
 *
 * `resourceType` is `"CREDIT"` for Kiro's abstract credits. `currency` and the
 * overage fields are genuine money and are the only values that may legitimately
 * populate ACP's `Cost`.
 */
export const kiroUsageBreakdownSchema = z.object({
  resourceType: z.string().optional(),
  displayName: z.string().optional(),
  used: z.number().optional(),
  limit: z.number().optional(),
  percentage: z.number().optional(),
  currentOverages: z.number().optional(),
  overageRate: z.number().optional(),
  overageCharges: z.number().optional(),
  currency: z.string().optional(),
  hasLimit: z.boolean().optional(),
});
export type KiroUsageBreakdown = z.infer<typeof kiroUsageBreakdownSchema>;

export const kiroUsageDataSchema = z.object({
  planName: z.string().optional(),
  billingCycleReset: z.string().optional(),
  overagesEnabled: z.boolean().optional(),
  isEnterprise: z.boolean().optional(),
  usageBreakdowns: z.array(kiroUsageBreakdownSchema).default([]),
  bonusCredits: z.unknown().optional(),
  addOnCredits: z.unknown().optional(),
  overageCapable: z.boolean().optional(),
});
export type KiroUsageData = z.infer<typeof kiroUsageDataSchema>;

/** `/model` data, which uniquely includes each model's context window. */
export const kiroModelListDataSchema = z.object({
  models: z
    .array(
      z.object({
        id: z.string(),
        displayName: z.string().optional(),
        contextWindow: z.number().optional(),
        description: z.string().optional(),
      }),
    )
    .default([]),
});
export type KiroModelListData = z.infer<typeof kiroModelListDataSchema>;

/**
 * Authoritative state echoed back by a state-changing command.
 *
 * This matters because the `[active]` marker in `commands/options` is **stale
 * immediately after a change** — observed with `/plan`, where Kiro replied
 * "Agent changed to kiro_planner" while `commands/options {agent}` still marked
 * `kiro_default` as active. The command's own `data` block is the only reliable
 * signal, so it takes precedence over any subsequent list refresh.
 *
 * Observed shapes:
 *   /plan   -> data: { agent: { name: "kiro_planner", index: 6 } }
 *   /model  -> data: { model: { id: "gpt-5.6-luna", name: "gpt-5.6-luna" }, contextUsagePercentage }
 *   /effort -> no data block at all
 */
export const kiroCommandStateSchema = z.object({
  agent: z.object({ name: z.string().optional() }).partial().optional(),
  model: z.object({ id: z.string().optional(), name: z.string().optional() }).partial().optional(),
  contextUsagePercentage: z.number().optional(),
});
export type KiroCommandState = z.infer<typeof kiroCommandStateSchema>;

/** Extracts authoritative model/agent ids from a command result, if present. */
export function stateFromCommandResult(
  data: unknown,
): { modelId?: string; agentId?: string; contextUsagePercentage?: number } {
  const parsed = kiroCommandStateSchema.safeParse(data);
  if (!parsed.success) return {};
  const out: { modelId?: string; agentId?: string; contextUsagePercentage?: number } = {};
  const modelId = parsed.data.model?.id ?? parsed.data.model?.name;
  if (modelId) out.modelId = modelId;
  if (parsed.data.agent?.name) out.agentId = parsed.data.agent.name;
  if (parsed.data.contextUsagePercentage !== undefined) {
    out.contextUsagePercentage = parsed.data.contextUsagePercentage;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Other extension payloads
// ---------------------------------------------------------------------------

export const kiroMetadataSchema = z.object({
  sessionId: z.string().optional(),
  contextUsagePercentage: z.number().optional(),
  meteringUsage: z
    .array(z.object({ value: z.number().optional(), unit: z.string().optional() }))
    .optional(),
});
export type KiroMetadata = z.infer<typeof kiroMetadataSchema>;

export const kiroSessionListSchema = z.object({
  sessions: z
    .array(
      z.object({
        sessionId: z.string(),
        cwd: z.string().optional(),
        title: z.string().optional(),
        updatedAt: z.string().optional(),
        messageCount: z.number().optional(),
      }),
    )
    .default([]),
});
export type KiroSessionList = z.infer<typeof kiroSessionListSchema>;

export const kiroMcpStartupStatusSchema = z.object({
  allStarted: z.boolean().optional(),
  failed: z.array(z.unknown()).default([]),
  pending: z.array(z.unknown()).default([]),
  determinable: z.boolean().optional(),
});
export type KiroMcpStartupStatus = z.infer<typeof kiroMcpStartupStatusSchema>;

/** OAuth prompt for an MCP server. The URL is user-facing; never log secrets. */
export const kiroMcpOauthRequestSchema = z.object({
  sessionId: z.string().optional(),
  serverName: z.string().optional(),
  url: z.string().optional(),
  authorizationUrl: z.string().optional(),
});
export type KiroMcpOauthRequest = z.infer<typeof kiroMcpOauthRequestSchema>;

/** Extracts whichever URL field Kiro populated. */
export function oauthUrlOf(req: KiroMcpOauthRequest): string | undefined {
  return req.url ?? req.authorizationUrl;
}
