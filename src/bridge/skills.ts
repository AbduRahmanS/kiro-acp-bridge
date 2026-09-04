/**
 * Kiro skill discovery.
 *
 * Kiro does **not** advertise skills over ACP. Probing confirmed this: with 13
 * global skills installed and one workspace skill added, the
 * `_kiro.dev/commands/available` notification still listed only the 25 built-in
 * TUI commands. Skills are absent from the ACP surface entirely.
 *
 * However, Kiro's *prompt* path does expand them. Sending the literal text
 * `/probe-test-skill say the phrase` through `session/prompt` activated the skill
 * and returned its sentinel response. So the runtime supports skills; only
 * discovery is missing.
 *
 * The bridge therefore performs discovery itself — reading the same directories
 * Kiro reads — and advertises the results as ACP commands, forwarding invocation
 * as ordinary prompt text. Kiro remains the execution authority; we only supply
 * the catalogue it declines to publish.
 *
 * This is the one place the bridge parses Kiro configuration from disk. It is
 * justified because there is no API to prefer: the alternative is that skills are
 * simply unreachable from Zed.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DiscoveredSkill {
  /** Skill name, which is also its slash-command name without the slash. */
  name: string;
  description: string;
  /** Absolute path to the SKILL.md that defined it. */
  source: string;
  /** Workspace skills shadow global ones of the same name, as in Kiro. */
  scope: "workspace" | "global";
}

/** Directories Kiro reads skills from, workspace first (it wins collisions). */
export function skillDirectories(cwd: string, home = homedir()): Array<{ dir: string; scope: "workspace" | "global" }> {
  return [
    { dir: join(cwd, ".kiro", "skills"), scope: "workspace" },
    { dir: join(home, ".kiro", "skills"), scope: "global" },
  ];
}

/**
 * Extracts `name` and `description` from a SKILL.md YAML frontmatter block.
 *
 * Deliberately a minimal parser rather than a YAML dependency: the Agent Skills
 * spec requires only these two scalar keys, and a full YAML parser would be a
 * new supply-chain dependency for no benefit. Handles plain, single-quoted and
 * double-quoted scalars, plus YAML block scalars (`>-`, `|`) for descriptions,
 * which real skills do use.
 */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  // Frontmatter must be the first thing in the file.
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return {};
  const body = match[1] ?? "";
  const lines = body.split(/\r?\n/);

  const out: { name?: string; description?: string } = {};
  let activeKey: "name" | "description" | undefined;
  let blockIndent = 0;
  const blockLines: string[] = [];

  const flushBlock = () => {
    if (activeKey && blockLines.length > 0) {
      out[activeKey] = blockLines.join(" ").replace(/\s+/g, " ").trim();
    }
    activeKey = undefined;
    blockLines.length = 0;
  };

  for (const line of lines) {
    if (activeKey) {
      const indent = line.length - line.trimStart().length;
      if (line.trim() === "") continue;
      if (indent > blockIndent) {
        blockLines.push(line.trim());
        continue;
      }
      flushBlock();
    }

    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = (kv[1] ?? "").toLowerCase();
    const rawValue = (kv[2] ?? "").trim();
    if (key !== "name" && key !== "description") continue;

    // Block scalar: value continues on subsequent, more-indented lines.
    if (rawValue === ">" || rawValue === ">-" || rawValue === "|" || rawValue === "|-") {
      activeKey = key;
      blockIndent = line.length - line.trimStart().length;
      continue;
    }
    out[key] = unquote(rawValue);
  }
  flushBlock();
  return out;
}

function unquote(v: string): string {
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

/** True when a name is safe to expose as a slash command. */
export function isValidSkillName(name: string): boolean {
  // Conservative: a leading slash, whitespace or path separator would either
  // break command parsing or let a skill name masquerade as something else.
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/**
 * Discovers all skills visible to a session.
 *
 * Never throws: a malformed or unreadable skill must not prevent a session from
 * starting. Failures are reported through `onWarning` for diagnostics.
 */
export function discoverSkills(
  cwd: string,
  options: { home?: string; onWarning?: (message: string, detail?: unknown) => void } = {},
): DiscoveredSkill[] {
  const home = options.home ?? homedir();
  const warn = options.onWarning ?? (() => {});
  const found = new Map<string, DiscoveredSkill>();

  for (const { dir, scope } of skillDirectories(cwd, home)) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // directory absent is entirely normal
    }

    for (const entry of entries) {
      const skillDir = join(dir, entry);
      const manifest = join(skillDir, "SKILL.md");
      try {
        if (!statSync(skillDir).isDirectory()) continue;
        const content = readFileSync(manifest, "utf8");
        const { name, description } = parseSkillFrontmatter(content);
        // The directory name is the fallback identity, matching Kiro's behaviour.
        const skillName = name ?? entry;
        if (!isValidSkillName(skillName)) {
          warn("skipping skill with unusable name", { manifest, skillName });
          continue;
        }
        // Workspace scope is visited first and must win.
        if (found.has(skillName)) continue;
        found.set(skillName, {
          name: skillName,
          description: description ?? `Kiro skill '${skillName}'`,
          source: manifest,
          scope,
        });
      } catch (err) {
        // A directory without SKILL.md is not a skill; only log real surprises.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          warn("failed to read skill", { manifest, code });
        }
      }
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
