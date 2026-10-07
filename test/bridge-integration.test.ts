import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InProcessZed, optionOf, valuesOf } from "./helpers/in-process-zed.js";

let zed: InProcessZed | undefined;
afterEach(async () => {
  await zed?.close();
  zed = undefined;
});

const start = (opts: ConstructorParameters<typeof InProcessZed>[0]) => {
  zed = new InProcessZed(opts);
  return zed;
};

describe("engine selection", () => {
  it("defaults to v2", async () => {
    const z = start({ env: { FAKE_KIRO_ENGINES: "v2,v3" } });
    const init = await z.initialize();
    expect(init.result.agentInfo.title).not.toContain("V3");
    const sn = await z.newSession();
    expect(sn.result.sessionId).toBe("fake-session-0001");
  });

  it("auto prefers V3 when the installation has it", async () => {
    const z = start({ engine: "auto", env: { FAKE_KIRO_ENGINES: "v2,v3" } });
    const init = await z.initialize();
    expect(init.result.agentInfo.title).toContain("CLI V3");
    expect(init.result.agentCapabilities.sessionCapabilities).toEqual({ list: {}, close: {}, delete: {} });
    expect(JSON.stringify(init.result)).not.toContain("_meta");
  });

  it("auto falls back to v2 when V3 cannot start", async () => {
    const z = start({ engine: "auto", env: { FAKE_KIRO_ENGINES: "v2" } });
    const init = await z.initialize();
    expect(init.result.agentInfo.title).not.toContain("V3");
    expect((await z.newSession()).result.sessionId).toBe("fake-session-0001");
  });

  it("does not fall back when V3 says the user is signed out — it asks them to sign in", async () => {
    const z = start({ engine: "auto", env: { FAKE_KIRO_ENGINES: "v2,v3", FAKE_KIRO_MODE: "v3-signed-out" } });
    const init = await z.initialize();
    expect(init.result.authMethods.map((m: { id: string }) => m.id)).toContain("kiro-cli-login");
    const sn = await z.newSession();
    expect(sn.error?.code).toBe(-32000);
  });

  it("never forwards V3's agent auth methods, which cannot work with CLI-owned auth", async () => {
    const z = start({ engine: "v3", env: { FAKE_KIRO_ENGINES: "v3" } });
    const init = await z.initialize();
    expect(init.result.authMethods.map((m: { id: string }) => m.id)).toEqual(["kiro-cli-login"]);
  });
});

