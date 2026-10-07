/**
 * Slash commands on the CLI V3 engine.
 *
 * V3 removed the generic `_kiro.dev/commands/execute` API. Its
 * `available_commands_update` lists only steering files and subagents, which it
 * runs itself when they arrive as prompt text. Everything a v2 user typed —
 * `/model`, `/effort`, `/context`, `/usage` — would now reach the *model* as
 * prose. Kiro's migration guide gives each command a replacement route; the
 * bridge implements the ones with a working route and advertises only those
 * ("display a command only when your client has a defined route for it").
 *
 *   /model /effort /agent   -> session/set_config_option (validated)
 *   /plan [text]            -> switch to the `plan` mode, then prompt with the text
 *   /context                -> _kiro/session/context {subcommand: "show"}
 *   /compact                -> _kiro/session/compact
 *   /usage                  -> _kiro/account/getUsage
 *   /mcp                    -> the latest _kiro/mcp/status snapshot
 *   /help                   -> this catalogue
 *
 * Pure functions only; the I/O lives in `v3-adapter.ts`.
 */

import type * as schema from "@agentclientprotocol/sdk";
import { BRIDGE_COMMANDS, type ParsedCommand } from "./commands.js";
import { currentOf, nameOf, nativeFor, valuesOf, type NativeOption, type Role } from "./v3-config.js";
import { KIRO_V3_METHODS, type KiroV3McpServer, type V3ContextShow } from "../kiro/protocol-v3.js";

export type V3CommandPlan =
  | { kind: "forward" }
  | { kind: "list"; role: Role }
  | { kind: "set"; role: Role; input: string }
  | { kind: "plan"; prompt: string }
  | { kind: "context" }
  | { kind: "compact" }
  | { kind: "usage" }
  | { kind: "mcp" }
  | { kind: "help" };

/** What the current session can actually route, so nothing dead is advertised. */
export interface V3CommandContext {
  native: readonly NativeOption[];
  extensionMethods: readonly string[];
}

const PLAN_MODE = "plan";

function hasPlanMode(native: readonly NativeOption[]): boolean {
  return valuesOf(nativeFor(native, "agent")).some((v) => v.value === PLAN_MODE);
}

/** The bridge-implemented V3 commands available in this session. */
export function v3BridgeCommands(ctx: V3CommandContext): schema.AvailableCommand[] {
  const out: schema.AvailableCommand[] = [
    { name: "model", description: "Switch model, or list the available models", input: { hint: "[model]" } },
    { name: "agent", description: "Switch agent, or list the available agents", input: { hint: "[agent]" } },
  ];
  if (nativeFor(ctx.native, "effort")) {
    out.push({
      name: "effort",
      description: "Set reasoning effort for the current model, or list the levels",
      input: { hint: "[level]" },
    });
  }
  if (hasPlanMode(ctx.native)) {
    out.push({
      name: "plan",
      description: "Switch to the Plan agent, optionally sending a prompt",
      input: { hint: "[prompt]" },
    });
  }
  if (ctx.extensionMethods.includes(KIRO_V3_METHODS.sessionContext)) {
    out.push({ name: "context", description: "Show how the context window is being used" });
  }
  if (ctx.extensionMethods.includes(KIRO_V3_METHODS.sessionCompact)) {
    out.push({ name: "compact", description: "Summarise the conversation to free context" });
  }
  out.push(
    { name: "usage", description: "Show plan, credits and context usage" },
    { name: "mcp", description: "Show MCP server status" },
    { name: "help", description: "List the commands available in this thread" },
  );
  return out;
}

/**
 * The full catalogue: bridge commands first, then Kiro's own.
 *
 * A Kiro command with the same name as a bridge command is dropped, since the
 * bridge intercepts that name and Kiro's would be unreachable. Vendor `_meta` is
 * stripped; the command name is all Zed needs to send it back.
 */
export function buildV3AvailableCommands(
  ctx: V3CommandContext,
  kiroCommands: readonly schema.AvailableCommand[],
): schema.AvailableCommand[] {
  const out: schema.AvailableCommand[] = [];
  const seen = new Set<string>();
  for (const cmd of [...BRIDGE_COMMANDS, ...v3BridgeCommands(ctx)]) {
    if (seen.has(cmd.name)) continue;
    seen.add(cmd.name);
    out.push(cmd);
  }
  for (const cmd of kiroCommands) {
    const name = String(cmd.name ?? "").replace(/^\//, "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: cmd.description ?? `Kiro command /${name}`,
      ...(cmd.input ? { input: cmd.input } : {}),
    });
  }
  return out;
}

