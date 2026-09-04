/**
 * Slash-command translation.
 *
 * Kiro publishes its command catalogue through the `_kiro.dev/commands/available`
 * notification, with richer metadata than ACP can express (subcommands,
 * per-subcommand hints, an options endpoint for completion, an input-type tag).
 * ACP's `AvailableCommand` has only `name`, `description` and an unstructured
 * `input.hint`. Current Zed reads `input` purely as a boolean and discards the
 * hint entirely, so hints are advisory at best.
 *
 * Dispatch is the interesting half. Two facts from probing shape it:
 *
 *  1. Kiro's **prompt path already interprets slash commands**. Sending the
 *     literal text `/context` through `session/prompt` returned
 *     "Context breakdown - 3% used" without invoking a model. So the default
 *     behaviour — forward the text unchanged, exactly as Zed sends it — is
 *     correct and costs nothing.
 *
 *  2. Kiro emits **no notification when the model or agent changes**. So a
 *     command that mutates selector state must be intercepted, executed through
 *     `_kiro.dev/commands/execute` (which returns structured data), and followed
 *     by a `config_option_update` push. Otherwise `/model gpt-5.6-sol` would
 *     change Kiro while Zed's picker kept showing the old value — precisely the
 *     stale-selector failure the brief calls out.
 *
 * Hence: intercept the state-changing commands, pass everything else through.
 */

import type * as schema from "@agentclientprotocol/sdk";
import type { KiroCommand } from "../kiro/protocol.js";
import type { DiscoveredSkill } from "./skills.js";

/**
 * Commands the bridge does not advertise to Zed.
 *
 * The requirement is functional parity, not TUI emulation. Each of these is
 * either meaningless over ACP or already better served by Zed itself:
 *
 *   /quit       Zed closes threads; a command to exit the process is wrong here
 *   /paste      Zed has native image attachment
 *   /voice      terminal-only audio capture
 *   /reply      opens $EDITOR to quote the last message
 *   /editor     opens $EDITOR to compose
 *   /theme      terminal colour override
 *   /copy       terminal clipboard via OSC 52
 *   /transcript opens a pager; Zed shows the thread already
 *
 * `/clear` is excluded for a sharper reason: in Kiro it clears the conversation
 * *display*, which has no coherent meaning in Zed where the thread is the record.
 * Zed users start a new thread instead.
 */
export const EXCLUDED_COMMANDS = new Set([
  "quit",
  "exit",
  "q",
  "paste",
  "voice",
  "reply",
  "editor",
  "theme",
  "copy",
  "transcript",
  "clear",
]);

/**
 * Commands that change selector state and must therefore be intercepted.
 *
 * Mapped to the Kiro `TuiCommand` variant and the `args` key that carries the
 * value. `/plan` and `/guide` take no argument: they switch agent by identity.
 */
export const STATE_CHANGING_COMMANDS: Record<string, { variant: string; argKey?: string }> = {
  model: { variant: "model", argKey: "modelName" },
  effort: { variant: "effort", argKey: "level" },
  agent: { variant: "agent", argKey: "agentName" },
  plan: { variant: "plan" },
  guide: { variant: "guide" },
};

/** Parsed form of a prompt that begins with a slash command. */
export interface ParsedCommand {
  /** Command name without the leading slash, lower-cased. */
  name: string;
  /** Everything after the command name, trimmed. Empty string when absent. */
  args: string;
  /** The original text, so it can be forwarded verbatim. */
  raw: string;
}

/**
 * Extracts a leading slash command from prompt text.
 *
 * Returns undefined unless the very first characters are a slash command, so
 * ordinary prose mentioning a slash mid-sentence is never misread as a command.
 */
export function parseSlashCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return undefined;
  const match = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return undefined;
  return {
    name: (match[1] ?? "").toLowerCase(),
    args: (match[2] ?? "").trim(),
    raw: text,
  };
}

