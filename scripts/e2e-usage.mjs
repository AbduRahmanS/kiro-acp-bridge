#!/usr/bin/env node
/**
 * Tasks 8-10 verification against REAL Kiro:
 *   - usage_update carries measured absolute token counts (not derived)
 *   - /usage reports credits as credits, never as ACP monetary cost
 *   - session/list is implemented on top of Kiro's own store
 *   - MCP status is read without error
 */
import { mkdirSync, rmSync } from "node:fs";
import { ZedSim, pidAlive } from "./lib/zed-sim.mjs";

const PROBE = "/tmp/kiro-bridge-usage";
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
  cwd: WS,
  env: {
    KIRO_DATA_DIR: `${PROBE}/datadir`,
    KIRO_DISABLE_TELEMETRY: "1",
    KIRO_DISABLE_SESSION_SEARCH_INDEX: "1",
    KIRO_BRIDGE_LOG_LEVEL: "warn",
  },
}).start();

const init = await zed.initialize();
check("bridge advertises sessionCapabilities.list",
  init.result?.agentCapabilities?.sessionCapabilities?.list !== undefined,
  JSON.stringify(init.result?.agentCapabilities?.sessionCapabilities));

const sn = await zed.newSession(WS);
const sid = sn.result?.sessionId;
await zed.setConfigOption(sid, "model", "gpt-5.6-luna");

// ---------------------------------------------------------------------------
console.log("\n=== usage_update from measured token counts ===");
await new Promise((r) => setTimeout(r, 4000));
let usageUpdates = zed.updatesOfKind("usage_update");
check("usage_update emitted after session start", usageUpdates.length > 0,
  `count=${usageUpdates.length}`);

if (usageUpdates.length > 0) {
  const u = usageUpdates.at(-1).update;
  console.log(`  used=${u.used} size=${u.size}`);
  check("used is a positive integer", Number.isInteger(u.used) && u.used > 0, String(u.used));
  check("size is the model's real context window (272000 for luna)", u.size === 272000, String(u.size));
  check("used is below size", u.used < u.size);
  check("NO cost field for an in-plan session", u.cost === undefined, JSON.stringify(u.cost));
}

// A turn grows context, so the figure must increase.
const before = usageUpdates.at(-1)?.update?.used ?? 0;
zed.clearUpdates();
await zed.prompt(sid, "Say OK.");
await new Promise((r) => setTimeout(r, 4000));
usageUpdates = zed.updatesOfKind("usage_update");
check("usage_update refreshed after a turn", usageUpdates.length > 0, `count=${usageUpdates.length}`);
if (usageUpdates.length > 0) {
  const after = usageUpdates.at(-1).update.used;
  console.log(`  used before=${before} after=${after}`);
  check("token count grew after the turn", after > before, `${before} -> ${after}`);
}

// ---------------------------------------------------------------------------
console.log("\n=== /usage reports credits as credits ===");
zed.clearUpdates();
const usageCmd = await zed.prompt(sid, "/usage");
check("/usage completes", usageCmd.result?.stopReason === "end_turn", JSON.stringify(usageCmd.result));
const text = zed.text();
console.log(`  ---\n${text.split("\n").map((l) => `  ${l}`).join("\n")}\n  ---`);
check("names the plan", /plan:/i.test(text));
check("reports credits with the unit named", /credits/i.test(text));
check("shows a context token figure", /context:.*tokens/i.test(text));
// The critical semantic requirement: credits must not be rendered as money.
const creditLine = text.split("\n").find((l) => /credits:/i.test(l)) ?? "";
check("credit line contains no currency code", !/\b(USD|EUR|GBP)\b/.test(creditLine),
  JSON.stringify(creditLine));

// ---------------------------------------------------------------------------
console.log("\n=== session/list built on Kiro's own store ===");
const list = await zed.request("session/list", {});
check("session/list succeeds", !list.error, JSON.stringify(list.error));
const sessions = list.result?.sessions ?? [];
console.log(`  ${sessions.length} sessions returned`);
check("returns sessions", sessions.length > 0, `count=${sessions.length}`);
check("every entry has an absolute cwd (ACP requires it)",
  sessions.every((s) => typeof s.cwd === "string" && s.cwd.startsWith("/")));
check("every entry has a sessionId", sessions.every((s) => typeof s.sessionId === "string"));
check("the current session is listed", sessions.some((s) => s.sessionId === sid));
const titled = sessions.filter((s) => s.title);
console.log(`  ${titled.length} have titles, e.g. ${JSON.stringify(titled[0]?.title?.slice(0, 40))}`);

const filtered = await zed.request("session/list", { cwd: WS });
check("cwd filter narrows the result",
  (filtered.result?.sessions ?? []).every((s) => s.cwd === WS),
  `count=${filtered.result?.sessions?.length}`);

// ---------------------------------------------------------------------------
console.log("\n=== MCP status read without error ===");
// No MCP servers are configured here, so the check is that it is handled quietly:
// no crash, no spurious failure notice in the thread.
const mcpNotice = zed.text().includes("failed to start");
check("no spurious MCP failure reported", !mcpNotice);
const stderrHasMcp = zed.stderr.some((l) => /mcp startup status/.test(l));
console.log(`  mcp status logged: ${stderrHasMcp}`);

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
