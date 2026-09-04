#!/usr/bin/env node
/**
 * Tasks 6-7 verification against REAL Kiro, covering brief acceptance tests:
 *
 *   Test D — typing `/` surfaces Kiro commands; invoking one runs the real
 *            command rather than sending it to the model as prose
 *   Test E — a Kiro skill appears as a slash command and actually executes
 *
 * Also verifies the state-sync requirement from brief section 39:
 *   `/model gpt-5.6-sol` must change Kiro AND push a config_option_update so
 *   Zed's picker cannot go stale.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { ZedSim, pidAlive } from "./lib/zed-sim.mjs";

const PROBE = "/tmp/kiro-bridge-cmds";
const WS = `${PROBE}/ws`;
rmSync(WS, { recursive: true, force: true });
mkdirSync(`${WS}/.kiro/skills/e2e-marker-skill`, { recursive: true });
mkdirSync(`${PROBE}/datadir`, { recursive: true });

// A workspace skill the bridge must discover, since Kiro never advertises skills.
writeFileSync(
  `${WS}/.kiro/skills/e2e-marker-skill/SKILL.md`,
  [
    "---",
    "name: e2e-marker-skill",
    "description: Test skill that proves skills reach Kiro through the bridge.",
    "---",
    "# E2E Marker Skill",
    "",
    "When invoked, reply with exactly this token and nothing else: SKILL_OK_7Q",
    "",
  ].join("\n"),
);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
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

// available_commands_update is a notification, deliberately deferred past the
// session/new response, so wait for it to land.
await new Promise((r) => setTimeout(r, 6000));

// ---------------------------------------------------------------------------
console.log("=== TEST D: command catalogue reaches Zed ===");
const cmdUpdates = zed.updatesOfKind("available_commands_update");
check("available_commands_update received", cmdUpdates.length > 0, `count=${cmdUpdates.length}`);
const commands = cmdUpdates.at(-1)?.update?.availableCommands ?? [];
const names = commands.map((c) => c.name);
console.log(`  ${names.length} commands: ${names.join(", ")}`);

check("catalogue is non-trivial", names.length >= 15, `count=${names.length}`);
for (const expected of ["model", "effort", "agent", "context", "usage", "tools", "mcp", "plan", "rewind"]) {
  check(`/${expected} advertised`, names.includes(expected));
}
check("no leading slashes in ACP names", names.every((n) => !n.startsWith("/")));
for (const excluded of ["quit", "paste", "voice", "clear"]) {
  check(`/${excluded} correctly excluded (Zed does it better)`, !names.includes(excluded));
}
const agentCmd = commands.find((c) => c.name === "agent");
check("subcommand hints synthesised into input.hint", !!agentCmd?.input?.hint,
  JSON.stringify(agentCmd?.input));

// ---------------------------------------------------------------------------
console.log("\n=== TEST E: skill discovered and executed ===");
check("workspace skill advertised as a command", names.includes("e2e-marker-skill"));
const skillCmd = commands.find((c) => c.name === "e2e-marker-skill");
check("skill labelled as a skill", (skillCmd?.description ?? "").includes("(Kiro skill)"),
  skillCmd?.description);

// Use the cheapest model for the two prompts that need a model.
await zed.setConfigOption(sid, "model", "gpt-5.6-luna");
await zed.setConfigOption(sid, "effort", "low");

zed.clearUpdates();
const skillRun = await zed.prompt(sid, "/e2e-marker-skill");
check("skill invocation completes", skillRun.result?.stopReason === "end_turn",
  JSON.stringify(skillRun.result));
const skillText = zed.text();
check("Kiro actually executed the skill", skillText.includes("SKILL_OK_7Q"),
  JSON.stringify(skillText.slice(0, 160)));

// ---------------------------------------------------------------------------
console.log("\n=== TEST D (cont): a command runs as a command, not as an LLM prompt ===");
zed.clearUpdates();
const ctx = await zed.prompt(sid, "/context");
check("/context completes", ctx.result?.stopReason === "end_turn", JSON.stringify(ctx.result));
const ctxText = zed.text();
check("/context produced Kiro's real command output", /context breakdown/i.test(ctxText),
  JSON.stringify(ctxText.slice(0, 140)));
check("/context was not answered conversationally", !/I (can|will|cannot)\b/i.test(ctxText),
  JSON.stringify(ctxText.slice(0, 140)));

// ---------------------------------------------------------------------------
console.log("\n=== section 39: state sync when a command changes the model ===");
zed.clearUpdates();
const cmdSwitch = await zed.prompt(sid, "/model gpt-5.6-sol");
check("/model <name> completes", cmdSwitch.result?.stopReason === "end_turn",
  JSON.stringify(cmdSwitch.result));

const cfgPushes = zed.updatesOfKind("config_option_update");
check("bridge pushed config_option_update after the command", cfgPushes.length > 0,
  `count=${cfgPushes.length}`);
const pushed = cfgPushes.at(-1)?.update?.configOptions ?? [];
const pushedModel = pushed.find((o) => o.id === "model");
check("pushed model reflects the command (no stale selector)",
  pushedModel?.currentValue === "gpt-5.6-sol", pushedModel?.currentValue);
const pushedEffort = pushed.find((o) => o.id === "effort");
check("effort list refreshed for the new model",
  (pushedEffort?.options ?? []).some((o) => o.value === "none"),
  JSON.stringify((pushedEffort?.options ?? []).map((o) => o.value)));
check("Kiro's own confirmation surfaced to the user", /gpt-5\.6-sol/i.test(zed.text()),
  JSON.stringify(zed.text().slice(0, 140)));

// And confirm the authoritative state agrees.
const confirm = await zed.setConfigOption(sid, "effort", "high");
const confirmModel = (confirm.result?.configOptions ?? []).find((o) => o.id === "model");
check("authoritative state matches the pushed state",
  confirmModel?.currentValue === "gpt-5.6-sol", confirmModel?.currentValue);

// ---------------------------------------------------------------------------
console.log("\n=== /plan switches agent and syncs the selector ===");
zed.clearUpdates();
const plan = await zed.prompt(sid, "/plan");
check("/plan completes", plan.result?.stopReason === "end_turn", JSON.stringify(plan.result));
const planPush = zed.updatesOfKind("config_option_update").at(-1)?.update?.configOptions ?? [];
const planAgent = planPush.find((o) => o.id === "agent");
check("/plan selected kiro_planner and synced the UI (TEST C via command)",
  planAgent?.currentValue === "kiro_planner", planAgent?.currentValue);
check("Kiro reported the agent change", /planner/i.test(zed.text()),
  JSON.stringify(zed.text().slice(0, 140)));

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
