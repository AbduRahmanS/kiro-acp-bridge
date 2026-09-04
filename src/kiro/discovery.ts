/**
 * Locating the `kiro-cli` executable.
 *
 * Zed launches agent servers with a minimal environment — notably a PATH that
 * often lacks the user's shell additions — so PATH lookup alone is not enough.
 * We search a documented list of locations and, on failure, report exactly what
 * was tried so the user gets an actionable message instead of a bare ENOENT.
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export interface DiscoveryResult {
  /** Absolute path to the executable. */
  path: string;
  /** How it was found, for diagnostics. */
  source: "override" | "path" | "well-known";
}

export class KiroNotFoundError extends Error {
  readonly searched: readonly string[];

  constructor(searched: readonly string[], overrideAttempted?: string) {
    const lines = [
      "Kiro CLI was not found.",
      "",
      overrideAttempted
        ? `The configured executable path did not exist or was not executable:\n  ${overrideAttempted}\n`
        : "",
      "Searched:",
      ...searched.map((s) => `  ${s}`),
      "",
      "To fix this, either:",
      "  1. Install Kiro CLI and make sure `kiro-cli` is on your PATH, or",
      "  2. Set the executable explicitly:",
      "       KIRO_CLI_PATH=/full/path/to/kiro-cli",
      "     or in Zed settings.json:",
      '       "agent_servers": { "Kiro": { "type": "custom", "command": "npx",',
      '         "args": ["-y","kiro-acp-bridge"], "env": { "KIRO_CLI_PATH": "/full/path/to/kiro-cli" } } }',
      "",
      "Verify your install with:  kiro-cli --version",
    ];
    super(lines.filter((l) => l !== "").join("\n"));
    this.name = "KiroNotFoundError";
    this.searched = searched;
  }
}

function isExecutableFile(p: string): boolean {
  try {
    if (!existsSync(p)) return false;
    const st = statSync(p);
    if (!st.isFile()) return false;
    // On Windows the executable bit is not meaningful; existence is enough.
    if (platform() === "win32") return true;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Executable basenames to try, in preference order. */
function candidateNames(): string[] {
  return platform() === "win32" ? ["kiro-cli.exe", "kiro-cli.cmd", "kiro-cli"] : ["kiro-cli"];
}

/** Well-known install locations per platform. */
function wellKnownDirectories(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const dirs: string[] = [];

  // Kiro's own installer target on macOS/Linux.
  dirs.push(join(home, ".local", "bin"));

  if (platform() === "darwin") {
    // The app bundle ships the real binaries; ~/.local/bin usually symlinks here.
    dirs.push("/Applications/Kiro CLI.app/Contents/MacOS");
    dirs.push(join(home, "Applications", "Kiro CLI.app", "Contents", "MacOS"));
    dirs.push("/opt/homebrew/bin");
    dirs.push("/usr/local/bin");
  } else if (platform() === "win32") {
    const localAppData = env.LOCALAPPDATA;
    const programFiles = env.ProgramFiles;
    if (localAppData) {
      dirs.push(join(localAppData, "Programs", "kiro-cli", "bin"));
      dirs.push(join(localAppData, "kiro-cli", "bin"));
    }
    if (programFiles) dirs.push(join(programFiles, "Kiro CLI"));
  } else {
    dirs.push("/usr/local/bin");
    dirs.push("/usr/bin");
    dirs.push("/opt/kiro-cli/bin");
    dirs.push(join(home, "bin"));
  }

  return dirs;
}

export interface DiscoverOptions {
  /** Explicit path that takes precedence over all searching. */
  override?: string | undefined;
  env?: NodeJS.ProcessEnv;
  /**
   * Replaces the built-in well-known directory list.
   *
   * Production callers normally omit this. It exists so tests can be hermetic
   * (the built-in list includes real system paths, which on a developer machine
   * would otherwise find the genuine install) and so an embedder can supply
   * extra locations without patching this module.
   */
  wellKnownDirs?: readonly string[];
}

/**
 * Finds `kiro-cli`, throwing {@link KiroNotFoundError} with the full search
 * list if it cannot be located.
 */
export function discoverKiroCli(options: DiscoverOptions = {}): DiscoveryResult {
  const env = options.env ?? process.env;
  const searched: string[] = [];

  // 1. Explicit override — env var or caller-supplied.
  //
  // Only KIRO_CLI_PATH is honoured here. Kiro's own internal variables (notably
  // KIRO_CHAT_CLI_BIN) are deliberately NOT consulted: they are set inside any
  // Kiro CLI session and point at internal binaries, so honouring them would
  // make the bridge silently launch a different executable depending on where
  // it happened to be started from.
  const override = options.override ?? env.KIRO_CLI_PATH;
  if (override) {
    // A bare name in the override still needs resolving through PATH.
    if (isAbsolute(override)) {
      if (isExecutableFile(override)) return { path: override, source: "override" };
      throw new KiroNotFoundError([override], override);
    }
    searched.push(`${override} (relative override, resolved via PATH)`);
  }

  // 2. PATH lookup.
  const pathVar = env.PATH ?? env.Path ?? "";
  const pathDirs = pathVar.split(delimiter).filter(Boolean);
  const names = override && !isAbsolute(override) ? [override] : candidateNames();
  for (const dir of pathDirs) {
    for (const name of names) {
      const full = join(dir, name);
      searched.push(full);
      if (isExecutableFile(full)) return { path: full, source: "path" };
    }
  }

  // 3. Well-known locations.
  for (const dir of options.wellKnownDirs ?? wellKnownDirectories(env)) {
    for (const name of candidateNames()) {
      const full = join(dir, name);
      if (searched.includes(full)) continue;
      searched.push(full);
      if (isExecutableFile(full)) return { path: full, source: "well-known" };
    }
  }

  throw new KiroNotFoundError(searched, isAbsolute(override ?? "") ? override : undefined);
}
