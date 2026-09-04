/**
 * Ownership of the child `kiro-cli acp` process.
 *
 * The bridge owns exactly one Kiro process per bridge instance and is
 * responsible for reaping it. Two hazards drive the design here, both observed
 * in real Kiro builds:
 *
 *  - Kiro issue #10258: an abandoned `kiro-cli-chat acp` can busy-wait at high
 *    CPU, so a leaked child is expensive, not merely untidy.
 *  - Kiro issue #10666: a session-ownership lock can outlive its owner, after
 *    which `session/load` refuses the session. Clean shutdown protects the
 *    user's future sessions, not just this process.
 *
 * Shutdown therefore escalates: close stdin (Kiro's normal EOF exit path), then
 * SIGTERM, then SIGKILL, each with a bounded grace period.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { Diagnostics } from "../diagnostics/logging.js";
import { discoverKiroCli, type DiscoveryResult } from "./discovery.js";

/**
 * The agent engine to run Kiro with.
 *
 * Pinned to v2 deliberately. Probing v3 (kiro-cli 2.21.0) showed `session/new`
 * failing outright and every `_kiro.dev/*` extension rejected with an internal
 * "PersistenceClassification" error, which matches Kiro issues #10761/#10877.
 * v3 also moves extensions to a different `_kiro/*` namespace. Until v3's ACP
 * surface is usable, v2 is the only viable target.
 */
export const DEFAULT_AGENT_ENGINE = "v2";

export interface KiroProcessOptions {
  /** Explicit executable path; otherwise discovered. */
  executablePath?: string | undefined;
  /** Agent engine passed to `kiro-cli acp --agent-engine`. */
  agentEngine?: string;
  /** Extra arguments appended after the engine flag. */
  extraArgs?: readonly string[];
  /** Working directory for the child. */
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv;
  diagnostics: Diagnostics;
  /** Called if the child exits unexpectedly (i.e. not via `shutdown()`). */
  onUnexpectedExit?: (info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }) => void;
}

/** Grace periods for the shutdown escalation, in milliseconds. */
const STDIN_EOF_GRACE_MS = 1500;
const SIGTERM_GRACE_MS = 2000;

export class KiroProcess {
  readonly discovery: DiscoveryResult;
  readonly args: readonly string[];

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly diagnostics: Diagnostics;
  private readonly stderrRing: string[] = [];
  private shuttingDown = false;
  private exited = false;
  private readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(options: KiroProcessOptions) {
    this.diagnostics = options.diagnostics;
    this.discovery = discoverKiroCli({
      override: options.executablePath,
      env: options.env ?? process.env,
    });

    const engine = options.agentEngine ?? DEFAULT_AGENT_ENGINE;
    // Fixed argv array, never a shell string: no interpolation, no injection.
    this.args = ["acp", "--agent-engine", engine, ...(options.extraArgs ?? [])];

    this.diagnostics.info("spawning kiro-cli", {
      path: this.discovery.path,
      source: this.discovery.source,
      args: this.args,
    });

    this.child = spawn(this.discovery.path, [...this.args], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    this.child.on("error", (err) => {
      this.diagnostics.error("kiro-cli process error", { message: (err as Error).message });
    });

    // Kiro's stderr is diagnostics only; keep a tail for crash reports.
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        this.diagnostics.kiroStderr(line);
        this.stderrRing.push(line);
        if (this.stderrRing.length > 100) this.stderrRing.shift();
      }
    });

    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code, signal) => {
        this.exited = true;
        this.diagnostics.info("kiro-cli exited", { code, signal, expected: this.shuttingDown });
        if (!this.shuttingDown) {
          options.onUnexpectedExit?.({
            code,
            signal,
            stderrTail: this.stderrRing.slice(-20).join("\n"),
          });
        }
        resolve({ code, signal });
      });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  /** Recent Kiro stderr, for surfacing in error messages. */
  stderrTail(lines = 20): string {
    return this.stderrRing.slice(-lines).join("\n");
  }

  /** Web streams over the child's stdio, for `ndJsonStream`. */
  streams(): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } {
    return {
      readable: Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
      writable: Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
    };
  }

  /** Resolves when the child exits. */
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.exitPromise;
  }

  /**
   * Shuts the child down, escalating until it is gone.
   *
   * Safe to call repeatedly and safe to call after the child has already exited.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      await this.exitPromise;
      return;
    }
    this.shuttingDown = true;

    if (this.exited) return;

    const pid = this.child.pid;
    this.diagnostics.info("shutting down kiro-cli", { pid });

    // Stage 1: stdin EOF. Kiro's documented clean exit path.
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    if (await this.exitedWithin(STDIN_EOF_GRACE_MS)) return;

    // Stage 2: SIGTERM. Only ever our own child's pid.
    this.diagnostics.warn("kiro-cli did not exit on stdin EOF; sending SIGTERM", { pid });
    this.signalChild("SIGTERM");
    if (await this.exitedWithin(SIGTERM_GRACE_MS)) return;

    // Stage 3: SIGKILL.
    this.diagnostics.warn("kiro-cli did not exit on SIGTERM; sending SIGKILL", { pid });
    this.signalChild("SIGKILL");
    await this.exitPromise;
  }

  private signalChild(signal: NodeJS.Signals): void {
    if (this.exited) return;
    try {
      this.child.kill(signal);
    } catch (err) {
      this.diagnostics.warn("failed to signal kiro-cli", {
        signal,
        message: (err as Error).message,
      });
    }
  }

  private exitedWithin(ms: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.exited), ms);
      // Do not hold the event loop open just for this race.
      timer.unref?.();
      void this.exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
