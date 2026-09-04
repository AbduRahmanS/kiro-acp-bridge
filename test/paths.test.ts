import { describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import {
  normalizePath,
  normalizeToolCallPaths,
  relativeHintFromRawInput,
  isWithin,
} from "../src/bridge/paths.js";

/**
 * The fixture below is the tool_call Kiro actually emitted during probing, with
 * the two defects intact:
 *   - locations[0].path is relative
 *   - content[0].path is rooted in the Kiro process cwd, not the session cwd
 */
const KIRO_PROCESS_CWD = "/Users/dev/Codes/kiro-zed-acp";
const SESSION_CWD = "/tmp/kiro-probe/ws";

const CAPTURED_TOOL_CALL = {
  sessionUpdate: "tool_call",
  toolCallId: "call_c4af65ce-203a-4132-aef2-a5dd32653257",
  title: "Creating probe_out.txt",
  kind: "edit",
  content: [
    {
      type: "diff",
      path: `${KIRO_PROCESS_CWD}/probe_out.txt`,
      oldText: null,
      newText: "HELLO",
    },
  ],
  locations: [{ path: "probe_out.txt", line: 1 }],
  rawInput: {
    command: "create",
    path: "probe_out.txt",
    content: "HELLO",
  },
} as const;

const ctx = { sessionCwd: SESSION_CWD, kiroProcessCwd: KIRO_PROCESS_CWD };

describe("relativeHintFromRawInput", () => {
  it("recovers a relative path from rawInput.path", () => {
    expect(relativeHintFromRawInput({ path: "probe_out.txt" })).toBe("probe_out.txt");
  });

  it("accepts the snake_case and camelCase spellings", () => {
    expect(relativeHintFromRawInput({ file_path: "a/b.ts" })).toBe("a/b.ts");
    expect(relativeHintFromRawInput({ filePath: "a/b.ts" })).toBe("a/b.ts");
  });

  it("ignores absolute paths, which need no hint", () => {
    expect(relativeHintFromRawInput({ path: "/abs/x.txt" })).toBeUndefined();
  });

  it("tolerates junk", () => {
    expect(relativeHintFromRawInput(undefined)).toBeUndefined();
    expect(relativeHintFromRawInput("nope")).toBeUndefined();
    expect(relativeHintFromRawInput({ path: 42 })).toBeUndefined();
  });
});

describe("normalizePath", () => {
  it("resolves a relative path against the session cwd", () => {
    expect(normalizePath("probe_out.txt", ctx)).toBe(`${SESSION_CWD}/probe_out.txt`);
  });

  it("rebases an absolute path wrongly rooted in the Kiro process cwd", () => {
    expect(normalizePath(`${KIRO_PROCESS_CWD}/probe_out.txt`, ctx, "probe_out.txt")).toBe(
      `${SESSION_CWD}/probe_out.txt`,
    );
  });

  it("leaves unrelated absolute paths untouched", () => {
    expect(normalizePath("/etc/hosts", ctx, "probe_out.txt")).toBe("/etc/hosts");
  });

  it("does not rebase without a rawInput hint, to avoid guessing", () => {
    const p = `${KIRO_PROCESS_CWD}/probe_out.txt`;
    expect(normalizePath(p, ctx)).toBe(p);
  });

  it("canonicalises a session-cwd path to the spelling Zed supplied", () => {
    // Kiro sometimes reports a symlink-resolved path. Zed associates files with
    // a project by path, so we re-spell it using the cwd Zed gave us.
    const symlinked = { sessionCwd: "/tmp/ws", kiroProcessCwd: KIRO_PROCESS_CWD };
    expect(normalizePath("/tmp/ws/a.txt", symlinked, "a.txt")).toBe("/tmp/ws/a.txt");
  });

  it("does not rebase a path under an unrelated directory", () => {
    const p = "/somewhere/else/probe_out.txt";
    expect(normalizePath(p, ctx, "probe_out.txt")).toBe(p);
  });

  it("handles nested relative hints", () => {
    expect(normalizePath(`${KIRO_PROCESS_CWD}/src/a/b.ts`, ctx, "src/a/b.ts")).toBe(
      `${SESSION_CWD}/src/a/b.ts`,
    );
  });

  it("does not rebase when process cwd and session cwd agree", () => {
    const same = { sessionCwd: KIRO_PROCESS_CWD, kiroProcessCwd: KIRO_PROCESS_CWD };
    const p = `${KIRO_PROCESS_CWD}/probe_out.txt`;
    expect(normalizePath(p, same, "probe_out.txt")).toBe(p);
  });

  it("passes through empty input", () => {
    expect(normalizePath(undefined, ctx)).toBeUndefined();
  });
});

describe("normalizeToolCallPaths — captured Kiro payload", () => {
  const fixed = normalizeToolCallPaths({ ...CAPTURED_TOOL_CALL } as Record<string, unknown>, ctx);

  it("makes locations[].path absolute, satisfying ACP", () => {
    const locations = fixed.locations as Array<{ path: string; line: number }>;
    expect(locations[0]!.path).toBe(`${SESSION_CWD}/probe_out.txt`);
    // line must survive untouched
    expect(locations[0]!.line).toBe(1);
  });

  it("rebases the diff path onto the session cwd", () => {
    const content = fixed.content as Array<{ type: string; path: string; newText: string }>;
    expect(content[0]!.path).toBe(`${SESSION_CWD}/probe_out.txt`);
    expect(content[0]!.newText).toBe("HELLO");
  });

  it("preserves every unrelated field", () => {
    expect(fixed.toolCallId).toBe(CAPTURED_TOOL_CALL.toolCallId);
    expect(fixed.title).toBe(CAPTURED_TOOL_CALL.title);
    expect(fixed.kind).toBe("edit");
    expect(fixed.sessionUpdate).toBe("tool_call");
    expect(fixed.rawInput).toEqual(CAPTURED_TOOL_CALL.rawInput);
  });

  it("does not mutate the input object", () => {
    const original = JSON.parse(JSON.stringify(CAPTURED_TOOL_CALL));
    normalizeToolCallPaths({ ...CAPTURED_TOOL_CALL } as Record<string, unknown>, ctx);
    expect(JSON.parse(JSON.stringify(CAPTURED_TOOL_CALL))).toEqual(original);
  });

  it("returns the identical object when nothing needs fixing", () => {
    const clean = {
      toolCallId: "x",
      locations: [{ path: "/abs/ok.txt" }],
      content: [{ type: "diff", path: "/abs/ok.txt" }],
    };
    expect(normalizeToolCallPaths(clean, ctx)).toBe(clean);
  });

  it("ignores non-diff content blocks", () => {
    const tc = {
      content: [
        { type: "content", content: { type: "text", text: "hi" } },
        { type: "terminal", terminalId: "t1" },
      ],
    };
    expect(normalizeToolCallPaths(tc, ctx)).toBe(tc);
  });

  it("survives malformed locations and content entries", () => {
    const tc = {
      locations: [null, "junk", { line: 3 }],
      content: [null, 7],
      rawInput: { path: "x.txt" },
    };
    expect(() => normalizeToolCallPaths(tc as Record<string, unknown>, ctx)).not.toThrow();
  });
});

describe("isWithin", () => {
  it("accepts a nested path", () => {
    expect(isWithin("/a/b", "/a/b/c/d.txt")).toBe(true);
  });
  it("accepts an equal path", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
  });
  it("rejects a sibling with a shared prefix", () => {
    expect(isWithin("/a/b", "/a/bc")).toBe(false);
  });
  it("rejects an outside path", () => {
    expect(isWithin("/a/b", "/etc/passwd")).toBe(false);
  });
});


