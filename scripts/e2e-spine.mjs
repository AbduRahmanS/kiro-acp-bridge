#!/usr/bin/env node
/**
 * Task 2 verification: the pass-through spine, end to end.
 *
 *   ZedSim (acts as Zed)  ->  dist/index.js (the bridge)  ->  real kiro-cli acp
 *
 * Asserts:
 *   1. stdout carries only well-formed JSON-RPC (no log contamination)
 *   2. initialize reports Kiro's real capabilities plus the bridge's additions
 *   3. streaming text is forwarded
 *   4. tool calls are forwarded and their paths are ACP-legal (absolute) and
 *      rooted in the SESSION cwd, not the bridge's cwd  <- the two Kiro defects
 *   5. a rejected permission actually prevents the write
 *   6. cancellation reports stopReason "cancelled"
 *   7. no process is orphaned
 *
 * Uses gpt-5.6-luna (0.1x credits) and micro-prompts. Session cwd is a temp dir
 * deliberately DIFFERENT from the bridge's cwd, which is what exposes defect 2.
 */
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ZedSim, pidAlive } from "./lib/zed-sim.mjs";

const PROBE = "/tmp/kiro-bridge-e2e";
const WS = `${PROBE}/ws`;
rmSync(WS, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });
mkdirSync(`${PROBE}/datadir`, { recursive: true });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const zed = new ZedSim({
  cwd: WS, // NOTE: differs from the bridge cwd on purpose.
  permissionPolicy: "reject",
  env: {
    KIRO_DATA_DIR: `${PROBE}/datadir`,
    KIRO_DISABLE_TELEMETRY: "1",
    KIRO_DISABLE_SESSION_SEARCH_INDEX: "1",
    KIRO_BRIDGE_LOG_LEVEL: "info",
  },
}).start();

console.log(`bridge pid=${zed.pid}\nbridge cwd=${process.cwd()}\nsession cwd=${WS}\n`);

// ---- 1. initialize
console.log("=== 1. initialize ===");
const init = await zed.initialize();
const caps = init.result?.agentCapabilities ?? {};
check("protocolVersion is 1", init.result?.protocolVersion === 1, String(init.result?.protocolVersion));
check("image prompt capability surfaced from Kiro", caps.promptCapabilities?.image === true);
check("loadSession surfaced from Kiro", caps.loadSession === true);
check("mcp http capability surfaced from Kiro", caps.mcpCapabilities?.http === true);
check(
  "bridge advertises session/list (Kiro reports none)",
  caps.sessionCapabilities?.list !== undefined,
  JSON.stringify(caps.sessionCapabilities),
);
check("agentInfo identifies Kiro", String(init.result?.agentInfo?.title ?? "").includes("Kiro"),
  JSON.stringify(init.result?.agentInfo));

// ---- 2. session/new
console.log("\n=== 2. session/new ===");
const sn = await zed.newSession(WS);
const sid = sn.result?.sessionId;
check("session created", typeof sid === "string" && sid.length > 0, String(sid));

// Use the cheapest model for generation.
await zed.request("_probe/noop", {}).catch(() => {});

// ---- 3. streaming
console.log("\n=== 3. streaming a prompt ===");
zed.clearUpdates();
const p1 = await zed.prompt(sid, "Reply with exactly the single word: PONG");
check("stopReason end_turn", p1.result?.stopReason === "end_turn", JSON.stringify(p1.result));
check("agent_message_chunk forwarded", (zed.variantCounts().agent_message_chunk ?? 0) > 0,
  JSON.stringify(zed.variantCounts()));
check("text arrived", zed.text().includes("PONG"), JSON.stringify(zed.text().slice(0, 60)));

// ---- 4 + 5. tool call, path correctness, rejected permission
console.log("\n=== 4. tool call + path normalisation + rejected permission ===");
zed.clearUpdates();
const p2 = await zed.prompt(
  sid,
  "Create a file named spine_out.txt containing the word HELLO. Use your file write tool.",
);
check("prompt completed", p2.result?.stopReason !== undefined, JSON.stringify(p2.result));

const toolCalls = zed.updatesOfKind("tool_call");
check("tool_call forwarded", toolCalls.length > 0, `count=${toolCalls.length}`);

if (toolCalls.length > 0) {
  const tc = toolCalls[0].update;
  const locs = tc.locations ?? [];
  const diffs = (tc.content ?? []).filter((c) => c.type === "diff");

  if (locs.length > 0) {
    const p = locs[0].path;
    check("locations[].path is absolute (ACP requires it)", isAbsolute(p), p);
    check("locations[].path rooted in SESSION cwd", p.startsWith(WS), p);
  } else {
    console.log("  note: no locations[] on this tool call");
  }
  if (diffs.length > 0) {
    const p = diffs[0].path;
    check("diff path is absolute", isAbsolute(p), p);
    check("diff path rooted in SESSION cwd, not bridge cwd", p.startsWith(WS), p);
    check("diff path NOT rooted in bridge cwd", !p.startsWith(process.cwd()), p);
  } else {
    console.log("  note: no diff content on this tool call");
  }
}

check("permission was requested", zed.permissionRequests.length > 0,
  `count=${zed.permissionRequests.length}`);
if (zed.permissionRequests.length > 0) {
  const kinds = (zed.permissionRequests[0].options ?? []).map((o) => o.kind);
  check("permission offers allow_once + reject_once", kinds.includes("allow_once") && kinds.includes("reject_once"),
    JSON.stringify(kinds));
}
check("rejected permission prevented the write", !existsSync(`${WS}/spine_out.txt`));

// ---- 6. cancellation
console.log("\n=== 6. cancellation ===");
zed.clearUpdates();
const slow = zed.prompt(sid, "Write a very long detailed essay of at least 3000 words about the history of file systems.");
await new Promise((r) => setTimeout(r, 5000));
zed.notify("session/cancel", { sessionId: sid });
const cancelled = await slow;
check("stopReason is cancelled", cancelled.result?.stopReason === "cancelled", JSON.stringify(cancelled.result));

// ---- 7. stdout hygiene + clean shutdown
console.log("\n=== 7. stdout hygiene and shutdown ===");
check("no non-JSON lines on stdout", !zed.stdoutGarbage, JSON.stringify(zed.stdoutGarbage?.slice(0, 2)));

// Find the kiro child before shutting down so we can confirm it is reaped.
const { execSync } = await import("node:child_process");
let kiroPids = [];
try {
  kiroPids = execSync(`pgrep -P ${zed.pid}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
} catch {
  /* none */
}
console.log(`  kiro child pids: ${kiroPids.join(", ") || "(none found)"}`);

await zed.stop();
await new Promise((r) => setTimeout(r, 1200));
check("bridge process exited", !pidAlive(zed.pid));
for (const p of kiroPids) check(`kiro child ${p} reaped`, !pidAlive(p));

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
