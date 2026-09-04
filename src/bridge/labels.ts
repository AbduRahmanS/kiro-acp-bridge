/**
 * Turning Kiro's raw identifiers into readable selector labels.
 *
 * Kiro sends ids, not display names: `session/new` returns `name: "claude-opus-5"`
 * and agents arrive as `kiro_planner`. Zed shows these strings verbatim in its
 * pickers, so raw ids would read badly.
 *
 * The rules here are **generative, not a lookup table**. That is a hard
 * requirement: the brief forbids a hardcoded model list, and a new Kiro model
 * must get a sensible label on the day it ships without any code change. Only
 * genuinely orthographic knowledge is tabulated (acronym casing, and the handful
 * of Kiro-internal agent prefixes), never the model set itself.
 */

/** Tokens that should be fully upper-cased when they appear as a whole word. */
const ACRONYMS = new Set([
  "gpt",
  "ai",
  "cli",
  "llm",
  "api",
  "mcp",
  "aws",
  "id",
  "ui",
  "ide",
  "glm",
  "sdk",
]);

/** Kiro-internal prefixes stripped from agent ids before labelling. */
const AGENT_PREFIXES = ["kiro_", "kiro-"];

/** True when a token looks like a version or numeric component. */
function isVersionish(token: string): boolean {
  return /^v?\d/.test(token);
}

function capitalise(token: string): string {
  if (!token) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Formats a single token.
 *
 * Version-ish tokens are preserved verbatim so `5.6` and `4.5` survive intact,
 * and acronyms are upper-cased.
 */
function formatToken(token: string): string {
  const lower = token.toLowerCase();
  if (ACRONYMS.has(lower)) return lower.toUpperCase();
  if (isVersionish(token)) return token;
  return capitalise(lower);
}

/**
 * Humanises a model id.
 *
 * `claude-opus-5`  -> `Claude Opus 5`
 * `gpt-5.6-sol`    -> `GPT 5.6 Sol`
 * `auto`           -> `Auto`
 *
 * A token that begins a version run is joined to the preceding acronym with a
 * hyphen, so `gpt-5.6-sol` reads `GPT-5.6 Sol` rather than `GPT 5.6 Sol`, which
 * matches how these models are written in Kiro's own documentation.
 */
export function humaniseModelId(modelId: string): string {
  const tokens = modelId.split(/[-_\s]+/).filter(Boolean);
  if (tokens.length === 0) return modelId;

  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]!;
    const formatted = formatToken(raw);
    const prev = parts[parts.length - 1];
    // Attach a version directly to a preceding acronym: GPT + 5.6 -> GPT-5.6
    if (
      prev !== undefined &&
      isVersionish(raw) &&
      ACRONYMS.has(tokens[i - 1]!.toLowerCase())
    ) {
      parts[parts.length - 1] = `${prev}-${formatted}`;
      continue;
    }
    parts.push(formatted);
  }
  return parts.join(" ");
}

/**
 * Humanises an agent id.
 *
 * `kiro_default`        -> `Default`
 * `kiro_planner`        -> `Planner`
 * `kirocrew-research`   -> `Kirocrew Research`
 *
 * Kiro's own `kiro_` prefix is dropped because every built-in agent carries it,
 * so it adds no information in a selector where the agent vendor is already Kiro.
 */
export function humaniseAgentId(agentId: string): string {
  let id = agentId;
  for (const prefix of AGENT_PREFIXES) {
    if (id.toLowerCase().startsWith(prefix) && id.length > prefix.length) {
      id = id.slice(prefix.length);
      break;
    }
  }
  const tokens = id.split(/[-_\s]+/).filter(Boolean);
  if (tokens.length === 0) return agentId;
  return tokens.map(formatToken).join(" ");
}

/**
 * Humanises an effort level.
 *
 * `xhigh` -> `XHigh`, `none` -> `None`, everything else title-cased. `xhigh` is
 * special-cased because token splitting cannot recover the intended word break.
 */
export function humaniseEffort(level: string): string {
  const lower = level.toLowerCase();
  if (lower === "xhigh") return "XHigh";
  return capitalise(lower);
}

/**
 * Prefers a label Kiro supplied, falling back to a generated one.
 *
 * Kiro's `commands/options` sometimes carries a `label`, but in practice it is
 * the bare id. We use it only when it differs from the id, which is the signal
 * that Kiro actually had a display name to offer.
 */
export function preferSuppliedLabel(
  id: string,
  supplied: string | undefined,
  generate: (id: string) => string,
): string {
  if (supplied && supplied !== id) return supplied;
  return generate(id);
}
