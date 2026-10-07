/**
 * Config-option translation for the CLI V3 engine.
 *
 * V3 already speaks ACP config options natively, so — unlike `config.ts` — this
 * module does not invent state. It does three narrower things:
 *
 *  1. **Keeps the bridge's option ids stable.** Users reference `agent`, `model`
 *     and `effort` in Zed's `default_config_options`; V3 calls two of them `mode`
 *     and `effortLevel`. The roles are found by ACP *category* (`mode`, `model`,
 *     `thought_level`), falling back to the documented ids, so a rename on Kiro's
 *     side does not break anyone's settings.
 *  2. **Validates every change before it reaches Kiro.** Measured on 2.28: V3
 *     *accepts* an unknown model id and the session then has no usable model, and
 *     it silently ignores an unknown effort level. The bridge refuses both.
 *  3. **Keeps the effort contract the v2 path established**: a level the user
 *     chose survives a model switch when the new model supports it.
 *
 * Everything else Kiro advertises (memory reflection, autopilot, content
 * collection, and whatever future releases add) is passed through unchanged
 * apart from vendor `_meta`, so new V3 options reach Zed without code changes.
 */

import type * as schema from "@agentclientprotocol/sdk";
import {
  AGENT_OPTION_DESCRIPTION,
  CONFIG_IDS,
  EFFORT_OPTION_DESCRIPTION,
  groupOptions,
  InvalidConfigValueError,
  MODEL_OPTION_DESCRIPTION,
  UnknownConfigOptionError,
} from "./config.js";
import { humaniseAgentId, humaniseEffort, humaniseModelId, preferSuppliedLabel } from "./labels.js";
import { kiroMetaOf, v3ModeMetaSchema, v3ModelMetaSchema } from "../kiro/protocol-v3.js";

/** A config option as Kiro sent it. Loosely typed: it is untrusted input. */
export type NativeOption = Record<string, unknown>;

/** One selectable value of a native select option. */
export interface NativeValue {
  value: string;
  name?: string | undefined;
  description?: string | undefined;
  raw: Record<string, unknown>;
}

export type Role = "agent" | "model" | "effort";

const ROLE_CATEGORY: Record<Role, string> = { agent: "mode", model: "model", effort: "thought_level" };
const ROLE_FALLBACK_ID: Record<Role, string> = { agent: "mode", model: "model", effort: "effortLevel" };

/**
 * v2 agent ids that have a direct V3 counterpart.
 *
 * Only so existing Zed settings such as `"agent": "kiro_default"` keep working
 * after switching engine. Applied only when the target exists and the requested
 * value does not, so it can never shadow a real V3 mode.
 */
const V2_AGENT_ALIASES: Record<string, string> = { kiro_default: "vibe", kiro_planner: "plan" };

/**
 * The native option id the bridge's safety policy turns off on new sessions.
 *
 * V3 defaults it to `on`, which executes every tool without confirmation. The
 * v2 path always asked first, so a silent engine switch must not remove that.
 */
export const AUTOPILOT_OPTION_ID = "autopilot";
export const AUTOPILOT_SUPERVISED_VALUE = "off";

// ---------------------------------------------------------------------------
// Reading native options
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Flattened values of a select option, tolerating grouped and flat shapes. */
export function valuesOf(option: NativeOption | undefined): NativeValue[] {
  const raw = option?.options;
  if (!Array.isArray(raw)) return [];
  const out: NativeValue[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (Array.isArray(e.options)) {
      for (const inner of e.options) {
        if (inner && typeof inner === "object" && typeof (inner as Record<string, unknown>).value === "string") {
          const i = inner as Record<string, unknown>;
          out.push({ value: i.value as string, name: str(i.name), description: str(i.description), raw: i });
        }
      }
    } else if (typeof e.value === "string") {
      out.push({ value: e.value, name: str(e.name), description: str(e.description), raw: e });
    }
  }
  return out;
}

/** The native option that plays `role`, located by category and then by id. */
export function nativeFor(native: readonly NativeOption[], role: Role): NativeOption | undefined {
  return (
    native.find((o) => o.category === ROLE_CATEGORY[role]) ??
    native.find((o) => o.id === ROLE_FALLBACK_ID[role])
  );
}

/** Current value of the option playing `role`, if any. */
export function currentOf(native: readonly NativeOption[], role: Role): string | undefined {
  return str(nativeFor(native, role)?.currentValue);
}

/** Display name of a value of the option playing `role`. */
export function nameOf(native: readonly NativeOption[], role: Role, value: string | undefined): string {
  if (!value) return "";
  const v = valuesOf(nativeFor(native, role)).find((x) => x.value === value);
  const humanise = role === "model" ? humaniseModelId : role === "agent" ? humaniseAgentId : humaniseEffort;
  return preferSuppliedLabel(value, v?.name, humanise);
}

/** Bridge-facing id for a passthrough option; renamed only if it collides with a role id. */
function passthroughId(id: string): string {
  return (Object.values(CONFIG_IDS) as string[]).includes(id) ? `kiro_${id}` : id;
}