/** Decides how a parsed command is handled on V3. Unknown names go to Kiro. */
export function planV3Command(parsed: ParsedCommand, ctx: V3CommandContext): V3CommandPlan {
  const available = new Set(v3BridgeCommands(ctx).map((c) => c.name));
  if (!available.has(parsed.name)) return { kind: "forward" };
  switch (parsed.name) {
    case "model":
    case "agent":
    case "effort":
      return parsed.args === ""
        ? { kind: "list", role: parsed.name }
        : { kind: "set", role: parsed.name, input: parsed.args };
    case "plan":
      return { kind: "plan", prompt: parsed.args };
    case "context":
      return { kind: "context" };
    case "compact":
      return { kind: "compact" };
    case "usage":
      return { kind: "usage" };
    case "mcp":
      return { kind: "mcp" };
    case "help":
      return { kind: "help" };
    default:
      return { kind: "forward" };
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ROLE_TITLES: Record<Role, string> = { model: "Models", agent: "Agents", effort: "Effort levels" };

/** Markdown list of a role's values with the current one marked. */
export function formatValueList(native: readonly NativeOption[], role: Role): string {
  const current = currentOf(native, role);
  const lines = valuesOf(nativeFor(native, role)).map((v) => {
    const label = nameOf(native, role, v.value);
    const mark = v.value === current ? " **(current)**" : "";
    return `- \`${v.value}\` — ${label}${mark}`;
  });
  if (lines.length === 0) return `No ${ROLE_TITLES[role].toLowerCase()} are available.`;
  return [`**${ROLE_TITLES[role]}**`, ...lines, "", `Use \`/${role} <id>\` or the selector to switch.`].join("\n");
}

const BUCKET_LABELS: Record<string, string> = {
  contextFiles: "Context files",
  sessionFiles: "Session files",
  tools: "Tools",
  memory: "Memory",
  kiroResponses: "Kiro responses",
  yourPrompts: "Your prompts",
};

function bucketLabel(key: string): string {
  if (BUCKET_LABELS[key]) return BUCKET_LABELS[key];
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function pct(n: number): string {
  return `${Math.round(n * 10) / 10}%`;
}

/**
 * Renders `/context`.
 *
 * Percentages only. V3 reconciles each bucket's `percent` to the overall usage
 * but not its `tokens`, which were observed to be stale, so printing token counts
 * would show numbers that do not add up.
 */
export function formatV3Context(show: V3ContextShow | undefined, usagePercentage: number | undefined): string {
  const lines: string[] = [];
  if (usagePercentage !== undefined) lines.push(`**Context:** ${pct(usagePercentage)} of the context window used`);
  const buckets = Object.entries(show?.breakdown ?? {})
    .filter(([, b]) => typeof b.percent === "number" && b.percent > 0)
    .sort(([, a], [, b]) => (b.percent ?? 0) - (a.percent ?? 0))
    .map(([k, b]) => `- ${bucketLabel(k)}: ${pct(b.percent ?? 0)}`);
  lines.push(...buckets);
  const files = show?.entries.length ?? 0;
  if (files > 0) lines.push(`\n${files} context file${files === 1 ? "" : "s"} attached.`);
  return lines.length > 0 ? lines.join("\n") : "Kiro reported no context information for this session.";
}

/** Renders an MCP snapshot, or undefined when there are no servers. */
export function formatV3Mcp(servers: readonly KiroV3McpServer[] | undefined): string {
  if (!servers || servers.length === 0) return "No MCP servers are configured for this session.";
  const lines = servers.map((s) => {
    let state = s.status;
    if (s.status === "failed") {
      state = s.failedAuthorization ? "needs authorisation" : `failed${s.errorMessage ? ` (${s.errorMessage})` : ""}`;
    }
    return `- **${s.name}**: ${state}`;
  });
  return ["**MCP servers**", ...lines].join("\n");
}

/** Renders `/help` from the live catalogue. */
export function formatHelp(commands: readonly schema.AvailableCommand[]): string {
  return ["**Commands**", ...commands.map((c) => `- \`/${c.name}\` — ${c.description}`)].join("\n");
}
