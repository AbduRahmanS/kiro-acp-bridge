/**
 * Noticing new models without the user having to ask.
 *
 * Kiro loads its model list once per process, and Zed keeps one agent process
 * for every thread, so a model Kiro releases mid-day stays invisible — the exact
 * failure that prompted this module. The bridge therefore compares the list the
 * running Kiro loaded with what `kiro-cli chat --list-models` reports now, and
 * reloads Kiro when they differ.
 *
 * `--list-models` is a separate, read-only invocation: measured on 2.28 it takes
 * ~4 s, creates no files, and occasionally fails with a transient "dispatch
 * failure". A failure simply means "unknown"; it never triggers anything.
 */

import { spawn } from "node:child_process";
import { z } from "zod";

const listModelsSchema = z.object({
  models: z.array(z.object({ model_id: z.string() }).passthrough()),
});

/** Default minimum gap between checks. Override with `KIRO_BRIDGE_MODEL_CHECK_MINUTES`; `0` disables. */
export const DEFAULT_CHECK_MINUTES = 10;

export function checkIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.KIRO_BRIDGE_MODEL_CHECK_MINUTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CHECK_MINUTES * 60_000;
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
}

/** Parses `kiro-cli chat --list-models --format json`. Undefined when unusable. */
export function parseModelList(stdout: string): string[] | undefined {
  try {
    const parsed = listModelsSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data.models.map((m) => m.model_id) : undefined;
  } catch {
    return undefined;
  }
}

/** Asks kiro-cli which models the account can use right now. Never throws. */
export function fetchModelIds(
  kiroPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    let stdout = "";
    let done = false;
    const finish = (v: string[] | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child;
    try {
      // Fixed argv, no shell.
      child = spawn(kiroPath, ["chat", "--list-models", "--format", "json"], {
        stdio: ["ignore", "pipe", "ignore"],
        env,
        shell: false,
        windowsHide: true,
      });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
      if (stdout.length > 1_000_000) child.kill("SIGKILL");
    });
    child.on("error", () => finish(undefined));
    child.on("exit", (code) => finish(code === 0 ? parseModelList(stdout) : undefined));
  });
}

export interface RosterDiff {
  added: string[];
  removed: string[];
}

/** What changed between two model lists. `auto` is a router, not news, and is ignored. */
export function diffRoster(before: readonly string[], after: readonly string[]): RosterDiff {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((m) => !b.has(m) && m !== "auto"),
    removed: before.filter((m) => !a.has(m) && m !== "auto"),
  };
}

export function hasChanges(d: RosterDiff): boolean {
  return d.added.length > 0 || d.removed.length > 0;
}

/**
 * One-line Markdown summary of a change, using display names.
 *
 * `loaded` says whether the running Kiro already offers the change (after a
 * reload) or the user still has to run `/restart-kiro`.
 */
export function describeChange(d: RosterDiff, nameOf: (id: string) => string, loaded = true): string {
  const parts: string[] = [];
  if (d.added.length > 0) {
    const names = d.added.map((m) => nameOf(m)).join(", ");
    const plural = d.added.length > 1 ? "s" : "";
    parts.push(
      loaded
        ? `**New model${plural} available:** ${names} — now in the model picker.`
        : `**New model${plural} available:** ${names}. Type \`/restart-kiro\` to load ${d.added.length > 1 ? "them" : "it"}; this thread continues.`,
    );
  }
  if (d.removed.length > 0) {
    parts.push(`No longer offered: ${d.removed.map((m) => nameOf(m)).join(", ")}.`);
  }
  return parts.join(" ");
}
