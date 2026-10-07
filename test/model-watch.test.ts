import { describe, expect, it } from "vitest";
import { checkIntervalMs, describeChange, diffRoster, hasChanges, parseModelList } from "../src/bridge/model-watch.js";
import { humaniseModelId } from "../src/bridge/labels.js";

describe("parseModelList", () => {
  it("reads kiro-cli 2.28's --list-models --format json", () => {
    const out = JSON.stringify({
      models: [
        { model_name: "auto", model_id: "auto", context_window_tokens: 1000000, rate_multiplier: 1.0 },
        { model_name: "claude-opus-5.5", model_id: "claude-opus-5.5", rate_multiplier: 2.0 },
      ],
      default_model: "auto",
    });
    expect(parseModelList(out)).toEqual(["auto", "claude-opus-5.5"]);
  });

  it("treats errors and unexpected output as unknown, never as an empty roster", () => {
    expect(parseModelList("error: dispatch failure")).toBeUndefined();
    expect(parseModelList("{}")).toBeUndefined();
  });
});

describe("diffRoster", () => {
  it("reports added and removed models, ignoring the auto router", () => {
    const d = diffRoster(["auto", "claude-opus-5"], ["auto", "claude-opus-5", "claude-sonnet-5.5"]);
    expect(d).toEqual({ added: ["claude-sonnet-5.5"], removed: [] });
    expect(hasChanges(d)).toBe(true);
    expect(hasChanges(diffRoster(["a"], ["a"]))).toBe(false);
    expect(diffRoster(["auto"], []).removed).toEqual([]);
  });

  it("describes a change with display names", () => {
    const text = describeChange({ added: ["claude-sonnet-5.5"], removed: ["gpt-5.6-luna"] }, humaniseModelId);
    expect(text).toContain("**New model available:** Claude Sonnet 5.5");
    expect(text).toContain("No longer offered: GPT-5.6 Luna.");
  });
});

describe("checkIntervalMs", () => {
  it("defaults to 10 minutes and can be disabled", () => {
    expect(checkIntervalMs({})).toBe(600_000);
    expect(checkIntervalMs({ KIRO_BRIDGE_MODEL_CHECK_MINUTES: "0" })).toBe(0);
    expect(checkIntervalMs({ KIRO_BRIDGE_MODEL_CHECK_MINUTES: "0.01" })).toBe(600);
    expect(checkIntervalMs({ KIRO_BRIDGE_MODEL_CHECK_MINUTES: "nonsense" })).toBe(0);
  });
});
