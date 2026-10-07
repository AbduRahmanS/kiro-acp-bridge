import { describe, expect, it } from "vitest";
import { InvalidConfigValueError, UnknownConfigOptionError } from "../src/bridge/config.js";
import {
  buildV3ConfigOptions,
  buildV3ModeState,
  currentOf,
  effortAfterModelSwitch,
  matchValue,
  resolveV3Change,
} from "../src/bridge/v3-config.js";
import { detectDialect, v3ExtensionMethods } from "../src/kiro/protocol-v3.js";
import { v3Options, V3_EXTENSION_METHODS } from "./fixtures/v3.js";

type Opt = { id: string; category?: string; currentValue: unknown; options: Array<Record<string, unknown>>; _meta?: unknown };
const flat = (o: Opt | undefined) =>
  (o?.options ?? []).flatMap((x) => (Array.isArray(x.options) ? (x.options as Array<Record<string, unknown>>) : [x]));
const byId = (opts: unknown[], id: string) => (opts as Opt[]).find((o) => o.id === id);

describe("dialect detection", () => {
  it("recognises V3 by its advertised extension methods, not a version", () => {
    const init = { protocolVersion: 1, agentCapabilities: { _meta: { kiro: { extensionMethods: V3_EXTENSION_METHODS } } } };
    expect(detectDialect(init)).toBe("v3");
    expect(v3ExtensionMethods(init)).toContain("_kiro/session/context");
  });

  it("treats the v2 server's response as v2", () => {
    const v2 = {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: {}, auth: {} },
      agentInfo: { name: "Kiro CLI Agent", version: "2.28.0" },
    };
    expect(detectDialect(v2)).toBe("v2");
    expect(detectDialect(undefined)).toBe("v2");
  });
});

describe("buildV3ConfigOptions — what Zed sees", () => {
  const opts = buildV3ConfigOptions(v3Options({ model: "claude-opus-5.5", effort: "high" }));

  it("keeps the bridge's stable ids, so existing Zed settings still apply", () => {
    expect(opts.slice(0, 3).map((o) => o.id)).toEqual(["agent", "model", "effort"]);
  });

  it("keeps Zed's dedicated-selector categories", () => {
    expect(byId(opts, "agent")?.category).toBe("mode");
    expect(byId(opts, "model")?.category).toBe("model");
    expect(byId(opts, "effort")?.category).toBe("thought_level");
  });

  it("passes the other V3 options through unchanged, in Kiro's order", () => {
    expect(opts.slice(3).map((o) => o.id)).toEqual(["memoryReflection", "autopilot"]);
    expect(byId(opts, "autopilot")?.currentValue).toBe("on");
  });

  it("never leaks vendor _meta toward Zed", () => {
    expect(JSON.stringify(opts)).not.toContain("_meta");
  });

  it("uses Kiro's display names and humanises ids it left raw", () => {
    const agentNames = new Map(flat(byId(opts, "agent")).map((v) => [v.value, v.name]));
    expect(agentNames.get("vibe")).toBe("Default");
    expect(agentNames.get("semantic_reviewer")).toBe("Semantic Reviewer");
    const modelNames = new Map(flat(byId(opts, "model")).map((v) => [v.value, v.name]));
    expect(modelNames.get("claude-opus-5.5")).toBe("Claude Opus 5.5");
  });

  it("groups models by credit multiplier, worded like the v2 engine", () => {
    const groups = (byId(opts, "model")?.options ?? []).map((g) => g.group);
    expect(groups).toContain("2.00x credits");
    expect(groups).toContain("1.30x credits");
  });

  it("does not group agents when they all share one source", () => {
    expect((byId(opts, "agent")?.options ?? []).every((o) => o.group === undefined)).toBe(true);
  });

  it("withholds effort when the model has none (auto)", () => {
    expect(buildV3ConfigOptions(v3Options({ model: "auto" })).map((o) => o.id)).not.toContain("effort");
  });

  it("mirrors modes for legacy clients", () => {
    const modes = buildV3ModeState(v3Options({ mode: "plan" }));
    expect(modes?.currentModeId).toBe("plan");
    expect(modes?.availableModes.map((m) => m.id)).toContain("spec");
  });
});

