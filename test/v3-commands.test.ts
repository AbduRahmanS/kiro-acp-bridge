import { describe, expect, it } from "vitest";
import { parseSlashCommand, RESTART_COMMAND } from "../src/bridge/commands.js";
import {
  buildV3AvailableCommands,
  formatV3Context,
  formatV3Mcp,
  formatValueList,
  planV3Command,
} from "../src/bridge/v3-commands.js";
import { v3Options, V3_EXTENSION_METHODS, V3_KIRO_COMMANDS } from "./fixtures/v3.js";

const ctx = { native: v3Options({ model: "claude-opus-5.5" }), extensionMethods: V3_EXTENSION_METHODS };
const plan = (text: string, c = ctx) => planV3Command(parseSlashCommand(text)!, c);

describe("buildV3AvailableCommands", () => {
  const built = buildV3AvailableCommands(ctx, V3_KIRO_COMMANDS as never);
  const names = built.map((c) => c.name);

  it("offers routes for the commands V3 removed", () => {
    for (const n of ["model", "agent", "effort", "plan", "context", "compact", "usage", "mcp", "help"]) {
      expect(names).toContain(n);
    }
  });

  it("puts /restart-kiro first", () => {
    expect(names[0]).toBe(RESTART_COMMAND);
  });

  it("keeps Kiro's steering and subagent commands", () => {
    expect(names).toContain("bug-fix");
    expect(names).toContain("context-gatherer");
  });

  it("drops a Kiro command whose name the bridge intercepts", () => {
    expect(names.filter((n) => n === "context")).toHaveLength(1);
    expect(built.find((c) => c.name === "context")?.description).not.toBe("Kiro's own context command");
  });

  it("strips vendor _meta", () => {
    expect(JSON.stringify(built)).not.toContain("_meta");
  });

  it("only advertises what has a route", () => {
    const bare = buildV3AvailableCommands({ native: v3Options({ model: "auto" }), extensionMethods: [] }, []);
    const n = bare.map((c) => c.name);
    expect(n).not.toContain("effort"); // auto has no effort axis
    expect(n).not.toContain("context"); // not advertised
    expect(n).not.toContain("compact");
  });
});

describe("planV3Command", () => {
  it("lists when a value-taking command has no argument", () => {
    expect(plan("/model")).toEqual({ kind: "list", role: "model" });
  });
  it("sets with an argument", () => {
    expect(plan("/effort max")).toEqual({ kind: "set", role: "effort", input: "max" });
  });
  it("carries trailing /plan text as a prompt", () => {
    expect(plan("/plan design the cache")).toEqual({ kind: "plan", prompt: "design the cache" });
  });
  it("forwards Kiro's own commands to Kiro", () => {
    expect(plan("/bug-fix the login form")).toEqual({ kind: "forward" });
  });
  it("forwards a command whose route is unavailable rather than faking it", () => {
    expect(plan("/context", { native: ctx.native, extensionMethods: [] })).toEqual({ kind: "forward" });
  });
});

describe("renderers", () => {
  it("marks the current value in lists", () => {
    const text = formatValueList(v3Options({ model: "claude-opus-5.5" }), "model");
    expect(text).toContain("`claude-opus-5.5` — Claude Opus 5.5 **(current)**");
  });

  it("renders /context from percentages, never from V3's stale token counts", () => {
    const text = formatV3Context(
      {
        entries: [],
        breakdown: {
          tools: { tokens: 4928, percent: 0.5 },
          yourPrompts: { tokens: 0, percent: 1.7 },
          memory: { tokens: 0, percent: 0 },
        },
      },
      2.35,
    );
    expect(text).toContain("2.4% of the context window used");
    expect(text).toContain("Your prompts: 1.7%");
    expect(text).not.toContain("4928");
    expect(text).not.toContain("Memory");
  });

  it("renders MCP status, distinguishing auth from other failures", () => {
    const text = formatV3Mcp([
      { name: "github", status: "connected" },
      { name: "linear", status: "failed", failedAuthorization: true },
      { name: "broken", status: "failed", errorMessage: "spawn ENOENT" },
    ]);
    expect(text).toContain("**github**: connected");
    expect(text).toContain("**linear**: needs authorisation");
    expect(text).toContain("failed (spawn ENOENT)");
  });
});
