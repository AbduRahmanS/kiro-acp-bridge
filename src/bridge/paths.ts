/**
 * Path normalisation for tool calls.
 *
 * ACP is unambiguous: all paths MUST be absolute. Kiro violates this in two
 * distinct ways, both reproduced against kiro-cli 2.21.0:
 *
 *  1. `toolCall.locations[].path` is **relative** — observed as `"probe_out.txt"`.
 *     Zed uses `locations` to open and highlight files, so a relative path either
 *     fails to resolve or resolves against the wrong directory.
 *
 *  2. `toolCall.content[].diff.path` is absolute but resolved against the **Kiro
 *     process's** working directory rather than the **session's** `cwd`. With the
 *     process started in `/Users/…/kiro-zed-acp` and a session cwd of
 *     `/tmp/kiro-probe/ws`, Kiro reported `/Users/…/kiro-zed-acp/probe_out.txt`
 *     while actually writing `/tmp/kiro-probe/ws/probe_out.txt`. Zed would show
 *     the diff against a path that does not exist — or worse, against an
 *     unrelated real file with the same name.
 *
 * Both are corrected here so the rule lives in one place and is directly
 * testable against the captured payloads.
 *
 * The correction is deliberately conservative: an absolute path is only rebased
 * when Kiro's own `rawInput` proves the path started out relative. We never probe
 * the filesystem to decide, because a translation layer that consults the disk
 * would behave differently depending on timing.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface PathContext {
  /** The `cwd` of the ACP session — the authoritative base. */
  sessionCwd: string;
  /** The working directory the Kiro child process was started in. */
  kiroProcessCwd: string;
}

/** Pulls a usable relative path out of a tool call's `rawInput`, if present. */
export function relativeHintFromRawInput(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const obj = rawInput as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "file"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0 && !isAbsolute(v)) return v;
  }
  return undefined;
}

/**
 * Symlink-resolved spellings of `p`, computed without requiring `p` to exist.
 *
 * Resolving the deepest existing ancestor and re-appending the remainder means
 * normalisation works even when the directory has not been created yet — which
 * happens routinely, since a tool call may reference a file in a directory the
 * tool is about to create.
 */
function canonicalCandidates(p: string): string[] {
  const abs = resolve(p);
  const out = new Set<string>([abs]);

  let ancestor = abs;
  const tail: string[] = [];
  // Walk up until something exists (or we hit the root).
  for (;;) {
    try {
      const real = realpathSync(ancestor);
      out.add(tail.length ? join(real, ...tail) : real);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      tail.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  return [...out];
}

/**
 * True when two paths denote the same directory, tolerating symlinks and
 * non-existent paths.
 *
 * macOS makes this necessary: `/tmp` is a symlink to `/private/tmp`, and Kiro
 * often reports the resolved form. A pure string comparison would treat the two
 * as different directories.
 */
function samePath(a: string, b: string): boolean {
  const as = new Set(canonicalCandidates(a));
  for (const c of canonicalCandidates(b)) if (as.has(c)) return true;
  return false;
}

/**
 * Returns the prefix of `p` when `p` ends with `tail`, aligned on a path
 * separator. Returns undefined when it does not.
 */
function splitTail(p: string, tail: string): string | undefined {
  const normTail = tail.split(/[\\/]/).filter(Boolean).join(sep);
  if (!normTail) return undefined;
  const suffix = sep + normTail;
  if (!p.endsWith(suffix)) return undefined;
  return p.slice(0, p.length - suffix.length);
}

/**
 * Returns the path of `p` relative to `base` when `p` is genuinely inside
 * `base`, comparing through symlinks. Returns undefined otherwise.
 */
function relativeWithin(base: string, p: string): string | undefined {
  for (const b of canonicalCandidates(base)) {
    const prefix = b.endsWith(sep) ? b : b + sep;
    if (p.startsWith(prefix)) return p.slice(prefix.length);
  }
  return undefined;
}

/**
 * Normalises one path to an absolute path rooted at the session cwd.
 *
 * @param p       the path as Kiro reported it
 * @param ctx     session and process working directories
 * @param relHint a relative path recovered from `rawInput`, when available
 */
export function normalizePath(
  p: string | undefined,
  ctx: PathContext,
  relHint?: string | undefined,
): string | undefined {
  if (!p) return p;

  // Case 1: relative. Unambiguous — resolve against the session cwd.
  if (!isAbsolute(p)) return resolve(ctx.sessionCwd, p);

  // Case 2: absolute, and Kiro's rawInput gives us the relative tail, so we can
  // re-root authoritatively. This is the wrong-base-directory defect: Kiro
  // reports processCwd + tail while writing sessionCwd + tail.
  if (relHint) {
    const prefix = splitTail(p, relHint);
    if (prefix !== undefined && samePath(prefix, ctx.kiroProcessCwd)) {
      return resolve(ctx.sessionCwd, relHint);
    }
  }

  // Case 2b: absolute and genuinely inside the session directory, but spelled
  // differently — on macOS Kiro often reports the symlink-resolved form
  // (`/private/tmp/...` for a session cwd of `/tmp/...`). Re-spell it using the
  // cwd Zed supplied, because Zed associates a file with a project by path and
  // would not match the resolved spelling.
  const within = relativeWithin(ctx.sessionCwd, p);
  if (within !== undefined) return resolve(ctx.sessionCwd, within);

  // Case 3: absolute and outside the session. Leave alone — Kiro may
  // legitimately reference such a file, and guessing would be worse.
  return p;
}

/** True when `child` is inside `parent`, or equal to it. */
export function isWithin(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Returns a copy of a `tool_call` / `tool_call_update` payload with all paths
 * normalised. Unknown fields pass through untouched so future Kiro additions
 * survive the trip.
 */
export function normalizeToolCallPaths<T extends Record<string, unknown>>(
  toolCall: T,
  ctx: PathContext,
): T {
  const relHint = relativeHintFromRawInput(toolCall.rawInput);
  const out: Record<string, unknown> = { ...toolCall };
  let changed = false;

  // locations[].path — the ACP absolute-path violation.
  if (Array.isArray(toolCall.locations)) {
    let locChanged = false;
    const fixed = toolCall.locations.map((loc) => {
      if (!loc || typeof loc !== "object") return loc;
      const l = loc as Record<string, unknown>;
      if (typeof l.path !== "string") return loc;
      const next = normalizePath(l.path, ctx, relHint);
      if (next === l.path) return loc;
      locChanged = true;
      return { ...l, path: next };
    });
    if (locChanged) {
      out.locations = fixed;
      changed = true;
    }
  }

  // content[].diff.path — the wrong-base-directory defect.
  if (Array.isArray(toolCall.content)) {
    let contentChanged = false;
    const fixed = toolCall.content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as Record<string, unknown>;
      if (b.type !== "diff" || typeof b.path !== "string") return block;
      const next = normalizePath(b.path, ctx, relHint);
      if (next === b.path) return block;
      contentChanged = true;
      return { ...b, path: next };
    });
    if (contentChanged) {
      out.content = fixed;
      changed = true;
    }
  }

  return changed ? (out as T) : toolCall;
}