describe("resolveV3Change — validation before anything reaches Kiro", () => {
  const native = v3Options({ model: "claude-opus-5.5" });

  it("maps bridge ids to V3's native ids", () => {
    expect(resolveV3Change(native, "agent", "plan")).toMatchObject({ nativeId: "mode", role: "agent" });
    expect(resolveV3Change(native, "effort", "max")).toMatchObject({ nativeId: "effortLevel", role: "effort" });
    expect(resolveV3Change(native, "model", "auto")).toMatchObject({ nativeId: "model" });
  });

  it("rejects an unknown model — V3 itself would accept it and break the session", () => {
    expect(() => resolveV3Change(native, "model", "claude-opus-5")).toThrow(InvalidConfigValueError);
  });

  it("rejects an unknown effort — V3 itself would silently ignore it", () => {
    expect(() => resolveV3Change(native, "effort", "ludicrous")).toThrow(InvalidConfigValueError);
  });

  it("rejects effort for a model with no effort axis as a bad value", () => {
    expect(() => resolveV3Change(v3Options({ model: "auto" }), "effort", "high")).toThrow(InvalidConfigValueError);
  });

  it("accepts the v2 built-in agent ids people have in their Zed settings", () => {
    expect(resolveV3Change(native, "agent", "kiro_default").value).toBe("vibe");
    expect(resolveV3Change(native, "agent", "kiro_planner").value).toBe("plan");
  });

  it("validates passthrough options too", () => {
    expect(resolveV3Change(native, "autopilot", "off")).toMatchObject({ nativeId: "autopilot", value: "off" });
    expect(() => resolveV3Change(native, "autopilot", "sometimes")).toThrow(InvalidConfigValueError);
    expect(() => resolveV3Change(native, "colour", "blue")).toThrow(UnknownConfigOptionError);
  });
});

describe("effortAfterModelSwitch — the v2 contract, kept on V3", () => {
  it("re-applies a level the user chose when the new model supports it", () => {
    // V3 reset effort to sonnet's default (high) after the switch.
    const after = v3Options({ model: "claude-sonnet-5.5" });
    expect(effortAfterModelSwitch({ level: "max", explicit: true }, after)).toEqual({ explicit: true, reapply: "max" });
  });

  it("accepts Kiro's per-model default when the previous level was not chosen", () => {
    const after = v3Options({ model: "claude-sonnet-5.5" });
    expect(effortAfterModelSwitch({ level: "medium", explicit: false }, after)).toEqual({ explicit: false });
  });

  it("says so when a chosen level does not exist on the new model", () => {
    const d = effortAfterModelSwitch({ level: "max", explicit: true }, v3Options({ model: "narrow-model" }));
    expect(d.reapply).toBeUndefined();
    expect(d.notice).toContain("not available");
    expect(d.notice).toContain("Narrow Model");
  });

  it("says so when the new model has no effort axis", () => {
    const d = effortAfterModelSwitch({ level: "high", explicit: true }, v3Options({ model: "auto" }));
    expect(d.notice).toContain("not configurable");
    expect(d.explicit).toBe(false);
  });
});

describe("matchValue — free-text /model and /agent arguments", () => {
  const native = v3Options({});
  it("matches ids, display names and unique prefixes", () => {
    expect(matchValue(native, "model", "claude-opus-5.5").match).toBe("claude-opus-5.5");
    expect(matchValue(native, "model", "claude sonnet 5.5").match).toBe("claude-sonnet-5.5");
    expect(matchValue(native, "model", "claude-o").match).toBe("claude-opus-5.5");
    expect(matchValue(native, "agent", "plan").match).toBe("plan");
  });
  it("reports ambiguity instead of guessing", () => {
    const r = matchValue(native, "model", "claude");
    expect(r.match).toBeUndefined();
    expect(r.candidates).toEqual(["claude-opus-5.5", "claude-sonnet-5.5"]);
  });
  it("reads current values", () => {
    expect(currentOf(v3Options({ model: "claude-opus-5.5", effort: "max" }), "effort")).toBe("max");
  });
});
