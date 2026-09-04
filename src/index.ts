#!/usr/bin/env node
/**
 * Executable entry point.
 *
 * Two invariants are established before anything else happens:
 *
 *  1. **stdout is reserved for the ACP JSON-RPC stream.** Any stray `console.log`
 *     — from this code or from a dependency — would corrupt the protocol and
 *     Zed would drop the connection. The console is therefore redirected to
 *     stderr up front.
 *  2. **The child process is always reaped.** Signals and transport close both
 *     route through the same shutdown path so a `kiro-cli acp` child cannot be
 *     orphaned (Kiro issue #10258 makes an orphan expensive: it busy-waits).
 */

// 1. Protect stdout. Must run before any other import can log.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

import { Diagnostics, diagnosticsFromEnv } from "./diagnostics/logging.js";
import { KiroBridge, BRIDGE_VERSION } from "./bridge/bridge.js";
import { KiroNotFoundError, discoverKiroCli } from "./kiro/discovery.js";
import { LOGIN_FLAG } from "./bridge/auth.js";

function printUsage(): void {
  process.stderr.write(
    [
      `kiro-acp-bridge ${BRIDGE_VERSION}`,
      "",
      "An Agent Client Protocol bridge that fronts `kiro-cli acp`, giving ACP",
      "clients such as Zed native model, reasoning-effort and agent selectors",
      "plus dynamic Kiro slash commands.",
      "",
      "Usage:",
      "  kiro-acp-bridge              speak ACP over stdio (how Zed runs it)",
      "  kiro-acp-bridge --login      interactive Kiro sign-in (ACP terminal auth)",
      "  kiro-acp-bridge --version    print version",
      "  kiro-acp-bridge --help       this message",
      "",
      "Environment:",
      "  KIRO_CLI_PATH                explicit path to the kiro-cli executable",
      "  KIRO_BRIDGE_AGENT_ENGINE     Kiro agent engine (default: v2)",
      "  KIRO_BRIDGE_LOG_LEVEL        error|warn|info|debug|trace (default: warn)",
      "  KIRO_BRIDGE_TRACE=1          log sanitised JSON-RPC frames to stderr",
      "  KIRO_BRIDGE_TRACE_CONTENT=1  include prompt text in traces (off by default)",
      "  KIRO_BRIDGE_TRACE_FILE       also append traces to this file",
      "",
      "Diagnostics go to stderr; stdout carries only the ACP stream.",
      "",
    ].join("\n"),
  );
}

/**
 * Interactive sign-in, invoked as `kiro-acp-bridge --login`.
 *
 * This is the agent side of ACP Terminal Auth: the client re-runs this binary
 * with replacement arguments, we hand the terminal to `kiro-cli login`, and the
 * exit code reports the outcome. Credentials are handled entirely by Kiro — the
 * bridge only transfers control.
 *
 * Any arguments after `--login` are forwarded, so `--license pro`,
 * `--use-device-flow` and friends all work.
 */
async function runLogin(argv: string[]): Promise<number> {
  const passthrough = argv.slice(argv.indexOf(LOGIN_FLAG) + 1);
  let kiroPath: string;
  try {
    kiroPath = discoverKiroCli({ override: process.env.KIRO_CLI_PATH }).path;
  } catch (err) {
    if (err instanceof KiroNotFoundError) {
      process.stderr.write(`\n${err.message}\n\n`);
      return 127;
    }
    throw err;
  }

  const { spawn } = await import("node:child_process");
  process.stderr.write(`Running: kiro-cli login ${passthrough.join(" ")}\n\n`);

  return await new Promise<number>((resolve) => {
    // stdio is inherited so Kiro owns the terminal for its interactive flow.
    const child = spawn(kiroPath, ["login", ...passthrough], {
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    child.on("error", (e) => {
      process.stderr.write(`Failed to start kiro-cli login: ${e.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        process.stderr.write(`\nkiro-cli login terminated by ${signal}\n`);
        resolve(1);
        return;
      }
      if (code === 0) process.stderr.write("\nSigned in. You can close this and return to your editor.\n");
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // `--login` is a mode, not a flag, and everything after it is forwarded to
  // `kiro-cli login`. It is therefore checked FIRST, so that
  // `kiro-acp-bridge --login --help` shows Kiro's login help rather than ours.
  // Checked before the ACP path too, so the setup flow never touches stdout.
  if (argv.includes(LOGIN_FLAG)) {
    process.exit(await runLogin(argv));
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    process.exit(0);
  }
  if (argv.includes("--version") || argv.includes("-V")) {
    process.stderr.write(`${BRIDGE_VERSION}\n`);
    process.exit(0);
  }

  const diagnostics = new Diagnostics(diagnosticsFromEnv());
  const bridge = new KiroBridge({
    diagnostics,
    kiroPath: process.env.KIRO_CLI_PATH,
    agentEngine: process.env.KIRO_BRIDGE_AGENT_ENGINE,
    cwd: process.cwd(),
    env: process.env,
  });

  let exiting = false;
  const stop = async (code: number) => {
    if (exiting) return;
    exiting = true;
    try {
      await bridge.shutdown();
    } catch (err) {
      diagnostics.error("error during shutdown", { message: (err as Error).message });
    }
    process.exit(code);
  };

  // Preserve conventional 128+N exit codes while still reaping the child.
  process.on("SIGINT", () => void stop(130));
  process.on("SIGTERM", () => void stop(143));
  process.on("SIGHUP", () => void stop(129));

  process.on("uncaughtException", (err) => {
    diagnostics.error("uncaught exception", { message: err.message, stack: err.stack });
    void stop(1);
  });
  process.on("unhandledRejection", (reason) => {
    diagnostics.error("unhandled rejection", { reason: String(reason) });
  });

  try {
    await bridge.serve();
    await stop(0);
  } catch (err) {
    if (err instanceof KiroNotFoundError) {
      // This is the single most likely first-run failure. It must be readable
      // as-is, not buried in a stack trace.
      process.stderr.write(`\n${err.message}\n\n`);
      await stop(127);
      return;
    }
    diagnostics.error("fatal bridge error", {
      message: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.stderr.write(`\nkiro-acp-bridge failed: ${(err as Error).message}\n`);
    await stop(1);
  }
}

void main();
