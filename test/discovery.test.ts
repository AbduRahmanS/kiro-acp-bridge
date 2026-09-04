import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverKiroCli, KiroNotFoundError } from "../src/kiro/discovery.js";

let root: string;
let binDir: string;
let fakeKiro: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kiro-discovery-"));
  binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  fakeKiro = join(binDir, "kiro-cli");
  writeFileSync(fakeKiro, "#!/bin/sh\necho fake\n");
  chmodSync(fakeKiro, 0o755);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("discoverKiroCli", () => {
  it("prefers an absolute KIRO_CLI_PATH override", () => {
    const res = discoverKiroCli({
      env: { KIRO_CLI_PATH: fakeKiro, PATH: "" } as NodeJS.ProcessEnv,
    });
    expect(res.path).toBe(fakeKiro);
    expect(res.source).toBe("override");
  });

  it("prefers an explicit option over the environment", () => {
    const res = discoverKiroCli({
      override: fakeKiro,
      env: { KIRO_CLI_PATH: "/nonexistent/kiro-cli", PATH: "" } as NodeJS.ProcessEnv,
    });
    expect(res.path).toBe(fakeKiro);
  });

  it("finds the executable on PATH", () => {
    const res = discoverKiroCli({ env: { PATH: binDir } as NodeJS.ProcessEnv });
    expect(res.path).toBe(fakeKiro);
    expect(res.source).toBe("path");
  });

  it("falls back to well-known locations when PATH misses", () => {
    // ~/.local/bin is a documented Kiro install target.
    const home = join(root, "home");
    const localBin = join(home, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const target = join(localBin, "kiro-cli");
    writeFileSync(target, "#!/bin/sh\n");
    chmodSync(target, 0o755);

    const res = discoverKiroCli({
      env: { PATH: join(root, "empty"), HOME: home } as NodeJS.ProcessEnv,
      wellKnownDirs: [localBin],
    });
    expect(res.path).toBe(target);
    expect(res.source).toBe("well-known");
  });

  it("ignores non-executable files", () => {
    const dir = join(root, "noexec");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "kiro-cli");
    writeFileSync(f, "not executable");
    chmodSync(f, 0o644);
    expect(() =>
      discoverKiroCli({ env: { PATH: dir } as NodeJS.ProcessEnv, wellKnownDirs: [] }),
    ).toThrow(KiroNotFoundError);
  });

  it("throws an actionable error listing what was searched", () => {
    let caught: KiroNotFoundError | undefined;
    try {
      discoverKiroCli({
        env: { PATH: join(root, "missing") } as NodeJS.ProcessEnv,
        wellKnownDirs: [],
      });
    } catch (err) {
      caught = err as KiroNotFoundError;
    }
    expect(caught).toBeInstanceOf(KiroNotFoundError);
    // The message must be actionable, not a bare ENOENT.
    expect(caught!.message).toContain("Kiro CLI was not found");
    expect(caught!.message).toContain("Searched:");
    expect(caught!.message).toContain("KIRO_CLI_PATH=");
    expect(caught!.searched.length).toBeGreaterThan(0);
  });

  it("reports the attempted override path when an absolute override is bad", () => {
    let caught: KiroNotFoundError | undefined;
    try {
      discoverKiroCli({ override: "/definitely/not/here/kiro-cli", env: {} as NodeJS.ProcessEnv });
    } catch (err) {
      caught = err as KiroNotFoundError;
    }
    expect(caught!.message).toContain("/definitely/not/here/kiro-cli");
    expect(caught!.message).toContain("configured executable path");
  });
});


describe("discoverKiroCli — environment hygiene", () => {
  it("ignores Kiro's internal KIRO_CHAT_CLI_BIN variable", () => {
    // Regression guard. KIRO_CHAT_CLI_BIN is exported inside every Kiro CLI
    // session and points at an internal binary. Honouring it would make the
    // bridge launch a different executable depending on where it was started,
    // which is exactly the kind of silent divergence we must not ship.
    const res = discoverKiroCli({
      env: {
        KIRO_CHAT_CLI_BIN: "/some/internal/chat-cli-2.21.0",
        PATH: binDir,
      } as NodeJS.ProcessEnv,
      wellKnownDirs: [],
    });
    expect(res.path).toBe(fakeKiro);
    expect(res.source).toBe("path");
  });
});
