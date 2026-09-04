#!/usr/bin/env node
/**
 * Task 1 verification: spawn the real `kiro-cli acp`, complete the ACP
 * handshake through KiroConnection, print what Kiro advertises, then shut down
 * and prove no process was leaked.
 *
 * Runs against ./dist, so `npm run build` first.
 *
 * Isolation: uses KIRO_DATA_DIR so it never writes into ~/.kiro.
 */
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { Diagnostics } from "../dist/diagnostics/logging.js";
import { KiroConnection } from "../dist/kiro/connection.js";

const PROBE_DIR = "/tmp/kiro-bridge-handshake";
mkdirSync(`${PROBE_DIR}/datadir`, { recursive: true });

const diagnostics = new Diagnostics({ level: "info" });

const noopHandlers = {
  sessionUpdate() {},
  async requestPermission() {
    return { outcome: { outcome: "cancelled" } };
  },
  async readTextFile() {
    return { content: "" };
  },
  async writeTextFile() {
    return {};
  },
  extensionNotification(method) {
    console.log(`  notification: ${method}`);
  },
};

const conn = await KiroConnection.spawn({
  diagnostics,
  handlers: noopHandlers,
  cwd: process.cwd(),
  env: {
    ...process.env,
    KIRO_DATA_DIR: `${PROBE_DIR}/datadir`,
    KIRO_DISABLE_TELEMETRY: "1",
    KIRO_DISABLE_SESSION_SEARCH_INDEX: "1",
  },
});

const pid = conn.process.pid;
console.log(`\nresolved kiro-cli: ${conn.process.discovery.path} (${conn.process.discovery.source})`);
console.log(`args:              ${conn.process.args.join(" ")}`);
console.log(`child pid:         ${pid}\n`);

const init = await conn.initialize({
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: false,
    session: { configOptions: { boolean: {} } },
    elicitation: { form: {}, url: {} },
  },
  clientInfo: { name: "kiro-acp-bridge-handshake", version: "0.1.0" },
});

console.log("=== Kiro initialize response ===");
console.log(`  protocolVersion:  ${init.protocolVersion}`);
console.log(`  agentInfo:        ${JSON.stringify(init.agentInfo)}`);
console.log(`  loadSession:      ${init.agentCapabilities?.loadSession}`);
console.log(`  promptCaps:       ${JSON.stringify(init.agentCapabilities?.promptCapabilities)}`);
console.log(`  mcpCaps:          ${JSON.stringify(init.agentCapabilities?.mcpCapabilities)}`);
console.log(`  sessionCaps:      ${JSON.stringify(init.agentCapabilities?.sessionCapabilities)}`);
console.log(`  authMethods:      ${JSON.stringify(init.authMethods)}`);

console.log("\n=== shutting down ===");
await conn.shutdown();
console.log(`  child exited: ${conn.process.hasExited}`);

// Prove no orphan remains.
let alive = true;
try {
  execSync(`ps -p ${pid}`, { stdio: "ignore" });
} catch {
  alive = false;
}
console.log(`  pid ${pid} still alive: ${alive}`);
diagnostics.close();

if (alive) {
  console.error("FAIL: orphaned kiro-cli process");
  process.exit(1);
}
console.log("\nOK: handshake completed and child reaped cleanly.");
process.exit(0);