// ---------------------------------------------------------------------------
// Northbound: native -> what Zed sees
// ---------------------------------------------------------------------------

function creditGroup(raw: Record<string, unknown>): string | undefined {
  const meta = kiroMetaOf(raw, v3ModelMetaSchema);
  if (typeof meta?.rateMultiplier !== "number") return undefined;
  const unit = (meta.rateUnit ?? "Credit").toLowerCase();
  // Same wording the v2 engine uses, so the picker reads identically on both.
  return `${meta.rateMultiplier.toFixed(2)}x ${unit}s`;
}

const SOURCE_LABELS: Record<string, string> = {
  bundled: "Built-in",
  user: "Global",
  workspace: "Workspace",
};

function sourceGroup(raw: Record<string, unknown>): string | undefined {
  const source = kiroMetaOf(raw, v3ModeMetaSchema)?.source;
  if (!source) return undefined;
  return SOURCE_LABELS[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

/** Drops grouping when every value would land in the same single group. */
function onlyIfVaried<T extends { group?: string | undefined }>(entries: T[]): T[] {
  const groups = new Set(entries.map((e) => e.group));
  return groups.size > 1 ? entries : entries.map((e) => ({ ...e, group: undefined }));
}

function roleOption(
  option: NativeOption,
  id: string,
  name: string,
  description: string,
  category: string,
  entries: Array<{ value: string; name: string; description?: string | undefined; group?: string | undefined }>,
): schema.SessionConfigOption {
  return {
    id,
    name,
    description,
    category,
    type: "select",
    currentValue: str(option.currentValue) ?? entries[0]?.value ?? "",
    options: groupOptions(entries),
  } as schema.SessionConfigOption;
}

/** Strips vendor `_meta` from an option and its values, keeping everything else. */
function passthroughOption(option: NativeOption): schema.SessionConfigOption {
  const { _meta: _ignored, options, ...rest } = option;
  const out: Record<string, unknown> = { ...rest, id: passthroughId(String(option.id)) };
  if (Array.isArray(options)) {
    out.options = options.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const { _meta: _m, ...e } = entry as Record<string, unknown>;
      if (Array.isArray(e.options)) {
        e.options = e.options.map((inner) => {
          if (!inner || typeof inner !== "object") return inner;
          const { _meta: _mm, ...i } = inner as Record<string, unknown>;
          return i;
        });
      }
      return e;
    });
  }
  return out as unknown as schema.SessionConfigOption;
}

/**
 * Builds the option array Zed sees, in the order Agent, Model, Effort, then
 * whatever else Kiro advertised in Kiro's own order.
 */
export function buildV3ConfigOptions(native: readonly NativeOption[]): schema.SessionConfigOption[] {
  const agent = nativeFor(native, "agent");
  const model = nativeFor(native, "model");
  const effort = nativeFor(native, "effort");
  const out: schema.SessionConfigOption[] = [];

  if (agent) {
    out.push(
      roleOption(
        agent,
        CONFIG_IDS.agent,
        "Agent",
        AGENT_OPTION_DESCRIPTION,
        "mode",
        onlyIfVaried(
          valuesOf(agent).map((v) => ({
            value: v.value,
            name: preferSuppliedLabel(v.value, v.name, humaniseAgentId),
            description: v.description,
            group: sourceGroup(v.raw),
          })),
        ),
      ),
    );
  }
  if (model) {
    out.push(
      roleOption(
        model,
        CONFIG_IDS.model,
        "Model",
        MODEL_OPTION_DESCRIPTION,
        "model",
        valuesOf(model).map((v) => ({
          value: v.value,
          name: preferSuppliedLabel(v.value, v.name, humaniseModelId),
          description: v.description,
          group: creditGroup(v.raw),
        })),
      ),
    );
  }
  if (effort && valuesOf(effort).length > 0) {
    out.push(
      roleOption(
        effort,
        CONFIG_IDS.effort,
        "Effort",
        EFFORT_OPTION_DESCRIPTION,
        "thought_level",
        valuesOf(effort).map((v) => ({
          value: v.value,
          name: preferSuppliedLabel(v.value, v.name, humaniseEffort),
        })),
      ),
    );
  }
  for (const o of native) {
    if (o === agent || o === model || o === effort) continue;
    if (typeof o.id !== "string") continue;
    out.push(passthroughOption(o));
  }
  return out;
}

