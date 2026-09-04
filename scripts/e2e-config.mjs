#!/usr/bin/env node
/**
 * Tasks 3-5 verification against REAL Kiro, covering brief acceptance tests:
 *
 *   Test A — model switching in the SAME session, no restart
 *   Test B — reasoning effort, and effort list refreshing on model change
 *   Test C — Plan mode selected via the agent option
 *   Test F — custom agents appear in the selector
 *
 * Cheap by construction: config changes and option queries do not invoke a
 * model, so this script spends essentially no credits. Only two tiny prompts run,
 * on the 0.1x model, to prove the selected model is actually in effect.
 */
import { mkdirSync, rmSync } from "node:fs";
import { ZedSim, pidAlive } from "./lib/zed-sim.mjs";

const PROBE = "/tmp/kiro-bridge-config";
const WS = `${PROBE}/ws`;
rmSync(WS, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });
mkdirSync(`${PROBE}/datadir`, { recursive: true });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const findOpt = (opts, id) => (opts ?? []).find((o) => o.id === id);
const flatValues = (opt) => {
  const o = opt?.options ?? [];
  return o.flatMap((x) => (x.options ? x.options.map((y) => y.value) : [x.value]));
};
const flatNames = (opt) => {
  const o = opt?.options ?? [];
  return new Map(
    o.flatMap((x) => (x.options ? x.options.map((y) => [y.value, y.name]) : [[x.value, x.name]])),
  );
};

const zed = new ZedSim({
  cwd: WS,
  permissionPolicy: "reject",
  env: {
    KIRO_DATA_DIR: `${PROBE}/datadir`,
    KIRO_DISABLE_TELEMETRY: "1",
    KIRO_DISABLE_SESSION_SEARCH_INDEX: "1",
    KIRO_BRIDGE_LOG_LEVEL: "warn",
  },
}).start();

await zed.initialize();
const sn = await zed.newSession(WS);
const sid = sn.result?.sessionId;
let opts = sn.result?.configOptions;

// ---------------------------------------------------------------------------
console.log("=== session/new delivers config options (the headline fix) ===");
check("configOptions present in session/new response", Array.isArray(opts) && opts.length > 0,
  `count=${opts?.length}`);
const modelOpt = findOpt(opts, "model");
const agentOpt = findOpt(opts, "agent");
const effortOpt = findOpt(opts, "effort");
check("model option present", !!modelOpt);
check("agent option present", !!agentOpt);
check("effort option present", !!effortOpt);
check("model category is 'model'", modelOpt?.category === "model", modelOpt?.category);
check("agent category is 'mode'", agentOpt?.category === "mode", agentOpt?.category);
check("effort category is 'thought_level'", effortOpt?.category === "thought_level", effortOpt?.category);
check("legacy modes mirrored for older clients", !!sn.result?.modes,
  sn.result?.modes?.currentModeId);

const modelValues = flatValues(modelOpt);
const modelNames = flatNames(modelOpt);
console.log(`  models offered: ${modelValues.join(", ")}`);
check("claude-opus-5 offered", modelValues.includes("claude-opus-5"));
check("gpt-5.6-sol offered", modelValues.includes("gpt-5.6-sol"));
check("Claude Opus 5 label humanised", modelNames.get("claude-opus-5") === "Claude Opus 5",
  modelNames.get("claude-opus-5"));
check("GPT-5.6 Sol label humanised", modelNames.get("gpt-5.6-sol") === "GPT-5.6 Sol",
  modelNames.get("gpt-5.6-sol"));
const modelGroups = (modelOpt?.options ?? []).map((g) => g.group).filter(Boolean);
check("credit multipliers surfaced as groups", modelGroups.some((g) => /x credits/.test(g)),
  JSON.stringify(modelGroups));

// ---------------------------------------------------------------------------
console.log("\n=== TEST A: model switching in the same session ===");
const setOpus = await zed.setConfigOption(sid, "model", "claude-opus-5");
check("set model -> claude-opus-5 returns full option array",
  Array.isArray(setOpus.result?.configOptions) && setOpus.result.configOptions.length > 0);
check("currentValue is claude-opus-5",
  findOpt(setOpus.result?.configOptions, "model")?.currentValue === "claude-opus-5",
  findOpt(setOpus.result?.configOptions, "model")?.currentValue);

const setSol = await zed.setConfigOption(sid, "model", "gpt-5.6-sol");
check("switch to gpt-5.6-sol in SAME session",
  findOpt(setSol.result?.configOptions, "model")?.currentValue === "gpt-5.6-sol",
  findOpt(setSol.result?.configOptions, "model")?.currentValue);

// ---------------------------------------------------------------------------
console.log("\n=== TEST B: effort is per-model and refreshes on model change ===");
const solEffort = findOpt(setSol.result?.configOptions, "effort");
const solLevels = flatValues(solEffort);
console.log(`  gpt-5.6-sol effort levels: ${solLevels.join(", ")}`);
check("gpt-5.6-sol exposes 'none'", solLevels.includes("none"), JSON.stringify(solLevels));

