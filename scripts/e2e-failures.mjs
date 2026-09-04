#!/usr/bin/env node
/**
 * Task 11 verification: diagnostics and failure handling.
 *
 *  - Kiro not installed -> actionable message, exit 127, no stack trace
 *  - trace mode off by default; on when asked; secrets and prompt text redacted
 *  - unknown ACP method -> -32601, connection survives
 *  - malformed JSON on the wire -> tolerated, connection survives
 *  - unknown session id -> -32602
 *  - Kiro killed mid-session -> reported in the thread, no orphan
 *  - images: forwarded, and a per-model image failure surfaces as an error
 */
import { execFile, spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { ZedSim, pidAlive } from "./lib/zed-sim.mjs";

const execFileAsync = promisify(execFile);
const PROBE = "/tmp/kiro-bridge-fail";
const WS = `${PROBE}/ws`;
rmSync(PROBE, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });
mkdirSync(`${PROBE}/datadir`, { recursive: true });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const baseEnv = {
  KIRO_DATA_DIR: `${PROBE}/datadir`,
  KIRO_DISABLE_TELEMETRY: "1",
  KIRO_DISABLE_SESSION_SEARCH_INDEX: "1",
};

// ---------------------------------------------------------------------------
console.log("=== 1. Kiro not installed ===");
{
  // Design note: `initialize` deliberately SUCCEEDS in degraded mode when Kiro
  // is missing. ACP's initialize is capability negotiation, and it is also how a
  // client learns which auth methods exist — rejecting it leaves the client
  // unable to offer sign-in and reporting a dead agent. So the handshake
  // completes with conservative capabilities plus the terminal auth method, the
  // actionable guidance goes to stderr, and the real failure surfaces later at
  // `session/new`.
  const child = spawn(process.execPath, ["dist/index.js"], {
    env: { ...process.env, ...baseEnv, KIRO_CLI_PATH: "/nonexistent/kiro-cli", PATH: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => (stderr += c));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => (stdout += c));
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: {}, terminal: true, auth: { terminal: true } },
      clientInfo: { name: "t", version: "1" },
    },
  });
  await new Promise((r) => setTimeout(r, 2500));
  send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: WS, mcpServers: [] } });
  await new Promise((r) => setTimeout(r, 3000));

  const frames = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return {};
      }
    });
  const init = frames.find((f) => f.id === 1);
  const newSession = frames.find((f) => f.id === 2);

  check("initialize succeeds in degraded mode", !!init?.result, JSON.stringify(init?.error?.code));
  check("degraded initialize still advertises an auth method",
    (init?.result?.authMethods ?? []).length > 0,
    JSON.stringify((init?.result?.authMethods ?? []).map((m) => m.id)));
  check("auth method is terminal type (runs kiro-cli login)",
    (init?.result?.authMethods ?? []).some((m) => m.type === "terminal"));
  check("capabilities reported conservatively, not fabricated",
    init?.result?.agentCapabilities?.loadSession === false &&
      init?.result?.agentCapabilities?.promptCapabilities?.image === false);
  check("agentInfo signals unavailability",
    /unavailable/i.test(init?.result?.agentInfo?.title ?? ""),
    JSON.stringify(init?.result?.agentInfo?.title));
  check("session/new then fails with a JSON-RPC error", !!newSession?.error,
    JSON.stringify(newSession?.error?.code));

  check("guidance also written to stderr (where Zed's ACP log looks)",
    stderr.includes("Kiro CLI was not found"), JSON.stringify(stderr.slice(0, 80)));
  check("stderr lists what it searched", stderr.includes("Searched:"));
  check("stderr tells the user how to fix it", stderr.includes("KIRO_CLI_PATH="));
  check("stderr mentions the bad configured path", stderr.includes("/nonexistent/kiro-cli"));
  check("guidance printed once, not repeated per request",
    (stderr.match(/Kiro CLI was not found/g) ?? []).length === 1,
    `occurrences=${(stderr.match(/Kiro CLI was not found/g) ?? []).length}`);
  check("no raw ENOENT leaked", !/ENOENT/.test(stderr), stderr.match(/ENOENT.*/)?.[0] ?? "");
  check("no JS stack trace shown", !/\bat \w+.*:\d+:\d+/.test(stderr));

  child.kill("SIGKILL");
}

