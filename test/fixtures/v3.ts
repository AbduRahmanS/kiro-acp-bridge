/**
 * CLI V3 payloads, structurally faithful to what kiro-cli 2.28.0 sent with
 * `acp --agent-engine v3 --auth-method=cli` (abbreviated, values as captured).
 */

export type Native = Record<string, unknown>;

const modeValue = (value: string, name: string, description: string, source = "bundled") => ({
  value,
  name,
  description,
  _meta: { kiro: { source, resource: { resourceType: "agent", source: { origin: source } } } },
});

const modelValue = (
  value: string,
  name: string,
  rateMultiplier: number,
  effort?: { levels: string[]; default: string },
) => ({
  value,
  name,
  description: `${name} model with 1M context window`,
  _meta: {
    kiro: {
      rateMultiplier,
      rateUnit: "Credit",
      hasEffort: !!effort,
      ...(effort
        ? { effortSchemaPath: "output_config", effortLevels: effort.levels, defaultEffortLevel: effort.default }
        : {}),
      thinkingToggleable: false,
    },
  },
});

export const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const LEVEL_NAMES: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "xHigh", max: "Max" };

export const MODELS: Record<string, { name: string; rate: number; effort?: { levels: string[]; default: string } }> = {
  auto: { name: "Auto", rate: 1 },
  "claude-opus-5.5": { name: "Claude Opus 5.5", rate: 2, effort: { levels: LEVELS, default: "medium" } },
  "claude-sonnet-5.5": { name: "Claude Sonnet 5.5", rate: 1.3, effort: { levels: LEVELS, default: "high" } },
  "narrow-model": { name: "Narrow Model", rate: 0.5, effort: { levels: ["low", "high"], default: "low" } },
};

/** Builds the full V3 option array for a given state, as Kiro would. */
export function v3Options(state: {
  mode?: string;
  model?: string;
  effort?: string | undefined;
  autopilot?: string;
}): Native[] {
  const mode = state.mode ?? "vibe";
  const model = state.model ?? "auto";
  const spec = MODELS[model];
  const out: Native[] = [
    {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: mode,
      options: [
        modeValue("vibe", "Default", "General coding assistance"),
        modeValue("spec", "Spec", "Structured feature development"),
        modeValue("plan", "Plan", "Plan-only mode"),
        modeValue("semantic_reviewer", "semantic_reviewer", "Behavioral code review"),
      ],
    },
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      // V3 really does echo an unknown id back here; see the validation tests.
      currentValue: model,
      options: Object.entries(MODELS).map(([id, m]) => modelValue(id, m.name, m.rate, m.effort)),
    },
  ];
  if (spec?.effort) {
    out.push({
      type: "select",
      id: "effortLevel",
      name: "Effort",
      category: "thought_level",
      currentValue: state.effort ?? spec.effort.default,
      options: spec.effort.levels.map((l) => ({ value: l, name: LEVEL_NAMES[l] ?? l })),
    });
  }
  out.push(
    {
      type: "select",
      id: "memoryReflection",
      name: "Memory reflection",
      description: "Allow this session to reflect on new memory",
      currentValue: "on",
      options: [
        { value: "on", name: "On" },
        { value: "off", name: "Off" },
      ],
    },
    {
      type: "select",
      id: "autopilot",
      name: "Autopilot",
      currentValue: state.autopilot ?? "on",
      options: [
        { value: "on", name: "Autopilot", description: "Agent executes tools without confirmation" },
        { value: "off", name: "Supervised", description: "Agent asks for approval before file changes" },
      ],
    },
  );
  return out;
}

export const V3_EXTENSION_METHODS = [
  "_kiro/knowledge",
  "_kiro/codeIntelligence",
  "_kiro/session/context",
  "_kiro/session/compact",
  "_kiro/session/export",
  "_kiro/session/history",
];

/** The `available_commands_update` V3 sent: steering files and subagents only. */
export const V3_KIRO_COMMANDS = [
  {
    name: "bug-fix",
    description: "Steering: bug-fix",
    input: { hint: "optional context" },
    _meta: { kiro: { type: "steering", commandId: "bug-fix" } },
  },
  {
    name: "context-gatherer",
    description: "Investigates the codebase to answer a specific question about it.",
    input: { hint: "task to delegate" },
    _meta: { kiro: { type: "custom-agent", commandId: "context-gatherer" } },
  },
  // A future V3 command that collides with a bridge command name.
  { name: "context", description: "Kiro's own context command" },
];
