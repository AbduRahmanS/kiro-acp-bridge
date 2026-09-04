#!/usr/bin/env node
/**
 * Authentication-path verification, via the fake-Kiro fixture.
 *
 * These paths cannot be exercised against a real Kiro without signing out of a
 * working account, so a fixture returning Kiro's genuine error strings stands in.
 *
 * Asserts:
 *   1. terminal auth is advertised even though Kiro reports authMethods: []
 *   2. an expired token at session/new becomes ACP -32000, not an opaque -32603
 *   3. the same for an invalid grant, and for a failure mid-prompt
 *   4. the guidance names the exact command to run
 *   5. ordinary failures are NOT misreported as auth problems
 *   6. a healthy fixture still produces the full config-option surface
 */
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { ZedSim, pidAlive } from "./lib/zed-sim.mjs";

const PROBE = "/tmp/kiro-bridge-auth";
const WS = `${PROBE}/ws`;
rmSync(PROBE, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });

const FAKE = resolve("scripts/fake-kiro.mjs");
chmodSync(FAKE, 0o755);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** Starts the bridge against the fake Kiro in a given failure mode. */
function start(mode) {
  return new ZedSim({
    cwd: WS,
    env: { KIRO_CLI_PATH: FAKE, FAKE_KIRO_MODE: mode, KIRO_BRIDGE_LOG_LEVEL: "warn" },
  }).start();
}

const AUTH_REQUIRED = -32000;

// ---------------------------------------------------------------------------
console.log("=== 1. terminal auth advertised despite Kiro reporting none ===");
{
  const zed = start("ok");
  const init = await zed.initialize();
  const methods = init.result?.authMethods ?? [];
  console.log(`  authMethods: ${JSON.stringify(methods)}`);
  check("exactly one method added", methods.length === 1, `count=${methods.length}`);
  check("id is kiro-cli-login", methods[0]?.id === "kiro-cli-login", methods[0]?.id);
  check("type is terminal", methods[0]?.type === "terminal", methods[0]?.type);
  check("args tell the client how to run setup", JSON.stringify(methods[0]?.args) === '["--login"]',
    JSON.stringify(methods[0]?.args));
  check("name is human-readable", /sign in/i.test(methods[0]?.name ?? ""), methods[0]?.name);
  await zed.stop();
}

// ---------------------------------------------------------------------------
console.log("\n=== 2. expired token at session/new -> ACP -32000 ===");
{
  const zed = start("auth-expired");
  await zed.initialize();
  const sn = await zed.newSession(WS);
  console.log(`  error: ${JSON.stringify(sn.error)}`);
  check("returns an error", !!sn.error);
  check("code is -32000 (authentication required), not -32603",
    sn.error?.code === AUTH_REQUIRED, String(sn.error?.code));
  check("message says authentication", /authentication/i.test(sn.error?.message ?? ""),
    sn.error?.message);
  check("guidance names the exact command", /kiro-cli login/.test(JSON.stringify(sn.error?.data ?? "")),
    JSON.stringify(sn.error?.data).slice(0, 120));
  await zed.stop();
}

// ---------------------------------------------------------------------------
console.log("\n=== 3. invalid grant is treated the same ===");
{
  const zed = start("auth-invalid");
  await zed.initialize();
  const sn = await zed.newSession(WS);
  check("invalid grant -> -32000", sn.error?.code === AUTH_REQUIRED, String(sn.error?.code));
  await zed.stop();
}

// ---------------------------------------------------------------------------
console.log("\n=== 4. an ordinary failure is NOT misreported as auth ===");
{
  // A missing agent must stay invalidParams. Over-eager auth detection would be
  // worse than none: it would send users to re-login for unrelated faults.
  const zed = start("ok");
  await zed.initialize();
  const sn = await zed.newSession(WS);
  const sid = sn.result?.sessionId;
  const bad = await zed.setConfigOption(sid, "agent", "does-not-exist");
  console.log(`  error: ${JSON.stringify(bad.error?.code)} ${JSON.stringify(bad.error?.message?.slice(0, 60))}`);
  check("unknown agent stays -32602, not -32000", bad.error?.code === -32602, String(bad.error?.code));
  await zed.stop();
}

// ---------------------------------------------------------------------------
console.log("\n=== 5. healthy fixture still yields the full surface ===");
{
  const zed = start("ok");
  await zed.initialize();
  const sn = await zed.newSession(WS);
  const sid = sn.result?.sessionId;
  const opts = sn.result?.configOptions ?? [];
  check("three config options present", opts.length === 3, JSON.stringify(opts.map((o) => o.id)));
  check("categories are model/mode/thought_level",
    JSON.stringify(opts.map((o) => o.category).sort()) === '["mode","model","thought_level"]',
    JSON.stringify(opts.map((o) => o.category)));

  // Effort must still be withdrawn for a model with no effort axis.
  const auto = await zed.setConfigOption(sid, "model", "auto");
  const autoIds = (auto.result?.configOptions ?? []).map((o) => o.id);
  check("effort withdrawn for `auto` (fixture reports [])", !autoIds.includes("effort"),
    JSON.stringify(autoIds));

  const back = await zed.setConfigOption(sid, "model", "gpt-5.6-sol");
  const efforts = (back.result?.configOptions ?? []).find((o) => o.id === "effort")?.options ?? [];
  check("effort restored with `none` for the GPT fixture",
    efforts.some((o) => o.value === "none"), JSON.stringify(efforts.map((o) => o.value)));

  const p = await zed.prompt(sid, "hello");
  check("prompt round-trips", zed.text().includes("FAKE_OK"), JSON.stringify(zed.text()));
  check("stopReason forwarded", p.result?.stopReason === "end_turn");
  await zed.stop();
}

// ---------------------------------------------------------------------------
console.log("\n=== 6. auth failure mid-prompt ===");
{
  const zed = start("auth-on-prompt");
  await zed.initialize();
  const sn = await zed.newSession(WS);
  const sid = sn.result?.sessionId;
  check("session creation succeeds", !!sid);
  const p = await zed.prompt(sid, "hello");
  console.log(`  prompt error: ${JSON.stringify(p.error?.code)} ${JSON.stringify(String(p.error?.message ?? "").slice(0, 60))}`);
  check("mid-prompt expiry also becomes -32000", p.error?.code === AUTH_REQUIRED, String(p.error?.code));
  check("guidance names the command", /kiro-cli login/.test(JSON.stringify(p.error?.data ?? "")));
  await zed.stop();
}

// ---------------------------------------------------------------------------
console.log("\n=== 7. Kiro crashing during session/new ===");
{
  const zed = start("crash-on-new");
  await zed.initialize();
  const sn = await zed.newSession(WS);
  check("crash produces an error rather than a hang", !!sn.error || !!sn.__timeout,
    JSON.stringify(sn.error?.code ?? "timeout"));
  await zed.stop();
  await new Promise((r) => setTimeout(r, 600));
  check("bridge exits cleanly after a Kiro crash", !pidAlive(zed.pid));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