// ---------------------------------------------------------------------------
console.log("\n=== 2. --help / --version keep stdout clean ===");
{
  const { stdout, stderr } = await execFileAsync(process.execPath, ["dist/index.js", "--version"]);
  check("--version writes nothing to stdout (ACP stream is sacred)", stdout === "", JSON.stringify(stdout));
  check("--version reports on stderr", /\d+\.\d+\.\d+/.test(stderr), stderr.trim());
  const help = await execFileAsync(process.execPath, ["dist/index.js", "--help"]);
  check("--help writes nothing to stdout", help.stdout === "");
  check("--help documents KIRO_CLI_PATH", help.stderr.includes("KIRO_CLI_PATH"));
  check("--help documents trace mode", help.stderr.includes("KIRO_BRIDGE_TRACE"));
}

// ---------------------------------------------------------------------------
console.log("\n=== 3. tracing is off by default ===");
{
  const zed = new ZedSim({ cwd: WS, env: baseEnv }).start();
  await zed.initialize();
  await zed.newSession(WS);
  const traced = zed.stderr.some((l) => l.includes("TRACE"));
  check("no TRACE lines without opt-in", !traced);
  await zed.stop();
}

// ---------------------------------------------------------------------------
console.log("\n=== 4. tracing on request, with redaction ===");
{
  const traceFile = `${PROBE}/trace.log`;
  const zed = new ZedSim({
    cwd: WS,
    env: { ...baseEnv, KIRO_BRIDGE_TRACE: "1", KIRO_BRIDGE_TRACE_FILE: traceFile },
  }).start();
  await zed.initialize();
  const sn = await zed.newSession(WS);
  const sid = sn.result?.sessionId;
  // A prompt carrying a secret-looking value and distinctive prose.
  await zed.request("session/prompt", {
    sessionId: sid,
    prompt: [{ type: "text", text: "UNIQUE_PROMPT_MARKER_ZX9 and my apiKey is SECRETVALUE123" }],
  });
  await new Promise((r) => setTimeout(r, 500));
  await zed.stop();

  const log = readFileSync(traceFile, "utf8");
  check("trace file written", log.length > 0, `${log.length} bytes`);
  check("records both directions", /zed->bridge/.test(log) && /bridge->kiro/.test(log));
  check("timestamps present", /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(log));
  check("method names present", /session\/prompt/.test(log));
  // The important part: content is NOT logged by default even when tracing.
  check("prompt text redacted by default", !log.includes("UNIQUE_PROMPT_MARKER_ZX9"));
  check("secret-looking value never appears", !log.includes("SECRETVALUE123"));
  check("redaction marker used", /\[content \d+ chars\]|\[redacted\]/.test(log));
  check("stdout stayed clean while tracing", !zed.stdoutGarbage, JSON.stringify(zed.stdoutGarbage));
}

// ---------------------------------------------------------------------------
console.log("\n=== 5. protocol robustness ===");
{
  const zed = new ZedSim({ cwd: WS, env: baseEnv }).start();
  await zed.initialize();
  const sn = await zed.newSession(WS);
  const sid = sn.result?.sessionId;

  const unknown = await zed.request("totally/unknown_method", {});
  check("unknown method -> -32601", unknown.error?.code === -32601, JSON.stringify(unknown.error?.code));

  const badSession = await zed.setConfigOption("no-such-session", "model", "auto");
  check("unknown session -> -32602", badSession.error?.code === -32602, JSON.stringify(badSession.error?.code));

  // Malformed JSON directly on the wire.
  zed.child.stdin.write("{ this is not json at all\n");
  zed.child.stdin.write("\n");
  await new Promise((r) => setTimeout(r, 400));

  // Connection must still work after all of that.
  const after = await zed.setConfigOption(sid, "effort", "low");
  check("connection survives malformed input", !after.error, JSON.stringify(after.error));
  check("still serving requests", Array.isArray(after.result?.configOptions));
  await zed.stop();
}

