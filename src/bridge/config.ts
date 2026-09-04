/**
 * Translation between Kiro's legacy selection APIs and ACP Session Config
 * Options — the core of what this bridge exists to do.
 *
 * The mismatch, verified on the wire:
 *
 *   Kiro 2.21.0 returns `models: {currentModelId, availableModels}` from
 *   `session/new` and implements `session/set_model`. It answers
 *   `session/set_config_option` with -32601 Method not found.
 *
 *   Current Zed removed `session/set_model` (PR #58308) and drives everything
 *   through `session/set_config_option` + `configOptions`. Its
 *   `model_selector()` returns None for all external ACP agents.
 *
 * So neither side is broken and neither side can see the other. This module is
 * the adapter: three ACP config options northbound, three different Kiro
 * mechanisms southbound.
 *
 *   | ACP config option        | category       | Kiro mechanism                      |
 *   |-------------------------|----------------|-------------------------------------|
 *   | `agent`                 | mode           | session/set_mode                    |
 *   | `model`                 | model          | session/set_model                   |
 *   | `effort`                | thought_level  | commands/execute {effort, level}    |
 *
 * Discovery for all three goes through `_kiro.dev/commands/options`, which is
 * also the only mechanism that reports which value is currently active (via an
 * `[active]` marker in the description) and the credit multiplier (in `group`).
 */

import type * as schema from "@agentclientprotocol/sdk";
import type { KiroConnection } from "../kiro/connection.js";
import { isActiveOption, stripActiveMarker, type KiroOption } from "../kiro/protocol.js";
import { humaniseAgentId, humaniseEffort, humaniseModelId, preferSuppliedLabel } from "./labels.js";
import type { BridgeSession } from "./session.js";

/** Stable config option ids. These appear in Zed's settings, so treat as API. */
export const CONFIG_IDS = {
  agent: "agent",
  model: "model",
  effort: "effort",
} as const;

export type ConfigId = (typeof CONFIG_IDS)[keyof typeof CONFIG_IDS];

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Refreshes the model roster and which model is active.
 *
 * `commands/options {model}` is preferred over the `models` block from
 * `session/new` because it is the only source of the credit multiplier and the
 * active marker. The `session/new` block remains the seed so a session has state
 * before the first refresh completes.
 */
export async function refreshModels(kiro: KiroConnection, session: BridgeSession): Promise<void> {
  const options = await kiro.commandOptions(session.sessionId, "model");
  if (options.length === 0) return;

  session.models.availableModels = options.map((o) => ({
    modelId: o.value,
    name: o.label ?? o.value,
    description: stripActiveMarker(o.description),
  }));
  session.models.creditGroups.clear();
  for (const o of options) {
    if (o.group) session.models.creditGroups.set(o.value, o.group);
  }
  const active = options.find(isActiveOption);
  if (active) session.models.currentModelId = active.value;
}

/**
 * Refreshes per-model context windows.
 *
 * Only `/model` with no argument reports `contextWindow`, and it is needed to
 * populate ACP's `usage_update.size`. Cached for the session's lifetime because
 * a model's context window does not change underneath us.
 */
export async function refreshContextWindows(
  kiro: KiroConnection,
  session: BridgeSession,
): Promise<void> {
  if (session.models.contextWindows.size > 0) return;
  const list = await kiro.modelList(session.sessionId);
  for (const m of list?.models ?? []) {
    if (m.contextWindow) session.models.contextWindows.set(m.id, m.contextWindow);
  }
}

/** Refreshes the agent roster and which agent is active. */
export async function refreshAgents(kiro: KiroConnection, session: BridgeSession): Promise<void> {
  const options = await kiro.commandOptions(session.sessionId, "agent");
  if (options.length === 0) return;

  session.agents.availableAgents = options.map((o) => ({
    id: o.value,
    name: o.label ?? o.value,
    description: stripActiveMarker(o.description),
  }));
  session.agents.groups.clear();
  for (const o of options) {
    if (o.group) session.agents.groups.set(o.value, o.group);
  }
  const active = options.find(isActiveOption);
  if (active) session.agents.currentAgentId = active.value;
}

/**
 * Refreshes the valid effort levels for the **currently active model**.
 *
 * This is the crux of the dynamic-effort requirement. Measured behaviour:
 *
 *   claude-opus-5    -> [low, medium, high, xhigh, max]
 *   gpt-5.6-sol      -> [none, low, medium, high, xhigh, max]
 *   claude-sonnet-5  -> [low, medium, high, xhigh, max]
 *   auto             -> []                        (no effort axis at all)
 *
 * An empty list is meaningful, not an error: the option must then be withdrawn
 * from Zed entirely rather than shown empty.
 */
export async function refreshEffort(kiro: KiroConnection, session: BridgeSession): Promise<void> {
  const options = await kiro.commandOptions(session.sessionId, "effort");
  session.effort.available = options.map((o) => o.value);

  if (session.effort.available.length === 0) {
    session.effort.current = undefined;
    return;
  }

  const active = options.find(isActiveOption);
  if (active) {
    session.effort.current = active.value;
    return;
  }
  // Kiro does not mark the active effort. Keep the current value when it is
  // still valid; otherwise fall back to Kiro's own default.
  if (session.effort.current && session.effort.available.includes(session.effort.current)) return;
  session.effort.current = defaultEffortFor(session.effort.available);
}

