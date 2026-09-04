import { describe, expect, it, beforeEach } from "vitest";
import {
  applyConfigOption,
  buildConfigOptions,
  buildModeState,
  CONFIG_IDS,
  defaultEffortFor,
  InvalidConfigValueError,
  refreshAll,
  refreshEffort,
  UnknownConfigOptionError,
} from "../src/bridge/config.js";
import { BridgeSession } from "../src/bridge/session.js";
import type { KiroOption } from "../src/kiro/protocol.js";

/**
 * A fake Kiro that replays the option payloads captured from kiro-cli 2.21.0,
 * including the real per-model effort sets. This is what lets us test the
 * model/effort interaction without spending credits.
 */
class FakeKiro {
  model = "claude-opus-5";
  agent = "kiro_default";
  effort: string | undefined = "high";
  calls: string[] = [];
  failEffort = false;

  /** Measured from the real CLI. Note `auto` has NO effort axis. */
  static EFFORTS: Record<string, string[]> = {
    "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
    "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
    "gpt-5.6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
    "gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
    auto: [],
  };

  static MODELS: Array<[string, string, string]> = [
    ["auto", "Models chosen by task for optimal usage and consistent quality", "1.00x credits"],
    ["claude-opus-5", "Claude Opus 5 model with 1M context window", "2.20x credits"],
    ["claude-sonnet-5", "Claude Sonnet 5 model with 1M context window", "1.30x credits"],
    ["gpt-5.6-sol", "Experimental preview of OpenAI GPT 5.6 Sol with 272k context window", "2.40x credits"],
    ["gpt-5.6-luna", "Experimental preview of OpenAI GPT 5.6 Luna with 272k context window", "0.10x credits"],
  ];

  static AGENTS: Array<[string, string, string]> = [
    ["kiro_default", "The default agent for Kiro CLI", "Built-in"],
    ["kiro_planner", "Specialized planning agent", "Built-in"],
    ["kiro_guide", "Guide agent that answers questions about Kiro CLI features", "Built-in"],
    ["kirocrew-research", "Autonomous research worker", "Local"],
  ];

  async commandOptions(_sessionId: string, command: string): Promise<KiroOption[]> {
    this.calls.push(`options:${command}`);
    if (command === "model") {
      return FakeKiro.MODELS.map(([value, description, group]) => ({
        value,
        label: value,
        description: value === this.model ? `${description} [active]` : description,
        group,
      }));
    }
    if (command === "agent") {
      return FakeKiro.AGENTS.map(([value, description, group]) => ({
        value,
        label: value,
        description: value === this.agent ? `${description} [active]` : description,
        group,
      }));
    }
    if (command === "effort") {
      // Kiro does NOT mark the active effort level; only the list is returned.
      return (FakeKiro.EFFORTS[this.model] ?? []).map((value) => ({ value, label: value }));
    }
    return [];
  }

  async setModel(_sessionId: string, modelId: string): Promise<void> {
    this.calls.push(`setModel:${modelId}`);
    this.model = modelId;
  }

  async setMode(_sessionId: string, modeId: string): Promise<void> {
    this.calls.push(`setMode:${modeId}`);
    this.agent = modeId;
  }

  async execute(_sessionId: string, command: string, args: Record<string, unknown> = {}) {
    this.calls.push(`execute:${command}:${JSON.stringify(args)}`);
    if (command === "effort") {
      if (this.failEffort) return { success: false, message: "nope" };
      this.effort = args.level as string;
      return { success: true, message: `Effort set to ${args.level}` };
    }
    return { success: true };
  }

