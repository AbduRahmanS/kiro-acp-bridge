import { describe, expect, it } from "vitest";
import {
  authRequiredMessage,
  buildAuthMethods,
  isAuthError,
  KIRO_LOGIN_METHOD_ID,
  LOGIN_FLAG,
} from "../src/bridge/auth.js";
import type * as schema from "@agentclientprotocol/sdk";

const zedLikeCaps = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  auth: { terminal: true },
} as unknown as schema.ClientCapabilities;

const noTerminalAuth = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
} as unknown as schema.ClientCapabilities;

describe("buildAuthMethods", () => {
  it("adds a terminal method when Kiro reports none and the client can run one", () => {
    // Kiro returns authMethods: [] — this is what makes the bridge's addition
    // necessary, both for signed-out users and for ACP Registry listing.
    const methods = buildAuthMethods([], zedLikeCaps);
    expect(methods).toHaveLength(1);
    const m = methods[0] as unknown as Record<string, unknown>;
    expect(m.id).toBe(KIRO_LOGIN_METHOD_ID);
    expect(m.type).toBe("terminal");
    expect(m.args).toEqual([LOGIN_FLAG]);
    expect(String(m.name)).toMatch(/sign in/i);
  });

  it("treats an undefined list the same as an empty one", () => {
    expect(buildAuthMethods(undefined, zedLikeCaps)).toHaveLength(1);
  });

  it("does NOT advertise terminal auth to a client that cannot run it", () => {
    // Advertising a flow the client cannot execute would be a dead end in the UI.
    expect(buildAuthMethods([], noTerminalAuth)).toEqual([]);
    expect(buildAuthMethods([], undefined)).toEqual([]);
  });

  it("preserves any methods Kiro does report", () => {
    const kiroMethod = {
      id: "kiro-oauth",
      name: "Kiro OAuth",
      type: "agent",
    } as unknown as schema.AuthMethod;
    const methods = buildAuthMethods([kiroMethod], zedLikeCaps);
    expect(methods).toHaveLength(2);
    expect((methods[0] as unknown as Record<string, unknown>).id).toBe("kiro-oauth");
  });

  it("does not duplicate when Kiro already offers a terminal method", () => {
    // Forward-looking: if Kiro adopts terminal auth, we must not add a second.
    const existing = {
      id: "kiro-terminal",
      name: "Kiro terminal",
      type: "terminal",
      args: ["login"],
    } as unknown as schema.AuthMethod;
    const methods = buildAuthMethods([existing], zedLikeCaps);
    expect(methods).toHaveLength(1);
    expect((methods[0] as unknown as Record<string, unknown>).id).toBe("kiro-terminal");
  });

  it("satisfies the ACP Registry rule: at least one agent or terminal method", () => {
    const methods = buildAuthMethods([], zedLikeCaps);
    const types = methods.map((m) => (m as unknown as { type?: string }).type);
    expect(types.some((t) => t === "agent" || t === "terminal")).toBe(true);
  });
});

describe("isAuthError", () => {
  it("recognises Kiro's expired and invalid credential errors", () => {
    for (const text of [
      "ExpiredTokenException",
      "TokenExpiredError",
      "InvalidGrantException",
      "AccessDeniedError",
      "Unauthorized",
      "Please log in to continue",
      "no valid credentials found",
      "Authentication required",
      "You must re-authenticate",
    ]) {
      expect(isAuthError(new Error(text)), text).toBe(true);
    }
  });

  it("matches case-insensitively", () => {
    expect(isAuthError(new Error("expiredtokenexception"))).toBe(true);
    expect(isAuthError(new Error("EXPIREDTOKEN"))).toBe(true);
  });

  it("inspects nested JSON-RPC error data, where Kiro puts detail", () => {
    expect(isAuthError({ message: "Internal error", data: { details: "ExpiredTokenException" } })).toBe(true);
    expect(isAuthError({ code: -32603, data: "TokenExpiredError" })).toBe(true);
  });

  it("accepts a bare string", () => {
    expect(isAuthError("InvalidGrantException")).toBe(true);
  });

  it("does not misclassify ordinary failures", () => {
    for (const text of [
      "Method not found",
      "Mode 'plan' not found",
      "Improperly formed request",
      "connection reset",
      "rate limit exceeded",
      "context window exceeded",
    ]) {
      expect(isAuthError(new Error(text)), text).toBe(false);
    }
  });

  it("tolerates junk without throwing", () => {
    expect(isAuthError(undefined)).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(42)).toBe(false);
    expect(isAuthError({})).toBe(false);
    // Circular data must not crash the check.
    const circular: Record<string, unknown> = { message: "x" };
    circular.data = circular;
    expect(() => isAuthError(circular)).not.toThrow();
  });
});

describe("authRequiredMessage", () => {
  it("tells the user the exact command to run", () => {
    const m = authRequiredMessage();
    expect(m).toContain("kiro-cli login");
    expect(m).toMatch(/not authenticated/i);
  });
});