/** Legacy `SessionModeState`, mirrored from the native mode option. */
export function buildV3ModeState(native: readonly NativeOption[]): schema.SessionModeState | undefined {
  const agent = nativeFor(native, "agent");
  const current = str(agent?.currentValue);
  const values = valuesOf(agent);
  if (!current || values.length === 0) return undefined;
  return {
    currentModeId: current as schema.SessionModeId,
    availableModes: values.map((v) => ({
      id: v.value as schema.SessionModeId,
      name: preferSuppliedLabel(v.value, v.name, humaniseAgentId),
      ...(v.description ? { description: v.description } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Southbound: a change from Zed -> a validated native change
// ---------------------------------------------------------------------------

export interface NativeChange {
  /** Native option id to send to Kiro. */
  nativeId: string;
  value: string | boolean;
  /** Set when the change targets one of the three role options. */
  role?: Role;
}

/**
 * Resolves and validates a change requested with a bridge-facing id.
 *
 * Throws {@link UnknownConfigOptionError} or {@link InvalidConfigValueError},
 * which the bridge maps to `-32602`. Nothing invalid is ever forwarded, because
 * V3 would accept a bogus model and break the session.
 */
export function resolveV3Change(
  native: readonly NativeOption[],
  configId: string,
  value: string | boolean,
): NativeChange {
  const role = (Object.entries(CONFIG_IDS).find(([, id]) => id === configId)?.[0] ?? undefined) as Role | undefined;

  if (role) {
    const option = nativeFor(native, role);
    const values = valuesOf(option).map((v) => v.value);
    if (!option || typeof option.id !== "string") {
      // No effort axis for this model is a bad value, not an unknown option.
      if (role === "effort") throw new InvalidConfigValueError(configId, String(value), []);
      throw new UnknownConfigOptionError(configId);
    }
    if (typeof value !== "string") throw new InvalidConfigValueError(configId, String(value), values);
    let resolved = value;
    if (!values.includes(resolved) && role === "agent") {
      const alias = V2_AGENT_ALIASES[resolved];
      if (alias && values.includes(alias)) resolved = alias;
    }
    if (!values.includes(resolved)) throw new InvalidConfigValueError(configId, value, values);
    return { nativeId: option.id, value: resolved, role };
  }

  const option = native.find((o) => typeof o.id === "string" && passthroughId(o.id) === configId);
  if (!option || typeof option.id !== "string") throw new UnknownConfigOptionError(configId);
  if (option.type === "boolean") {
    if (typeof value !== "boolean") throw new InvalidConfigValueError(configId, String(value), ["true", "false"]);
    return { nativeId: option.id, value };
  }
  const values = valuesOf(option).map((v) => v.value);
  if (typeof value !== "string" || !values.includes(value)) {
    throw new InvalidConfigValueError(configId, String(value), values);
  }
  return { nativeId: option.id, value };
}

// ---------------------------------------------------------------------------
// Effort across a model switch
// ---------------------------------------------------------------------------

export interface EffortDecision {
  /** Level to re-apply to Kiro so the user's choice survives the switch. */
  reapply?: string;
  /** Message for the thread when the choice could not be kept. */
  notice?: string;
  /** Whether the resulting effort still reflects an explicit user choice. */
  explicit: boolean;
}

/**
 * Decides what happens to effort after the model changed.
 *
 * `after` is the native state Kiro reported once the switch landed; V3 has
 * already reset effort to the new model's own default at that point.
 */
export function effortAfterModelSwitch(
  before: { level: string | undefined; explicit: boolean },
  after: readonly NativeOption[],
): EffortDecision {
  const modelName = nameOf(after, "model", currentOf(after, "model"));
  const levels = valuesOf(nativeFor(after, "effort")).map((v) => v.value);
  const now = currentOf(after, "effort");

  if (levels.length === 0) {
    return before.level
      ? {
          explicit: false,
          notice: `Effort is not configurable for ${modelName}; the effort selector is hidden for this model.`,
        }
      : { explicit: false };
  }
  if (!before.explicit || !before.level) return { explicit: false };
  if (!levels.includes(before.level)) {
    return {
      explicit: false,
      notice:
        `Effort **${humaniseEffort(before.level)}** is not available for ${modelName}; ` +
        `switched to **${nameOf(after, "effort", now)}**.`,
    };
  }
  return before.level === now ? { explicit: true } : { explicit: true, reapply: before.level };
}

// ---------------------------------------------------------------------------
// Matching free-text command arguments
// ---------------------------------------------------------------------------

/**
 * Matches `/model sonnet`-style input against the values of a role.
 *
 * Exact id first, then a case-insensitive id or display name, then a unique
 * prefix. Ambiguity is reported rather than guessed, because picking the wrong
 * model has a cost.
 */
export function matchValue(
  native: readonly NativeOption[],
  role: Role,
  input: string,
): { match?: string; candidates: string[] } {
  const values = valuesOf(nativeFor(native, role));
  const ids = values.map((v) => v.value);
  const needle = input.trim().toLowerCase();
  if (ids.includes(input.trim())) return { match: input.trim(), candidates: [] };

  const exact = values.filter(
    (v) => v.value.toLowerCase() === needle || (v.name ?? "").toLowerCase() === needle,
  );
  if (exact.length === 1) return { match: exact[0]!.value, candidates: [] };

  if (role === "agent") {
    const alias = V2_AGENT_ALIASES[needle];
    if (alias && ids.includes(alias)) return { match: alias, candidates: [] };
  }

  const prefix = values.filter(
    (v) => v.value.toLowerCase().startsWith(needle) || (v.name ?? "").toLowerCase().startsWith(needle),
  );
  if (prefix.length === 1) return { match: prefix[0]!.value, candidates: [] };
  return { candidates: (prefix.length > 1 ? prefix : values).map((v) => v.value) };
}