/**
 * Finds a leading slash command in an ACP prompt.
 *
 * Only considered when the prompt's first content block is text, which is how Zed
 * sends a command. A prompt that leads with an image is never a command.
 */
export function commandFromPrompt(prompt: readonly schema.ContentBlock[]): ParsedCommand | undefined {
  const first = prompt[0];
  if (!first || first.type !== "text") return undefined;
  if (prompt.length > 1) {
    // A command with attachments is ambiguous; treat it as a normal prompt so the
    // attachments are not silently dropped.
    return undefined;
  }
  return parseSlashCommand(first.text);
}

/**
 * Builds an ACP `input` hint for a command.
 *
 * Kiro's per-subcommand hints are flattened into one advisory string. Zed only
 * uses the *presence* of `input` (to decide whether to leave the cursor after the
 * command name), so this text is currently invisible there — but it is correct
 * ACP and other clients may render it.
 */
export function buildCommandInput(cmd: KiroCommand): schema.AvailableCommandInput | undefined {
  const meta = cmd.meta;
  if (!meta) return undefined;

  const parts: string[] = [];
  if (meta.hint) parts.push(meta.hint);
  if (meta.subcommands?.length) {
    const withHints = meta.subcommands.map((sub) => {
      const hint = meta.subcommandHints?.[sub];
      return hint ? `${sub} ${hint}` : sub;
    });
    parts.push(withHints.join(" | "));
  }
  if (parts.length === 0) {
    // `selection` means Kiro expects a value picked from commands/options.
    if (meta.inputType === "selection") parts.push("value");
    else return undefined;
  }
  return { hint: parts.join("  ·  ") };
}

/**
 * Translates Kiro's catalogue plus discovered skills into ACP commands.
 *
 * Skills are appended and take precedence on a name clash only if Kiro has no
 * command of that name — a built-in command must never be shadowed by a skill.
 */
export function buildAvailableCommands(
  kiroCommands: readonly KiroCommand[],
  skills: readonly DiscoveredSkill[] = [],
): schema.AvailableCommand[] {
  const out: schema.AvailableCommand[] = [];
  const seen = new Set<string>();

  for (const cmd of kiroCommands) {
    const name = cmd.name.replace(/^\//, "");
    if (!name || EXCLUDED_COMMANDS.has(name.toLowerCase())) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    const input = buildCommandInput(cmd);
    out.push({
      name,
      description: cmd.description ?? `Kiro command /${name}`,
      ...(input ? { input } : {}),
    });
  }

  for (const skill of skills) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    out.push({
      name: skill.name,
      // Marking the origin matters: a user seeing 30 commands needs to know
      // which are their own skills.
      description: `${skill.description} (Kiro skill)`,
      input: { hint: "optional context passed to the skill" },
    });
  }

  return out;
}

/** How a parsed command should be handled. */
export type CommandPlan =
  | { kind: "intercept"; variant: string; args: Record<string, unknown>; command: string }
  | { kind: "forward" };

/**
 * Decides how to dispatch a command.
 *
 * `forward` is the default and the safe path: Kiro's prompt handler already
 * understands its own commands and its own skills, so unrecognised names are
 * simply passed along rather than rejected. That also means a command added by a
 * future Kiro release works without any change here.
 */
export function planCommand(parsed: ParsedCommand): CommandPlan {
  const spec = STATE_CHANGING_COMMANDS[parsed.name];
  if (!spec) return { kind: "forward" };

  // With no argument these commands open a picker in the TUI. There is no picker
  // over ACP, and Zed already provides a selector for each of them, so forward
  // the text and let Kiro print its list rather than executing a no-op.
  if (spec.argKey && parsed.args === "") return { kind: "forward" };

  const args: Record<string, unknown> = {};
  if (spec.argKey) args[spec.argKey] = parsed.args;
  return { kind: "intercept", variant: spec.variant, args, command: parsed.name };
}
