import { describe, expect, it } from "vitest";
import {
  buildAvailableCommands,
  buildCommandInput,
  commandFromPrompt,
  EXCLUDED_COMMANDS,
  parseSlashCommand,
  planCommand,
  STATE_CHANGING_COMMANDS,
} from "../src/bridge/commands.js";
import type { KiroCommand } from "../src/kiro/protocol.js";

/** The real catalogue Kiro sent, abbreviated but structurally faithful. */
const KIRO_COMMANDS: KiroCommand[] = [
  {
    name: "/agent",
    description: "Select or list available agents",
    meta: {
      optionsMethod: "_kiro.dev/commands/agent/options",
      inputType: "selection",
      hint: "",
      subcommands: ["create", "edit", "swap"],
      subcommandHints: { create: "<name>", edit: "[name]", swap: "<name>" },
      subcommandDescriptions: { create: "Create a new agent" },
    },
  },
  {
    name: "/chat",
    description: "Load a previous session or start a new one",
    meta: { inputType: "selection", local: true, hint: "save <path>, load <path>, new [prompt]" },
  },
  { name: "/clear", description: "Clear conversation history" },
  {
    name: "/context",
    description: "Show context files and usage",
    meta: { inputType: "panel", subcommands: ["show", "add", "remove", "clear"] },
  },
  {
    name: "/effort",
    description: "Set reasoning effort",
    meta: { inputType: "selection", subcommands: ["set-current-as-default"] },
  },
  {
    name: "/model",
    description: "Select a model",
    meta: { optionsMethod: "_kiro.dev/commands/model/options", inputType: "selection" },
  },
  { name: "/paste", description: "Paste clipboard image" },
  { name: "/plan", description: "Switch to Plan agent" },
  { name: "/quit", description: "Exit session", meta: { local: true } },
  { name: "/usage", description: "Billing and credits", meta: { inputType: "panel" } },
  { name: "/voice", description: "Voice input", meta: { subcommands: ["start", "stop"] } },
];

describe("parseSlashCommand", () => {
  it("parses a bare command", () => {
    expect(parseSlashCommand("/context")).toEqual({
      name: "context",
      args: "",
      raw: "/context",
    });
  });

  it("parses a command with arguments", () => {
    const p = parseSlashCommand("/model gpt-5.6-sol");
    expect(p?.name).toBe("model");
    expect(p?.args).toBe("gpt-5.6-sol");
  });

  it("lower-cases the command name but preserves argument case", () => {
    const p = parseSlashCommand("/MODEL Claude-Opus-5");
    expect(p?.name).toBe("model");
    expect(p?.args).toBe("Claude-Opus-5");
  });

  it("tolerates leading whitespace", () => {
    expect(parseSlashCommand("  /usage")?.name).toBe("usage");
  });

  it("preserves the raw text for verbatim forwarding", () => {
    expect(parseSlashCommand("/context verbose")?.raw).toBe("/context verbose");
  });

  it("ignores a slash that is not at the start", () => {
    expect(parseSlashCommand("please run /context")).toBeUndefined();
  });

  it("does not treat an absolute path as a command", () => {
    // `/usr/local/bin` must not parse as the command `usr`: a path separator is
    // not a valid command-name character, so the whole thing is ordinary text.
    expect(parseSlashCommand("/usr/local/bin matters")).toBeUndefined();
  });

  it("returns undefined for a bare slash", () => {
    expect(parseSlashCommand("/")).toBeUndefined();
  });

  it("returns undefined for ordinary text", () => {
    expect(parseSlashCommand("explain this code")).toBeUndefined();
  });

  it("accepts skill-style names with hyphens and dots", () => {
    expect(parseSlashCommand("/pr-review go")?.name).toBe("pr-review");
    expect(parseSlashCommand("/web.perf")?.name).toBe("web.perf");
  });
});

describe("commandFromPrompt", () => {
  it("detects a command in a single text block", () => {
    expect(commandFromPrompt([{ type: "text", text: "/usage" }])?.name).toBe("usage");
  });

  it("ignores a prompt that leads with an image", () => {
    expect(
      commandFromPrompt([
        { type: "image", mimeType: "image/png", data: "x" },
        { type: "text", text: "/usage" },
      ]),
    ).toBeUndefined();
  });

  it("ignores a command that carries attachments, so they are never dropped", () => {
    expect(
      commandFromPrompt([
        { type: "text", text: "/context" },
        { type: "image", mimeType: "image/png", data: "x" },
      ]),
    ).toBeUndefined();
  });

  it("returns undefined for an empty prompt", () => {
    expect(commandFromPrompt([])).toBeUndefined();
  });
});

