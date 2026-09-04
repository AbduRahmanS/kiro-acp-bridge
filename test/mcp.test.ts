import { describe, expect, it } from "vitest";
import {
  buildOauthElicitation,
  deduplicateMcpServers,
  formatMcpStatus,
  kiroManagedServerNames,
  mcpServerName,
} from "../src/bridge/mcp.js";

const stdio = (name: string) => ({ name, command: "/bin/true", args: [], env: [] }) as never;
const http = (name: string) => ({ type: "http" as const, name, url: "https://x", headers: [] }) as never;

describe("mcpServerName", () => {
  it("reads the name from any transport variant", () => {
    expect(mcpServerName(stdio("a"))).toBe("a");
    expect(mcpServerName(http("b"))).toBe("b");
  });
  it("returns undefined when absent", () => {
    expect(mcpServerName({} as never)).toBeUndefined();
  });
});

describe("deduplicateMcpServers", () => {
  it("forwards everything when Kiro manages nothing", () => {
    const { forward, skipped } = deduplicateMcpServers([stdio("a"), stdio("b")], []);
    expect(forward).toHaveLength(2);
    expect(skipped).toEqual([]);
  });

  it("drops servers Kiro already manages, to avoid double-starting", () => {
    const { forward, skipped } = deduplicateMcpServers([stdio("github"), stdio("other")], ["github"]);
    expect(forward.map(mcpServerName)).toEqual(["other"]);
    expect(skipped).toEqual(["github"]);
  });

  it("matches names case-insensitively and ignoring surrounding whitespace", () => {
    const { forward, skipped } = deduplicateMcpServers([stdio("GitHub")], [" github "]);
    expect(forward).toHaveLength(0);
    expect(skipped).toEqual(["GitHub"]);
  });

  it("collapses duplicates within the client's own list", () => {
    const { forward, skipped } = deduplicateMcpServers([stdio("a"), stdio("a")], []);
    expect(forward).toHaveLength(1);
    expect(skipped).toEqual(["a"]);
  });

  it("forwards unnamed servers rather than discarding them", () => {
    const { forward } = deduplicateMcpServers([{ command: "/bin/true" } as never], ["x"]);
    expect(forward).toHaveLength(1);
  });
});

describe("kiroManagedServerNames", () => {
  it("collects names from the startup status", () => {
    const names = kiroManagedServerNames({
      allStarted: false,
      failed: [{ name: "broken", reason: "timeout" }],
      pending: ["slow"],
    });
    expect(names).toContain("broken");
    expect(names).toContain("slow");
  });

  it("tolerates junk", () => {
    expect(kiroManagedServerNames(undefined)).toEqual([]);
    expect(kiroManagedServerNames("nope")).toEqual([]);
    expect(kiroManagedServerNames({ failed: "not-an-array" })).toEqual([]);
  });
});

describe("buildOauthElicitation", () => {
  it("builds a URL-mode elicitation, which is ACP's OAuth mechanism", () => {
    const e = buildOauthElicitation("s1", "GitHub", "https://example.com/auth?x=1", "1") as never as {
      mode: string;
      url: string;
      sessionId: string;
      elicitationId: string;
      message: string;
    };
    expect(e.mode).toBe("url");
    expect(e.url).toBe("https://example.com/auth?x=1");
    expect(e.sessionId).toBe("s1");
    expect(e.elicitationId).toContain("kiro-mcp-oauth-github");
    expect(e.message).toContain("GitHub");
  });

  it("refuses a non-https scheme, so no odd URL is handed to a browser", () => {
    expect(buildOauthElicitation("s1", "x", "file:///etc/passwd", "1")).toBeUndefined();
    expect(buildOauthElicitation("s1", "x", "javascript:alert(1)", "1")).toBeUndefined();
  });

  it("returns undefined without a URL, so no empty prompt is raised", () => {
    expect(buildOauthElicitation("s1", "x", undefined, "1")).toBeUndefined();
  });

  it("falls back to a generic label when the server is unnamed", () => {
    const e = buildOauthElicitation("s1", undefined, "https://x.test", "7") as never as {
      message: string;
      elicitationId: string;
    };
    expect(e.message).toContain("an MCP server");
    expect(e.elicitationId).toContain("7");
  });

  it("gives distinct ids for repeated prompts", () => {
    const a = buildOauthElicitation("s", "n", "https://x.test", "1") as never as { elicitationId: string };
    const b = buildOauthElicitation("s", "n", "https://x.test", "2") as never as { elicitationId: string };
    expect(a.elicitationId).not.toBe(b.elicitationId);
  });
});

describe("formatMcpStatus", () => {
  it("says nothing when all servers started", () => {
    expect(formatMcpStatus({ allStarted: true, failed: [], pending: [] })).toBeUndefined();
  });

  it("names failures and their reasons", () => {
    const t = formatMcpStatus({ failed: [{ name: "gh", reason: "timeout" }] })!;
    expect(t).toContain("gh (timeout)");
    expect(t).toContain("failed to start");
  });

  it("pluralises correctly", () => {
    expect(formatMcpStatus({ failed: ["a", "b"] })!).toContain("servers failed");
    expect(formatMcpStatus({ failed: ["a"] })!).toContain("server failed");
  });

  it("tolerates unrecognised failure entries", () => {
    expect(formatMcpStatus({ failed: [42 as never] })!).toContain("unknown");
  });
});