describe("normalizePath — symlinked session cwd", () => {
  /**
   * Kiro emits two different shapes depending on whether the client implements
   * `fs/write_text_file`:
   *   - client stubs it out  -> diff path uses the Kiro PROCESS cwd (defect 2)
   *   - client performs it   -> diff path is correct but symlink-resolved
   * Both must land on the cwd spelling Zed supplied.
   */
  const realTmp = realpathSync("/tmp");
  const ctxTmp = {
    sessionCwd: "/tmp/kiro-paths-test/ws",
    kiroProcessCwd: "/Users/dev/Codes/kiro-zed-acp",
  };

  it("re-spells a symlink-resolved path using Zed's cwd spelling", () => {
    const resolvedForm = `${realTmp}/kiro-paths-test/ws/out.txt`;
    expect(normalizePath(resolvedForm, ctxTmp, "out.txt")).toBe("/tmp/kiro-paths-test/ws/out.txt");
  });

  it("re-spells even without a rawInput hint", () => {
    const resolvedForm = `${realTmp}/kiro-paths-test/ws/nested/out.txt`;
    expect(normalizePath(resolvedForm, ctxTmp)).toBe("/tmp/kiro-paths-test/ws/nested/out.txt");
  });

  it("still leaves genuinely outside paths alone", () => {
    expect(normalizePath("/etc/hosts", ctxTmp, "out.txt")).toBe("/etc/hosts");
  });
});