describe("V3 adapter, end to end", () => {
  const v3 = () => start({ engine: "v3", env: { FAKE_KIRO_ENGINES: "v3" } });

  it("exposes the bridge's stable option ids and starts supervised", async () => {
    const z = v3();
    await z.initialize();
    const sn = await z.newSession();
    const opts = sn.result.configOptions;
    expect(opts.map((o: { id: string }) => o.id)).toEqual(["agent", "model", "autopilot"]);
    // Kiro's own default is `on`; the bridge's safety policy turned it off.
    expect(optionOf(opts, "autopilot").currentValue).toBe("off");
    expect(optionOf(opts, "agent").currentValue).toBe("vibe");
  });

  it("translates Kiro's own config_option_update instead of leaking native ids", async () => {
    const z = v3();
    await z.initialize();
    const sid = (await z.newSession()).result.sessionId;
    await z.settle();
    z.clear();
    await z.request("session/set_mode", { sessionId: sid, modeId: "plan" });
    await z.settle();
    const pushed = z.ofKind("config_option_update");
    expect(pushed.length).toBeGreaterThan(0);
    for (const p of pushed) {
      const ids = p.update.configOptions.map((o: { id: string }) => o.id);
      expect(ids).not.toContain("mode");
      expect(ids).toContain("agent");
    }
  });

  it("refuses an unknown model rather than letting V3 break the session", async () => {
    const z = v3();
    await z.initialize();
    const sid = (await z.newSession()).result.sessionId;
    const bad = await z.setConfig(sid, "model", "claude-opus-5");
    expect(bad.error?.code).toBe(-32602);
    const after = await z.setConfig(sid, "model", "claude-opus-5.5");
    expect(optionOf(after.result.configOptions, "model").currentValue).toBe("claude-opus-5.5");
  });

  it("keeps an explicitly chosen effort across a model switch", async () => {
    const z = v3();
    await z.initialize();
    const sid = (await z.newSession()).result.sessionId;
    await z.setConfig(sid, "model", "claude-opus-5.5");
    await z.setConfig(sid, "effort", "max");
    const switched = await z.setConfig(sid, "model", "claude-sonnet-5.5");
    // The fake, like V3, resets effort to the model default (high) on a switch.
    expect(optionOf(switched.result.configOptions, "effort").currentValue).toBe("max");
  });

  it("accepts v2 agent ids from existing Zed settings", async () => {
    const z = v3();
    await z.initialize();
    const sid = (await z.newSession()).result.sessionId;
    const r = await z.setConfig(sid, "agent", "kiro_planner");
    expect(optionOf(r.result.configOptions, "agent").currentValue).toBe("plan");
  });

  it("routes slash commands V3 removed, and never sends them to the model", async () => {
    const z = v3();
    await z.initialize();
    const sid = (await z.newSession()).result.sessionId;
    await z.settle();

    const names = z.ofKind("available_commands_update").at(-1)?.update.availableCommands.map((c: { name: string }) => c.name);
    expect(names).toEqual(expect.arrayContaining(["restart-kiro", "model", "context", "usage", "bug-fix"]));

    z.clear();
    await z.prompt(sid, "/model claude sonnet 5.5");
    expect(z.text()).toContain("Model changed to **Claude Sonnet 5.5**");
    expect(z.text()).not.toContain("FAKE_V3_OK");
    expect(optionOf(z.ofKind("config_option_update").at(-1)?.update.configOptions, "model").currentValue).toBe(
      "claude-sonnet-5.5",
    );

    z.clear();
    await z.prompt(sid, "/context");
    expect(z.text()).toContain("Your prompts: 1.7%");

    z.clear();
    await z.prompt(sid, "hello");
    await z.prompt(sid, "/usage");
    expect(z.text()).toContain("FAKE V3 PLAN");
    expect(z.text()).toContain("This thread:** 0.07 credits");
    expect(z.text()).toContain("2.4% of the context window used");

    z.clear();
    await z.prompt(sid, "/bug-fix the login form");
    expect(z.text()).toContain("FAKE_V3_OK:/bug-fix the login form");
  });

  it("switches to Plan and sends the trailing text as the prompt", async () => {
    const z = v3();
    await z.initialize();
    const sid = (await z.newSession()).result.sessionId;
    z.clear();
    await z.prompt(sid, "/plan design a cache");
    expect(z.text()).toContain("FAKE_V3_OK:design a cache");
  });

  it("does not turn a V3 network error into an 'authentication required' prompt", async () => {
    const z = start({ engine: "v3", env: { FAKE_KIRO_ENGINES: "v3", FAKE_KIRO_MODE: "v3-service-error" } });
    await z.initialize();
    const sid = (await z.newSession()).result.sessionId;
    const p = await z.prompt(sid, "hello");
    expect(p.error?.code).toBe(-32603);
    expect(p.error?.message).toContain("network error");
  });

  it("forwards session/list natively without vendor _meta", async () => {
    const z = v3();
    await z.initialize();
    await z.newSession();
    const list = await z.request("session/list", {});
    expect(list.result.sessions.length).toBe(1);
    expect(JSON.stringify(list.result)).not.toContain("_meta");
  });

  it("hands Kiro's openExternalUrl to Zed as a URL elicitation", async () => {
    const z = v3();
    await z.initialize();
    const sid = (await z.newSession()).result.sessionId;
    z.clear();
    await z.prompt(sid, "trigger-open-url");
    expect(z.elicitations.at(-1)).toMatchObject({ mode: "url", url: "https://example.invalid/consent" });
    expect(z.text()).toContain("URL_OPENED");
  });

  it("reports MCP failures once and offers OAuth links through Zed", async () => {
    const z = start({ engine: "v3", env: { FAKE_KIRO_ENGINES: "v3", FAKE_KIRO_MODE: "v3-mcp-fail" } });
    await z.initialize();
    await z.newSession();
    await z.settle(300);
    expect(z.text()).toContain("**broken**: spawn ENOENT");
    expect(z.elicitations.some((e) => e.url === "https://example.invalid/oauth")).toBe(true);
  });
});