  async modelList() {
    this.calls.push("modelList");
    return {
      models: [
        { id: "auto", contextWindow: 1000000 },
        { id: "claude-opus-5", contextWindow: 1000000 },
        { id: "claude-sonnet-5", contextWindow: 1000000 },
        { id: "gpt-5.6-sol", contextWindow: 272000 },
        { id: "gpt-5.6-luna", contextWindow: 272000 },
      ],
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asKiro = (f: FakeKiro) => f as any;

let kiro: FakeKiro;
let session: BridgeSession;

beforeEach(async () => {
  kiro = new FakeKiro();
  session = new BridgeSession("sess-1", "/work");
  await refreshAll(asKiro(kiro), session);
});

describe("refreshAll", () => {
  it("discovers models with credit multipliers", () => {
    expect(session.models.availableModels.map((m) => m.modelId)).toEqual([
      "auto",
      "claude-opus-5",
      "claude-sonnet-5",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
    ]);
    expect(session.models.creditGroups.get("claude-opus-5")).toBe("2.20x credits");
  });

  it("detects the active model from the [active] marker", () => {
    expect(session.models.currentModelId).toBe("claude-opus-5");
  });

  it("strips the [active] marker from descriptions shown to the user", () => {
    const opus = session.models.availableModels.find((m) => m.modelId === "claude-opus-5");
    expect(opus!.description).not.toContain("[active]");
    expect(opus!.description).toContain("Claude Opus 5 model");
  });

  it("discovers agents with their provenance group", () => {
    expect(session.agents.currentAgentId).toBe("kiro_default");
    expect(session.agents.groups.get("kirocrew-research")).toBe("Local");
  });

  it("caches per-model context windows for usage reporting", () => {
    expect(session.models.contextWindows.get("gpt-5.6-sol")).toBe(272000);
    expect(session.activeContextWindow()).toBe(1000000);
  });
});

describe("buildConfigOptions", () => {
  it("emits agent, model and effort in the target UX order", () => {
    const opts = buildConfigOptions(session);
    expect(opts.map((o) => o.id)).toEqual([CONFIG_IDS.agent, CONFIG_IDS.model, CONFIG_IDS.effort]);
  });

  it("uses the ACP categories Zed renders as dedicated selectors", () => {
    const byId = new Map(buildConfigOptions(session).map((o) => [o.id, o]));
    expect(byId.get("agent")!.category).toBe("mode");
    expect(byId.get("model")!.category).toBe("model");
    // thought_level is what gives Zed its "Change Thinking Effort" control.
    expect(byId.get("effort")!.category).toBe("thought_level");
  });

  it("marks every option as a select with the active value", () => {
    for (const o of buildConfigOptions(session)) {
      expect(o.type).toBe("select");
    }
    const model = buildConfigOptions(session).find((o) => o.id === "model") as never as {
      currentValue: string;
    };
    expect(model.currentValue).toBe("claude-opus-5");
  });

  it("groups models by credit multiplier so cost is visible when choosing", () => {
    const model = buildConfigOptions(session).find((o) => o.id === "model") as never as {
      options: Array<{ group?: string; options?: unknown[] }>;
    };
    const groups = model.options.map((g) => g.group);
    expect(groups).toContain("2.20x credits");
    expect(groups).toContain("0.10x credits");
  });

  it("humanises labels without a hardcoded model table", () => {
    const model = buildConfigOptions(session).find((o) => o.id === "model") as never as {
      options: Array<{ options: Array<{ value: string; name: string }> }>;
    };
    const names = new Map(model.options.flatMap((g) => g.options).map((o) => [o.value, o.name]));
    expect(names.get("claude-opus-5")).toBe("Claude Opus 5");
    expect(names.get("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(names.get("auto")).toBe("Auto");
  });

  it("humanises agent ids by dropping Kiro's internal prefix", () => {
    const agent = buildConfigOptions(session).find((o) => o.id === "agent") as never as {
      options: Array<{ options: Array<{ value: string; name: string }> }>;
    };
    const names = new Map(agent.options.flatMap((g) => g.options).map((o) => [o.value, o.name]));
    expect(names.get("kiro_default")).toBe("Default");
    expect(names.get("kiro_planner")).toBe("Planner");
  });
});

describe("model switching invalidates effort — the critical interaction", () => {
  it("preserves the effort level when the new model still supports it", async () => {
    session.effort.current = "max";
    const res = await applyConfigOption(asKiro(kiro), session, "model", "gpt-5.6-sol");
    expect(res.changed).toBe(true);
    expect(session.models.currentModelId).toBe("gpt-5.6-sol");
    expect(session.effort.current).toBe("max");
    expect(res.notice).toBeUndefined();
  });

  it("exposes `none` for GPT models but not for Claude", async () => {
    expect(session.effort.available).not.toContain("none");
    await applyConfigOption(asKiro(kiro), session, "model", "gpt-5.6-sol");
    expect(session.effort.available).toContain("none");
  });

  it("withdraws the effort option entirely for `auto`, which has no effort axis", async () => {
    const res = await applyConfigOption(asKiro(kiro), session, "model", "auto");
    expect(session.effort.available).toEqual([]);
    expect(session.effort.current).toBeUndefined();
    const ids = buildConfigOptions(session).map((o) => o.id);
    expect(ids).not.toContain(CONFIG_IDS.effort);
    // The user must be told, not silently stripped of a control.
    expect(res.notice).toContain("not configurable");
  });

  it("restores the effort option when moving back to a model that has one", async () => {
    await applyConfigOption(asKiro(kiro), session, "model", "auto");
    expect(buildConfigOptions(session).map((o) => o.id)).not.toContain("effort");
    await applyConfigOption(asKiro(kiro), session, "model", "claude-opus-5");
    expect(buildConfigOptions(session).map((o) => o.id)).toContain("effort");
    expect(session.effort.current).toBe("high");
  });

  it("falls back to Kiro's default when the level is invalid for the new model", async () => {
    // Contrive a model whose effort set omits the current selection.
    session.effort.current = "xhigh";
    FakeKiro.EFFORTS["narrow-model"] = ["low", "high"];
    FakeKiro.MODELS.push(["narrow-model", "A model with few levels", "1.00x credits"]);
    await refreshAll(asKiro(kiro), session);

    const res = await applyConfigOption(asKiro(kiro), session, "model", "narrow-model");
    expect(session.effort.current).toBe("high");
    expect(res.notice).toContain("not available");

    FakeKiro.MODELS.pop();
    delete FakeKiro.EFFORTS["narrow-model"];
  });

  it("does not call Kiro when the model is already selected", async () => {
    kiro.calls = [];
    const res = await applyConfigOption(asKiro(kiro), session, "model", "claude-opus-5");
    expect(res.changed).toBe(false);
    expect(kiro.calls.filter((c) => c.startsWith("setModel"))).toEqual([]);
  });

  it("rejects an unknown model rather than switching silently", async () => {
    await expect(
      applyConfigOption(asKiro(kiro), session, "model", "no-such-model"),
    ).rejects.toBeInstanceOf(InvalidConfigValueError);
    expect(session.models.currentModelId).toBe("claude-opus-5");
  });
});

describe("effort option", () => {
  it("applies a valid level through Kiro's /effort command", async () => {
    const res = await applyConfigOption(asKiro(kiro), session, "effort", "max");
    expect(res.changed).toBe(true);
    expect(session.effort.current).toBe("max");
    expect(kiro.calls).toContain('execute:effort:{"level":"max"}');
  });

  it("rejects a level the active model does not support", async () => {
    // `none` is a GPT-only level; the active model is Claude.
    await expect(
      applyConfigOption(asKiro(kiro), session, "effort", "none"),
    ).rejects.toBeInstanceOf(InvalidConfigValueError);
  });

  it("surfaces a Kiro-side failure rather than reporting success", async () => {
    kiro.failEffort = true;
    await expect(
      applyConfigOption(asKiro(kiro), session, "effort", "max"),
    ).rejects.toBeInstanceOf(InvalidConfigValueError);
  });

  it("is a no-op when already at that level", async () => {
    kiro.calls = [];
    const res = await applyConfigOption(asKiro(kiro), session, "effort", "high");
    expect(res.changed).toBe(false);
    expect(kiro.calls).toEqual([]);
  });
});

describe("agent option", () => {
  it("switches agent via session/set_mode", async () => {
    const res = await applyConfigOption(asKiro(kiro), session, "agent", "kiro_planner");
    expect(res.changed).toBe(true);
    expect(kiro.calls).toContain("setMode:kiro_planner");
    expect(session.agents.currentAgentId).toBe("kiro_planner");
  });

  it("re-reads model and effort after an agent switch, since agents may pin a model", async () => {
    kiro.calls = [];
    await applyConfigOption(asKiro(kiro), session, "agent", "kiro_planner");
    expect(kiro.calls).toContain("options:model");
    expect(kiro.calls).toContain("options:effort");
  });

  it("rejects an unknown agent", async () => {
    await expect(
      applyConfigOption(asKiro(kiro), session, "agent", "nope"),
    ).rejects.toBeInstanceOf(InvalidConfigValueError);
  });
});

describe("unknown config ids", () => {
  it("throws rather than silently ignoring", async () => {
    await expect(
      applyConfigOption(asKiro(kiro), session, "colour", "blue"),
    ).rejects.toBeInstanceOf(UnknownConfigOptionError);
  });
});

describe("defaultEffortFor", () => {
  it("prefers high, which is Kiro's documented default", () => {
    expect(defaultEffortFor(["low", "medium", "high", "max"])).toBe("high");
  });
  it("degrades predictably", () => {
    expect(defaultEffortFor(["low", "medium"])).toBe("medium");
    expect(defaultEffortFor(["none", "low"])).toBe("low");
    expect(defaultEffortFor(["only"])).toBe("only");
  });
  it("returns undefined for an empty axis", () => {
    expect(defaultEffortFor([])).toBeUndefined();
  });
});

describe("buildModeState — legacy mirror", () => {
  it("mirrors agents into SessionModeState for pre-configOptions clients", () => {
    const modes = buildModeState(session)!;
    expect(modes.currentModeId).toBe("kiro_default");
    expect(modes.availableModes.map((m) => m.id)).toContain("kiro_planner");
    expect(modes.availableModes.find((m) => m.id === "kiro_planner")!.name).toBe("Planner");
  });

  it("returns undefined when there are no agents to mirror", () => {
    const empty = new BridgeSession("s", "/w");
    expect(buildModeState(empty)).toBeUndefined();
  });
});

describe("refreshEffort resilience", () => {
  it("keeps a still-valid current level when Kiro marks none active", async () => {
    session.effort.current = "max";
    await refreshEffort(asKiro(kiro), session);
    expect(session.effort.current).toBe("max");
  });

  it("replaces an invalid current level with the default", async () => {
    session.effort.current = "bogus";
    await refreshEffort(asKiro(kiro), session);
    expect(session.effort.current).toBe("high");
  });
});
