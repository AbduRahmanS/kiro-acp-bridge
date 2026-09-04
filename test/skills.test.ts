import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSkills,
  isValidSkillName,
  parseSkillFrontmatter,
  skillDirectories,
} from "../src/bridge/skills.js";

let root: string;
let workspace: string;
let home: string;

function writeSkill(base: string, dirName: string, frontmatter: string, body = "# Body\n") {
  const dir = join(base, ".kiro", "skills", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `${frontmatter}\n${body}`);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kiro-skills-"));
  workspace = join(root, "workspace");
  home = join(root, "home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });

  writeSkill(
    home,
    "web-perf",
    ["---", "name: web-perf", "description: Analyses web performance using Chrome DevTools.", "---"].join("\n"),
  );
  writeSkill(
    home,
    "wrangler",
    ["---", 'name: "wrangler"', "description: 'Cloudflare Workers CLI helper'", "---"].join("\n"),
  );
  // Workspace skill that shadows a global one of the same name.
  writeSkill(
    workspace,
    "web-perf",
    ["---", "name: web-perf", "description: WORKSPACE OVERRIDE", "---"].join("\n"),
  );
  // Block-scalar description, which real skills do use.
  writeSkill(
    workspace,
    "pr-review",
    ["---", "name: pr-review", "description: >-", "  Reviews a pull request", "  across many files.", "---"].join("\n"),
  );
  // No frontmatter at all — directory name must still be used.
  writeSkill(workspace, "bare-skill", "# Just a heading");
  // A directory with no SKILL.md must be ignored silently.
  mkdirSync(join(workspace, ".kiro", "skills", "not-a-skill"), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("skillDirectories", () => {
  it("puts the workspace first so it wins collisions", () => {
    const dirs = skillDirectories("/w", "/h");
    expect(dirs[0]).toEqual({ dir: "/w/.kiro/skills", scope: "workspace" });
    expect(dirs[1]).toEqual({ dir: "/h/.kiro/skills", scope: "global" });
  });
});

describe("parseSkillFrontmatter", () => {
  it("reads plain scalars", () => {
    const r = parseSkillFrontmatter("---\nname: a\ndescription: b\n---\nbody");
    expect(r).toEqual({ name: "a", description: "b" });
  });

  it("strips double and single quotes", () => {
    const r = parseSkillFrontmatter(`---\nname: "a"\ndescription: 'b'\n---\n`);
    expect(r).toEqual({ name: "a", description: "b" });
  });

  it("folds block scalars into one line", () => {
    const r = parseSkillFrontmatter("---\nname: a\ndescription: >-\n  one\n  two\n---\n");
    expect(r.description).toBe("one two");
  });

  it("handles a literal block scalar", () => {
    const r = parseSkillFrontmatter("---\nname: a\ndescription: |\n  one\n  two\n---\n");
    expect(r.description).toBe("one two");
  });

  it("ignores keys other than name and description", () => {
    const r = parseSkillFrontmatter("---\nname: a\nlicense: MIT\nversion: 2\n---\n");
    expect(r).toEqual({ name: "a" });
  });

  it("returns nothing when there is no frontmatter", () => {
    expect(parseSkillFrontmatter("# heading\ntext")).toEqual({});
  });

  it("requires the frontmatter to be first", () => {
    expect(parseSkillFrontmatter("text\n---\nname: a\n---\n")).toEqual({});
  });

  it("tolerates a BOM", () => {
    expect(parseSkillFrontmatter("\uFEFF---\nname: a\n---\n").name).toBe("a");
  });

  it("tolerates CRLF line endings", () => {
    expect(parseSkillFrontmatter("---\r\nname: a\r\ndescription: b\r\n---\r\n")).toEqual({
      name: "a",
      description: "b",
    });
  });
});

describe("isValidSkillName", () => {
  it("accepts ordinary skill names", () => {
    for (const n of ["pr-review", "web_perf", "a", "web.perf", "skill2"]) {
      expect(isValidSkillName(n)).toBe(true);
    }
  });

  it("rejects names that would break command parsing or impersonate paths", () => {
    for (const n of ["/evil", "two words", "../escape", "-leading", "", "a/b"]) {
      expect(isValidSkillName(n)).toBe(false);
    }
  });
});

describe("discoverSkills", () => {
  it("finds skills in both scopes", () => {
    const names = discoverSkills(workspace, { home }).map((s) => s.name);
    expect(names).toContain("web-perf");
    expect(names).toContain("wrangler");
    expect(names).toContain("pr-review");
  });

  it("lets a workspace skill shadow a global one of the same name", () => {
    const skills = discoverSkills(workspace, { home });
    const webPerf = skills.filter((s) => s.name === "web-perf");
    expect(webPerf).toHaveLength(1);
    expect(webPerf[0]!.scope).toBe("workspace");
    expect(webPerf[0]!.description).toBe("WORKSPACE OVERRIDE");
  });

  it("falls back to the directory name when frontmatter is absent", () => {
    const bare = discoverSkills(workspace, { home }).find((s) => s.name === "bare-skill");
    expect(bare).toBeDefined();
    expect(bare!.description).toContain("bare-skill");
  });

  it("ignores directories without a SKILL.md", () => {
    expect(discoverSkills(workspace, { home }).map((s) => s.name)).not.toContain("not-a-skill");
  });

  it("records the manifest path for diagnostics", () => {
    const s = discoverSkills(workspace, { home }).find((x) => x.name === "pr-review")!;
    expect(s.source).toContain("pr-review/SKILL.md");
  });

  it("returns a stable alphabetical order", () => {
    const names = discoverSkills(workspace, { home }).map((s) => s.name);
    expect(names).toEqual([...names].sort());
  });

  it("returns empty and does not throw when nothing exists", () => {
    expect(
      discoverSkills(join(root, "nowhere"), { home: join(root, "nohome") }),
    ).toEqual([]);
  });

  it("does not warn merely because a directory is missing", () => {
    const warnings: string[] = [];
    discoverSkills(join(root, "nowhere"), {
      home: join(root, "nohome"),
      onWarning: (m) => warnings.push(m),
    });
    expect(warnings).toEqual([]);
  });

  it("skips a skill whose declared name is unusable, with a warning", () => {
    const badWs = join(root, "badws");
    mkdirSync(badWs, { recursive: true });
    writeSkill(badWs, "bad", ["---", "name: has spaces", "description: nope", "---"].join("\n"));
    const warnings: string[] = [];
    const skills = discoverSkills(badWs, { home: join(root, "nohome"), onWarning: (m) => warnings.push(m) });
    expect(skills).toEqual([]);
    expect(warnings.join(" ")).toContain("unusable name");
  });
});
