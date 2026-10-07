/**
 * An isolated home directory for running the REAL kiro-cli in tests.
 *
 * Measured on kiro-cli 2.28 (see docs/safety-isolation-plan.md, "Correction 2"):
 *
 *   - `KIRO_DATA_DIR` does not isolate session storage (v2), and
 *   - `KIRO_HOME` is ignored by the V3 engine, which wrote sessions, logs and a
 *     session index into the real `~/.kiro` during probing.
 *   - Replacing `HOME` alone isolates everything but signs Kiro out, because the
 *     auth store lives in the platform data directory under `HOME`, and
 *     `kiro-cli` launches `$HOME/.local/bin/kiro-cli-chat`.
 *
 * So the sandbox is a fake `HOME` whose `.kiro` is empty and private, with two
 * symlinks back to the real install: the data directory (auth) and
 * `.local/bin` (the binaries). Every Kiro write we care about — sessions,
 * settings, agents, MCP config, V3 logs and index — lands in the sandbox.
 *
 * The sandbox is persistent and shared between runs on purpose: v2 downloads a
 * ~90 MB semantic-search model into `~/.semantic_search` on first use.
 */

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export const SANDBOX_ROOT = process.env.KIRO_BRIDGE_SANDBOX ?? "/tmp/kiro-bridge-sandbox";
export const SANDBOX_HOME = join(SANDBOX_ROOT, "home");

/** The platform data directory, relative to HOME, as Kiro resolves it. */
function dataDirRelative() {
  if (platform() === "darwin") return join("Library", "Application Support", "kiro-cli");
  if (platform() === "win32") throw new Error("The e2e sandbox is not implemented for Windows.");
  return join(".local", "share", "kiro-cli");
}

function link(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) || isSymlink(path)) return;
  symlinkSync(target, path);
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Prepares the sandbox and returns env overrides for a Kiro child.
 *
 * @param {{ fresh?: boolean }} [opts] `fresh` wipes the sandbox's `.kiro` first.
 */
export function sandboxEnv(opts = {}) {
  const realHome = homedir();
  if (realHome === SANDBOX_HOME) throw new Error("Refusing to nest the sandbox inside itself.");
  if (opts.fresh) rmSync(join(SANDBOX_HOME, ".kiro"), { recursive: true, force: true });
  mkdirSync(join(SANDBOX_HOME, ".kiro"), { recursive: true });
  link(join(realHome, dataDirRelative()), join(SANDBOX_HOME, dataDirRelative()));
  link(join(realHome, ".local", "bin"), join(SANDBOX_HOME, ".local", "bin"));
  return {
    HOME: SANDBOX_HOME,
    KIRO_DISABLE_TELEMETRY: "1",
    KIRO_DISABLE_SESSION_SEARCH_INDEX: "1",
    // Explicit, so discovery cannot resolve a different binary via the fake HOME.
    KIRO_CLI_PATH: process.env.KIRO_CLI_PATH ?? join(realHome, ".local", "bin", "kiro-cli"),
  };
}