/**
 * Kiro's default effort.
 *
 * Kiro documents `high` as the default for models that expose effort, so prefer
 * it, then degrade predictably rather than guessing.
 */
export function defaultEffortFor(available: readonly string[]): string | undefined {
  for (const preferred of ["high", "medium", "low"]) {
    if (available.includes(preferred)) return preferred;
  }
  return available[0];
}

/** Refreshes everything, in the order dependencies require. */
export async function refreshAll(kiro: KiroConnection, session: BridgeSession): Promise<void> {
  // Models and agents are independent; effort depends on the active model, so it
  // must be read after the model roster is known.
  await Promise.all([
    refreshModels(kiro, session).catch(() => undefined),
    refreshAgents(kiro, session).catch(() => undefined),
    refreshContextWindows(kiro, session).catch(() => undefined),
  ]);
  await refreshEffort(kiro, session).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Building ACP config options
// ---------------------------------------------------------------------------

/** Groups Kiro options by their `group` label, preserving encounter order. */
function groupOptions(
  entries: Array<{ value: string; name: string; description?: string | undefined; group?: string | undefined }>,
): schema.SessionConfigSelectOption[] | schema.SessionConfigSelectGroup[] {
  const anyGrouped = entries.some((e) => e.group);
  if (!anyGrouped) {
    return entries.map((e) => ({
      value: e.value,
      name: e.name,
      ...(e.description ? { description: e.description } : {}),
    })) as schema.SessionConfigSelectOption[];
  }

  const groups = new Map<string, schema.SessionConfigSelectOption[]>();
  for (const e of entries) {
    const key = e.group ?? "Other";
    const list = groups.get(key) ?? [];
    list.push({
      value: e.value,
      name: e.name,
      ...(e.description ? { description: e.description } : {}),
    } as schema.SessionConfigSelectOption);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([group, options]) => ({
    group,
    name: group,
    options,
  })) as schema.SessionConfigSelectGroup[];
}

/**
 * Builds the full ACP config option array for a session.
 *
 * Order matters for presentation: Zed renders them in array order, and the
 * target UX is Agent, then Model, then Effort.
 */
export function buildConfigOptions(session: BridgeSession): schema.SessionConfigOption[] {
  const options: schema.SessionConfigOption[] = [];

  // --- Agent (ACP category `mode`) ---
  if (session.agents.availableAgents.length > 0 && session.agents.currentAgentId) {
    options.push({
      id: CONFIG_IDS.agent,
      name: "Agent",
      description: "Which Kiro agent handles this session",
      category: "mode",
      type: "select",
      currentValue: session.agents.currentAgentId,
      options: groupOptions(
        session.agents.availableAgents.map((a) => ({
          value: a.id,
          name: preferSuppliedLabel(a.id, a.name, humaniseAgentId),
          description: a.description,
          group: session.agents.groups.get(a.id),
        })),
      ),
    } as schema.SessionConfigOption);
  }

  // --- Model (ACP category `model`) ---
  if (session.models.availableModels.length > 0 && session.models.currentModelId) {
    options.push({
      id: CONFIG_IDS.model,
      name: "Model",
      description: "Which model Kiro uses for this session",
      category: "model",
      type: "select",
      currentValue: session.models.currentModelId,
      options: groupOptions(
        session.models.availableModels.map((m) => ({
          value: m.modelId,
          name: preferSuppliedLabel(m.modelId, m.name, humaniseModelId),
          description: m.description,
          // Kiro puts the credit multiplier here, e.g. "2.20x credits", which
          // makes the cost of each model visible at the point of choosing it.
          group: session.models.creditGroups.get(m.modelId),
        })),
      ),
    } as schema.SessionConfigOption);
  }

  // --- Effort (ACP category `thought_level`) ---
  // Withheld entirely when the active model has no effort axis (e.g. `auto`),
  // rather than shown as an empty picker.
  if (session.effort.available.length > 0 && session.effort.current) {
    options.push({
      id: CONFIG_IDS.effort,
      name: "Effort",
      description: "How much reasoning effort the model should spend",
      category: "thought_level",
      type: "select",
      currentValue: session.effort.current,
      options: session.effort.available.map((level) => ({
        value: level,
        name: humaniseEffort(level),
      })),
    } as schema.SessionConfigOption);
  }

  return options;
}

// ---------------------------------------------------------------------------
// Applying a change from Zed
// ---------------------------------------------------------------------------

export interface ApplyResult {
  /** True when the change altered state and Zed should be told. */
  changed: boolean;
  /** A human-readable note worth surfacing in the thread, if any. */
  notice?: string;
}

/**
 * Applies a `session/set_config_option` from Zed to Kiro.
 *
 * Returns without touching Kiro when the value is already current, so repeated
 * selections do not generate redundant work.
 */
export async function applyConfigOption(
  kiro: KiroConnection,
  session: BridgeSession,
  configId: string,
  value: string,
): Promise<ApplyResult> {
  switch (configId) {
    case CONFIG_IDS.model:
      return await applyModel(kiro, session, value);
    case CONFIG_IDS.effort:
      return await applyEffort(kiro, session, value);
    case CONFIG_IDS.agent:
      return await applyAgent(kiro, session, value);
    default:
      throw new UnknownConfigOptionError(configId);
  }
}

export class UnknownConfigOptionError extends Error {
  constructor(configId: string) {
    super(`Unknown config option '${configId}'`);
    this.name = "UnknownConfigOptionError";
  }
}

export class InvalidConfigValueError extends Error {
  constructor(configId: string, value: string, valid: readonly string[]) {
    super(
      `'${value}' is not a valid value for '${configId}'. Valid values: ${valid.join(", ") || "(none)"}`,
    );
    this.name = "InvalidConfigValueError";
  }
}

/**
 * Switches model, then reconciles effort.
 *
 * The reconciliation is the subtle part. Different models expose different effort
 * sets, so after a switch the previously selected level may no longer exist. The
 * required behaviour is: keep it if still valid, otherwise take Kiro's default,
 * and if the new model has no effort axis at all, drop the option.
 */
async function applyModel(
  kiro: KiroConnection,
  session: BridgeSession,
  modelId: string,
): Promise<ApplyResult> {
  const valid = session.models.availableModels.map((m) => m.modelId);
  if (valid.length > 0 && !valid.includes(modelId)) {
    throw new InvalidConfigValueError(CONFIG_IDS.model, modelId, valid);
  }
  if (session.models.currentModelId === modelId) return { changed: false };

  const previousEffort = session.effort.current;
  await kiro.setModel(session.sessionId, modelId);
  session.models.currentModelId = modelId;
  session.bumpGeneration();

  // Re-read the effort axis for the new model.
  await refreshEffort(kiro, session);

  let notice: string | undefined;
  if (previousEffort && session.effort.available.length === 0) {
    notice = `Effort is not configurable for ${humaniseModelId(modelId)}; the effort selector is hidden for this model.`;
  } else if (
    previousEffort &&
    session.effort.available.length > 0 &&
    !session.effort.available.includes(previousEffort)
  ) {
    notice =
      `Effort **${humaniseEffort(previousEffort)}** is not available for ${humaniseModelId(modelId)}; ` +
      `switched to **${humaniseEffort(session.effort.current ?? "")}**.`;
  }

  return notice ? { changed: true, notice } : { changed: true };
}

/** Sets the reasoning effort level via Kiro's `/effort` command. */
async function applyEffort(
  kiro: KiroConnection,
  session: BridgeSession,
  level: string,
): Promise<ApplyResult> {
  if (!session.effort.available.includes(level)) {
    throw new InvalidConfigValueError(CONFIG_IDS.effort, level, session.effort.available);
  }
  if (session.effort.current === level) return { changed: false };

  // There is no `session/set_effort`; effort is only reachable as a command.
  const res = await kiro.execute(session.sessionId, "effort", { level });
  if (res.success === false) {
    throw new InvalidConfigValueError(CONFIG_IDS.effort, level, session.effort.available);
  }
  session.effort.current = level;
  session.bumpGeneration();
  return { changed: true };
}

/**
 * Switches the active Kiro agent.
 *
 * Kiro calls agents "modes" over ACP, so this maps to `session/set_mode`. Note
 * that Plan is an agent (`kiro_planner`), not a separate mode dimension — `/plan`
 * reports "Agent changed to kiro_planner".
 */
async function applyAgent(
  kiro: KiroConnection,
  session: BridgeSession,
  agentId: string,
): Promise<ApplyResult> {
  const valid = session.agents.availableAgents.map((a) => a.id);
  if (valid.length > 0 && !valid.includes(agentId)) {
    throw new InvalidConfigValueError(CONFIG_IDS.agent, agentId, valid);
  }
  if (session.agents.currentAgentId === agentId) return { changed: false };

  await kiro.setMode(session.sessionId, agentId);
  session.agents.currentAgentId = agentId;
  session.bumpGeneration();

  // Switching agent can change the model, because a Kiro agent config may pin
  // one. Re-read model and effort so the selectors cannot drift.
  await refreshModels(kiro, session).catch(() => undefined);
  await refreshEffort(kiro, session).catch(() => undefined);

  return { changed: true };
}

/**
 * Mirrors the agent option into legacy `SessionModeState`.
 *
 * Zed ignores `modes` when `configOptions` is present, but the ACP spec asks
 * agents to offer both during the transition, and it costs nothing to keep older
 * clients working.
 */
export function buildModeState(session: BridgeSession): schema.SessionModeState | undefined {
  if (!session.agents.currentAgentId || session.agents.availableAgents.length === 0) {
    return undefined;
  }
  return {
    currentModeId: session.agents.currentAgentId as schema.SessionModeId,
    availableModes: session.agents.availableAgents.map((a) => ({
      id: a.id as schema.SessionModeId,
      name: preferSuppliedLabel(a.id, a.name, humaniseAgentId),
      ...(a.description ? { description: a.description } : {}),
    })),
  };
}
