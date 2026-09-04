import { describe, expect, it } from "vitest";
import { diagnosticsFromEnv, sanitize } from "../src/diagnostics/logging.js";

describe("sanitize", () => {
  it("redacts secret-bearing keys regardless of case", () => {
    const out = sanitize({
      accessToken: "abc123",
      Authorization: "Bearer xyz",
      client_secret: "shh",
      nested: { refreshToken: "r1" },
    }) as Record<string, unknown>;
    expect(out.accessToken).toBe("[redacted]");
    expect(out.Authorization).toBe("[redacted]");
    expect(out.client_secret).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).refreshToken).toBe("[redacted]");
  });

  it("never leaks a secret value anywhere in the serialised output", () => {
    const serialised = JSON.stringify(
      sanitize({ token: "SUPERSECRET", inner: [{ apiKey: "SUPERSECRET" }] }),
    );
    expect(serialised).not.toContain("SUPERSECRET");
  });

  it("omits free-text content by default but keeps its length", () => {
    const out = sanitize({ text: "hello world" }) as Record<string, unknown>;
    expect(out.text).toBe("[content 11 chars]");
  });

  it("includes content when explicitly opted in", () => {
    const out = sanitize({ text: "hello world" }, true) as Record<string, unknown>;
    expect(out.text).toBe("hello world");
  });

  it("summarises large base64 blobs instead of echoing them", () => {
    const out = sanitize({ data: "A".repeat(5000) }, true) as Record<string, unknown>;
    expect(out.data).toBe("[binary 5000 chars]");
  });

  it("truncates long strings", () => {
    const out = sanitize({ description: "x".repeat(900) }) as Record<string, unknown>;
    expect(String(out.description)).toContain("[+500 chars]");
  });

  it("caps long arrays", () => {
    const out = sanitize(Array.from({ length: 100 }, (_, i) => i)) as unknown[];
    expect(out.length).toBe(41);
    expect(out[40]).toBe("[+60 more]");
  });

  it("terminates on deeply nested structures", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(() => JSON.stringify(sanitize(deep))).not.toThrow();
  });
});

describe("diagnosticsFromEnv", () => {
  it("defaults to tracing disabled", () => {
    const o = diagnosticsFromEnv({} as NodeJS.ProcessEnv);
    expect(o.trace).toBe(false);
    expect(o.tracePromptContent).toBe(false);
  });

  it("enables tracing and raises the level so traces are not filtered", () => {
    const o = diagnosticsFromEnv({ KIRO_BRIDGE_TRACE: "1" } as NodeJS.ProcessEnv);
    expect(o.trace).toBe(true);
    expect(o.level).toBe("debug");
  });

  it("keeps prompt content opt-in separately from tracing", () => {
    const o = diagnosticsFromEnv({ KIRO_BRIDGE_TRACE: "1" } as NodeJS.ProcessEnv);
    expect(o.tracePromptContent).toBe(false);
  });

  it("respects an explicit level", () => {
    const o = diagnosticsFromEnv({ KIRO_BRIDGE_LOG_LEVEL: "trace" } as NodeJS.ProcessEnv);
    expect(o.level).toBe("trace");
  });

  it("ignores an invalid level", () => {
    const o = diagnosticsFromEnv({ KIRO_BRIDGE_LOG_LEVEL: "bogus" } as NodeJS.ProcessEnv);
    expect(o.level).toBeUndefined();
  });
});