const backToOpus = await zed.setConfigOption(sid, "model", "claude-opus-5");
const opusLevels = flatValues(findOpt(backToOpus.result?.configOptions, "effort"));
console.log(`  claude-opus-5 effort levels: ${opusLevels.join(", ")}`);
check("claude-opus-5 does NOT expose 'none'", !opusLevels.includes("none"), JSON.stringify(opusLevels));
check("effort list genuinely differs between models",
  JSON.stringify(solLevels) !== JSON.stringify(opusLevels));

const setMax = await zed.setConfigOption(sid, "effort", "max");
check("effort set to max", findOpt(setMax.result?.configOptions, "effort")?.currentValue === "max",
  findOpt(setMax.result?.configOptions, "effort")?.currentValue);

// The `auto` model has no effort axis at all — the option must disappear.
const setAuto = await zed.setConfigOption(sid, "model", "auto");
const autoOpts = setAuto.result?.configOptions ?? [];
check("effort option WITHDRAWN for `auto` (no effort axis)", !findOpt(autoOpts, "effort"),
  JSON.stringify(autoOpts.map((o) => o.id)));
check("model option still present for `auto`", !!findOpt(autoOpts, "model"));
const noticeSeen = zed.text().includes("not configurable");
check("user was told effort is unavailable, not silently stripped", noticeSeen,
  JSON.stringify(zed.text().slice(-160)));

// Restoring a model with an effort axis brings the option back.
const restore = await zed.setConfigOption(sid, "model", "claude-opus-5");
check("effort option RESTORED for claude-opus-5", !!findOpt(restore.result?.configOptions, "effort"));

// ---------------------------------------------------------------------------
console.log("\n=== TEST C/F: agents, Plan, and custom agents ===");
const agentValues = flatValues(agentOpt);
const agentNames = flatNames(agentOpt);
console.log(`  agents offered: ${agentValues.join(", ")}`);
check("kiro_default offered", agentValues.includes("kiro_default"));
check("kiro_planner (Plan) offered", agentValues.includes("kiro_planner"));
check("Plan label humanised", agentNames.get("kiro_planner") === "Planner",
  agentNames.get("kiro_planner"));
// The developer's real machine has kirocrew* custom agents in ~/.kiro/agents.
const customAgents = agentValues.filter((v) => !v.startsWith("kiro_"));
check("custom agents discovered dynamically (TEST F)", customAgents.length > 0,
  customAgents.join(", "));
const agentGroups = (agentOpt?.options ?? []).map((g) => g.group).filter(Boolean);
check("agents grouped by provenance", agentGroups.includes("Built-in"), JSON.stringify(agentGroups));

const setPlan = await zed.setConfigOption(sid, "agent", "kiro_planner");
check("agent switched to kiro_planner (TEST C)",
  findOpt(setPlan.result?.configOptions, "agent")?.currentValue === "kiro_planner",
  findOpt(setPlan.result?.configOptions, "agent")?.currentValue);

await zed.setConfigOption(sid, "agent", "kiro_default");

// ---------------------------------------------------------------------------
console.log("\n=== invalid values are rejected, not silently applied ===");
const badModel = await zed.setConfigOption(sid, "model", "totally-not-a-model");
check("unknown model -> JSON-RPC error", !!badModel.error, JSON.stringify(badModel.error?.code));
check("error is invalidParams (-32602)", badModel.error?.code === -32602, String(badModel.error?.code));
const badEffort = await zed.setConfigOption(sid, "effort", "ludicrous");
check("invalid effort -> error", !!badEffort.error, JSON.stringify(badEffort.error?.code));
const badId = await zed.setConfigOption(sid, "colour", "blue");
check("unknown config id -> error", !!badId.error, JSON.stringify(badId.error?.code));

// State must be unchanged after all those rejections.
const afterBad = await zed.setConfigOption(sid, "effort", "high");
check("state intact after rejected changes",
  findOpt(afterBad.result?.configOptions, "model")?.currentValue === "claude-opus-5",
  findOpt(afterBad.result?.configOptions, "model")?.currentValue);

// ---------------------------------------------------------------------------
console.log("\n=== the selected model is genuinely in effect ===");
await zed.setConfigOption(sid, "model", "gpt-5.6-luna");
await zed.setConfigOption(sid, "effort", "low");
zed.clearUpdates();
const p = await zed.prompt(sid, "Reply with only your model family name, one word.");
check("prompt succeeds after switching model", p.result?.stopReason === "end_turn",
  JSON.stringify(p.result));
console.log(`  model self-report: ${JSON.stringify(zed.text().slice(0, 120))}`);

// ---------------------------------------------------------------------------
console.log("\n=== shutdown ===");
const { execSync } = await import("node:child_process");
let kiroPids = [];
try {
  kiroPids = execSync(`pgrep -P ${zed.pid}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
} catch { /* none */ }
await zed.stop();
await new Promise((r) => setTimeout(r, 1200));
check("bridge exited", !pidAlive(zed.pid));
for (const pid of kiroPids) check(`kiro child ${pid} reaped`, !pidAlive(pid));

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