describe("/restart-kiro and recovery", () => {
  for (const engine of ["v2", "v3"]) {
    it(`[${engine}] notices a newly released model by itself and loads it for the next new thread`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "kiro-bridge-auto-"));
      const file = join(dir, "models.json");
      writeFileSync(file, "[]");
      try {
        const z = start({
          engine,
          // ~6 ms between checks, so the test does not wait for minutes.
          env: { FAKE_KIRO_ENGINES: engine, FAKE_KIRO_MODELS_FILE: file, KIRO_BRIDGE_MODEL_CHECK_MINUTES: "0.0001" },
        });
        await z.initialize();
        const first = (await z.newSession()).result.sessionId;

        writeFileSync(file, JSON.stringify(["brand-new-model"]));
        await z.settle(50);
        await z.prompt(first, "hello"); // a turn ends -> background check
        await z.settle(500);

        // The existing thread is told once, at the start of its next turn.
        z.clear();
        await z.prompt(first, "again");
        expect(z.text()).toContain("New model available:** Brand New Model");
        expect(z.text()).toContain("/restart-kiro");
        z.clear();
        await z.prompt(first, "once more");
        expect(z.text()).not.toContain("New model available");

        // A new thread gets the new model without anyone typing a command.
        z.clear();
        const second = await z.newSession();
        expect(valuesOf(optionOf(second.result.configOptions, "model"))).toContain("brand-new-model");
        await z.settle();
        expect(z.text()).toContain("now in the model picker");

        // The first thread survived the reload.
        const p = await z.prompt(first, "still here");
        expect(p.result?.stopReason).toBe("end_turn");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  for (const engine of ["v2", "v3"]) {
    it(`[${engine}] loads newly released models without restarting Zed, and does not duplicate the transcript`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "kiro-bridge-models-"));
      const file = join(dir, "models.json");
      writeFileSync(file, "[]");
      try {
        const z = start({ engine, env: { FAKE_KIRO_ENGINES: engine, FAKE_KIRO_MODELS_FILE: file } });
        await z.initialize();
        const sn = await z.newSession();
        const sid = sn.result.sessionId;
        expect(valuesOf(optionOf(sn.result.configOptions, "model"))).not.toContain("brand-new-model");

        writeFileSync(file, JSON.stringify(["brand-new-model"]));
        await z.settle();
        z.clear();
        await z.prompt(sid, "/restart-kiro");
        await z.settle();

        expect(z.text()).toContain("Kiro restarted");
        expect(z.text()).toContain("New model available:** Brand New Model — now in the model picker");
        // The fake replays "REPLAYED" on load; Zed already has the transcript.
        expect(z.text()).not.toContain("REPLAYED");
        const pushed = z.ofKind("config_option_update").at(-1)?.update.configOptions;
        expect(valuesOf(optionOf(pushed, "model"))).toContain("brand-new-model");

        // The thread keeps working on the new process.
        z.clear();
        const p = await z.prompt(sid, "still here");
        expect(p.result?.stopReason).toBe("end_turn");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`[${engine}] recovers after Kiro crashes instead of staying dead`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "kiro-bridge-crash-"));
      const z = start({
        engine,
        env: { FAKE_KIRO_ENGINES: engine, FAKE_KIRO_MODE: "crash-on-prompt", FAKE_KIRO_CRASH_MARKER: join(dir, "m") },
      });
      try {
        await z.initialize();
        const sid = (await z.newSession()).result.sessionId;
        const crashed = await z.prompt(sid, "first");
        expect(crashed.error).toBeDefined();
        await z.settle(300);
        expect(z.text()).toContain("starts Kiro again on your next message");

        z.clear();
        const again = await z.prompt(sid, "second");
        expect(again.result?.stopReason).toBe("end_turn");
        expect(z.text()).not.toContain("REPLAYED");
        // A brand-new thread works too (the old bug: the dead process was cached forever).
        expect((await z.newSession()).result?.sessionId).toBeDefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("Zed-initiated session/load still receives the replayed transcript", async () => {
    const z = start({ engine: "v3", env: { FAKE_KIRO_ENGINES: "v3" } });
    await z.initialize();
    z.clear();
    const load = await z.request("session/load", { sessionId: "sess_existing", cwd: process.cwd(), mcpServers: [] });
    expect(load.result.configOptions.map((o: { id: string }) => o.id)).toContain("agent");
    expect(z.text()).toContain("REPLAYED");
    // 2.28 omits the model from the load response and sends it just after.
    await z.settle(300);
    const pushed = z.ofKind("config_option_update").at(-1)?.update.configOptions;
    expect(optionOf(pushed, "model")).toBeDefined();
  });
});