describe("buildAvailableCommands", () => {
  const built = buildAvailableCommands(KIRO_COMMANDS);
  const names = built.map((c) => c.name);

  it("strips the leading slash, as ACP expects", () => {
    expect(names).toContain("context");
    expect(names.every((n) => !n.startsWith("/"))).toBe(true);
  });

  it("keeps Kiro's functional commands", () => {
    for (const expected of ["agent", "context", "effort", "model", "plan", "usage"]) {
      expect(names).toContain(expected);
    }
  });

  it("drops terminal-only commands Zed already does better", () => {
    for (const excluded of ["quit", "paste", "voice", "clear"]) {
      expect(names).not.toContain(excluded);
    }
  });

  it("carries descriptions through", () => {
    expect(built.find((c) => c.name === "usage")?.description).toBe("Billing and credits");
  });

  it("synthesises an input hint from subcommands", () => {
    const agent = built.find((c) => c.name === "agent");
    expect(agent?.input).toBeDefined();
    expect((agent?.input as { hint: string }).hint).toContain("create <name>");
  });

  it("omits input for commands that take no argument", () => {
    expect(built.find((c) => c.name === "plan")?.input).toBeUndefined();
  });

  it("de-duplicates repeated command names", () => {
    const dup = buildAvailableCommands([...KIRO_COMMANDS, ...KIRO_COMMANDS]);
    expect(new Set(dup.map((c) => c.name)).size).toBe(dup.length);
  });

  it("tolerates an empty catalogue", () => {
    expect(buildAvailableCommands([])).toEqual([]);
  });
});

describe("buildAvailableCommands — skills", () => {
  const skills = [
    {
      name: "pr-review",
      description: "Review a pull request",
      source: "/w/.kiro/skills/pr-review/SKILL.md",
      scope: "workspace" as const,
    },
    {
      name: "web-perf",
      description: "Analyse web performance",
      source: "/h/.kiro/skills/web-perf/SKILL.md",
      scope: "global" as const,
    },
  ];

  it("advertises skills alongside Kiro commands", () => {
    const names = buildAvailableCommands(KIRO_COMMANDS, skills).map((c) => c.name);
    expect(names).toContain("pr-review");
    expect(names).toContain("web-perf");
  });

  it("labels skills so users can tell them from built-ins", () => {
    const built = buildAvailableCommands(KIRO_COMMANDS, skills);
    expect(built.find((c) => c.name === "pr-review")?.description).toContain("(Kiro skill)");
  });

  it("never lets a skill shadow a Kiro built-in", () => {
    const shadowing = [
      { name: "model", description: "evil", source: "/x/SKILL.md", scope: "workspace" as const },
    ];
    const built = buildAvailableCommands(KIRO_COMMANDS, shadowing);
    expect(built.filter((c) => c.name === "model")).toHaveLength(1);
    expect(built.find((c) => c.name === "model")?.description).toBe("Select a model");
  });

  it("gives skills an input hint so arguments are expected", () => {
    const built = buildAvailableCommands([], skills);
    expect((built[0]?.input as { hint: string }).hint).toContain("context");
  });
});

describe("planCommand", () => {
  it("intercepts /model with an argument", () => {
    const plan = planCommand({ name: "model", args: "gpt-5.6-sol", raw: "/model gpt-5.6-sol" });
    expect(plan).toEqual({
      kind: "intercept",
      variant: "model",
      args: { modelName: "gpt-5.6-sol" },
      command: "model",
    });
  });

  it("intercepts /effort with a level", () => {
    const plan = planCommand({ name: "effort", args: "max", raw: "/effort max" });
    expect(plan).toEqual({
      kind: "intercept",
      variant: "effort",
      args: { level: "max" },
      command: "effort",
    });
  });

  it("intercepts /plan, which takes no argument", () => {
    const plan = planCommand({ name: "plan", args: "", raw: "/plan" });
    expect(plan).toEqual({ kind: "intercept", variant: "plan", args: {}, command: "plan" });
  });

  it("forwards a value-taking command with no value, so Kiro can list options", () => {
    expect(planCommand({ name: "model", args: "", raw: "/model" })).toEqual({ kind: "forward" });
  });

  it("forwards informational commands, which Kiro's prompt path handles", () => {
    for (const name of ["context", "usage", "tools", "mcp", "hooks", "rewind"]) {
      expect(planCommand({ name, args: "", raw: `/${name}` })).toEqual({ kind: "forward" });
    }
  });

  it("forwards unknown commands, so new Kiro releases work unchanged", () => {
    expect(planCommand({ name: "brand-new-thing", args: "x", raw: "/brand-new-thing x" })).toEqual({
      kind: "forward",
    });
  });

  it("forwards skills", () => {
    expect(planCommand({ name: "pr-review", args: "", raw: "/pr-review" })).toEqual({
      kind: "forward",
    });
  });
});

describe("command tables", () => {
  it("intercepts exactly the state-changing commands", () => {
    expect(Object.keys(STATE_CHANGING_COMMANDS).sort()).toEqual([
      "agent",
      "effort",
      "guide",
      "model",
      "plan",
    ]);
  });

  it("never excludes a command it also intercepts", () => {
    for (const name of Object.keys(STATE_CHANGING_COMMANDS)) {
      expect(EXCLUDED_COMMANDS.has(name)).toBe(false);
    }
  });
});

describe("buildCommandInput", () => {
  it("returns undefined when there is no metadata", () => {
    expect(buildCommandInput({ name: "/x" })).toBeUndefined();
  });

  it("uses a plain hint when present", () => {
    const input = buildCommandInput({ name: "/x", meta: { hint: "a hint" } });
    expect((input as { hint: string }).hint).toContain("a hint");
  });

  it("falls back to a generic placeholder for selection inputs", () => {
    const input = buildCommandInput({ name: "/x", meta: { inputType: "selection" } });
    expect((input as { hint: string }).hint).toBe("value");
  });

  it("returns undefined for a panel command with no argument", () => {
    expect(buildCommandInput({ name: "/x", meta: { inputType: "panel" } })).toBeUndefined();
  });
});