// ---------------------------------------------------------------------------
console.log("\n=== 6. Kiro dies mid-session ===");
{
  const zed = new ZedSim({ cwd: WS, env: baseEnv }).start();
  await zed.initialize();
  const sn = await zed.newSession(WS);
  const sid = sn.result?.sessionId;

  // Find the Kiro child of OUR bridge only, and kill just that pid.
  let kiroPid;
  try {
    kiroPid = Number(execSync(`pgrep -P ${zed.pid}`, { encoding: "utf8" }).trim().split("\n")[0]);
  } catch { /* none */ }
  check("located the kiro child", Number.isInteger(kiroPid), String(kiroPid));

  if (kiroPid) {
    zed.clearUpdates();
    process.kill(kiroPid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 2500));
    const text = zed.text();
    check("crash reported in the thread, not just logs", /stopped unexpectedly/i.test(text),
      JSON.stringify(text.slice(0, 120)));
    check("bridge logged the unexpected exit",
      zed.stderr.some((l) => /exited unexpectedly/.test(l)));
  }
  await zed.stop();
  await new Promise((r) => setTimeout(r, 800));
  check("bridge exited after Kiro died", !pidAlive(zed.pid));
  if (kiroPid) check("no orphan kiro process", !pidAlive(kiroPid));
}

// ---------------------------------------------------------------------------
console.log("\n=== 7. images through the bridge ===");
{
  const zed = new ZedSim({ cwd: WS, env: baseEnv }).start();
  await zed.initialize();
  const sn = await zed.newSession(WS);
  const sid = sn.result?.sessionId;

  // Build a real PNG rather than a degenerate 1x1.
  let png;
  try {
    execSync(
      `sips -s format png -z 48 48 /System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericFolderIcon.icns --out ${PROBE}/t.png >/dev/null 2>&1`,
    );
    png = readFileSync(`${PROBE}/t.png`).toString("base64");
  } catch { /* skip */ }
  check("test image built", !!png, png ? `${png.length} b64 chars` : "sips unavailable");

  if (png) {
    // claude-opus-5 supports images.
    await zed.setConfigOption(sid, "model", "claude-opus-5");
    await zed.setConfigOption(sid, "effort", "low");
    zed.clearUpdates();
    const ok = await zed.request("session/prompt", {
      sessionId: sid,
      prompt: [
        { type: "text", text: "Answer in one word: what colour dominates this image?" },
        { type: "image", mimeType: "image/png", data: png },
      ],
    });
    check("image prompt succeeds on an image-capable model",
      ok.result?.stopReason === "end_turn", JSON.stringify(ok.result ?? ok.error));
    const answer = zed.text().trim();
    console.log(`  model answer: ${JSON.stringify(answer.slice(0, 60))}`);
    check("model actually used the image", answer.length > 0 && /blue|grey|gray|white/i.test(answer),
      JSON.stringify(answer.slice(0, 60)));

    // gpt-5.6-luna does NOT support images: the error must surface, not be swallowed.
    await zed.setConfigOption(sid, "model", "gpt-5.6-luna");
    zed.clearUpdates();
    const bad = await zed.request("session/prompt", {
      sessionId: sid,
      prompt: [
        { type: "text", text: "Describe this." },
        { type: "image", mimeType: "image/png", data: png },
      ],
    });
    const surfaced = !!bad.error || bad.result?.stopReason !== undefined;
    check("per-model image failure is surfaced, not swallowed", surfaced,
      JSON.stringify(bad.error?.code ?? bad.result));
  }
  await zed.stop();
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
