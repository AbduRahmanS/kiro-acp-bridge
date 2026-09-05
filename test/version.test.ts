import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BRIDGE_VERSION } from "../src/bridge/bridge.js";

/**
 * Regression guard for a real defect: BRIDGE_VERSION was a hardcoded constant
 * whose comment claimed the release process kept it in sync with package.json.
 * No such step existed, so 0.1.1 shipped reporting itself as 0.1.0.
 *
 * That value is sent to the client as `agentInfo.version` and appears in ACP
 * logs, so a stale number silently misdirects bug reports — the kind of fault
 * that survives indefinitely because nothing breaks.
 */
describe("BRIDGE_VERSION", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };

  it("matches package.json exactly", () => {
    expect(BRIDGE_VERSION).toBe(pkg.version);
  });

  it("resolved a real version rather than falling back", () => {
    // The fallback means package.json could not be located, which would ship a
    // meaningless version to every client.
    expect(BRIDGE_VERSION).not.toBe("0.0.0-unknown");
  });

  it("is a plausible semver", () => {
    expect(BRIDGE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
