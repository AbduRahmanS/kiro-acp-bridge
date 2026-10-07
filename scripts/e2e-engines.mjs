#!/usr/bin/env node
/**
 * Live smoke test of both engines against the REAL kiro-cli, through the built
 * bridge exactly as Zed runs it.
 *
 * Roster-agnostic: the model list is server-side and changes (observed 6 -> 21
 * -> 3 models within one afternoon), so nothing here names a model.
 *
 * Cost: two one-word prompts per engine on `auto` (well under 1 credit total).
 *
 * Isolation: Kiro runs under the sandbox HOME, and the script FAILS if anything
 * mentioning the sandbox appears in the real ~/.kiro.
 *
 *   npm run build && node scripts/e2e-engines.mjs [v2|v3 ...]
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ZedSim, pidAlive } from "./lib/zed-sim.mjs";
import { SANDBOX_ROOT, sandboxEnv } from "./lib/sandbox.mjs";

const engines = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["v2", "v3"];
const WS = join(SANDBOX_ROOT, "ws-engines");
rmSync(WS, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const opt = (opts, id) => (opts ?? []).find((o) => o.id === id);
const values = (o) => (o?.options ?? []).flatMap((x) => (x.options ? x.options.map((y) => y.value) : [x.value]));

/**
 * Files created under the real ~/.kiro during the run that mention the sandbox.
 *
 * Only *new* files count: a pre-existing transcript (for example of an agent
 * session that launched this script) can mention the sandbox path legitimately,
 * and other live Kiro sessions may create files that do not mention it.
 */
function leaks() {
  return listKiroFiles().filter((p) => {
    if (preexisting.has(p)) return false;
    try {
      return statSync(p).size < 5_000_000 && readFileSync(p, "utf8").includes(SANDBOX_ROOT);
    } catch {
      return false;
    }
  });
}

const startedAt = Date.now();
const preexisting = new Set(listKiroFiles());

/** Every file path under the real ~/.kiro. */
function listKiroFiles() {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e);
      try {
        if (statSync(p).isDirectory()) walk(p);
        else out.push(p);
      } catch {
        /* vanished */
      }
    }
  };
  walk(join(homedir(), ".kiro"));
  return out;
}

for (const engine of engines) {
  console.log(`\n================ ${engine} ================`);
  const zed = new ZedSim({
    cwd: WS,
    permissionPolicy: "reject",
    env: { ...sandboxEnv(), KIRO_BRIDGE_AGENT_ENGINE: engine, KIRO_BRIDGE_LOG_LEVEL: "warn" },
  }).start();

  const init = await zed.initialize();
  const title = init.result?.agentInfo?.title ?? "";
  check("initialize succeeded", !!init.result, JSON.stringify(init.error));
  check(`dialect is ${engine}`, engine === "v3" ? title.includes("CLI V3") : !title.includes("V3"), title);
  check("no vendor _meta reaches Zed", !JSON.stringify(init.result ?? {}).includes("_meta"));

  const sn = await zed.newSession(WS);
  const sid = sn.result?.sessionId;
  const opts = sn.result?.configOptions ?? [];
  check("session created", typeof sid === "string", JSON.stringify(sn.error));
  check("stable ids agent + model present", !!opt(opts, "agent") && !!opt(opts, "model"),
    JSON.stringify(opts.map((o) => o.id)));
  check("no native V3 ids leak (mode / effortLevel)", !opt(opts, "mode") && !opt(opts, "effortLevel"));
  if (engine === "v3") {
    check("V3 session starts supervised (autopilot off)", opt(opts, "autopilot")?.currentValue === "off",
      opt(opts, "autopilot")?.currentValue);
  }
  const models = values(opt(opts, "model"));
  console.log(`  models: ${models.join(", ")}`);

  // Find two models with an effort axis, discovered rather than named.
  const withEffort = [];
  for (const m of models) {
    const r = await zed.setConfigOption(sid, "model", m);
    if (opt(r.result?.configOptions, "effort")) withEffort.push(m);
  }
  console.log(`  models with effort: ${withEffort.join(", ") || "(none)"}`);
  if (withEffort.length >= 1) {
    await zed.setConfigOption(sid, "model", withEffort[0]);
    const levels = values(opt((await zed.setConfigOption(sid, "effort", "low")).result?.configOptions, "effort"));
    check("effort can be set", levels.includes("low"), JSON.stringify(levels));
    if (withEffort.length >= 2) {
      const sw = await zed.setConfigOption(sid, "model", withEffort[1]);
      check("explicit effort survives a model switch", opt(sw.result?.configOptions, "effort")?.currentValue === "low",
        opt(sw.result?.configOptions, "effort")?.currentValue);
    }
  }

  const bad = await zed.setConfigOption(sid, "model", "no-such-model-xyz");
  check("unknown model rejected with -32602", bad.error?.code === -32602, JSON.stringify(bad.error?.code));
  const badEffort = await zed.setConfigOption(sid, "effort", "ludicrous");
  check("unknown effort rejected", !!badEffort.error, JSON.stringify(badEffort.error?.code));

  if (models.includes("auto")) await zed.setConfigOption(sid, "model", "auto");

  await new Promise((r) => setTimeout(r, 2500));
  const cmds = zed.updatesOfKind("available_commands_update").at(-1)?.update?.availableCommands ?? [];
  const names = cmds.map((c) => c.name);
  check("/restart-kiro advertised", names.includes("restart-kiro"), names.slice(0, 12).join(","));

  zed.clearUpdates();
  const p1 = await zed.prompt(sid, "Reply with the single word: PONG");
  check("prompt round-trips", p1.result?.stopReason === "end_turn" && /pong/i.test(zed.text()),
    JSON.stringify(zed.text().slice(0, 60)));

  if (engine === "v3") {
    zed.clearUpdates();
    await zed.prompt(sid, "/model");
    check("/model lists models without reaching the LLM", zed.text().includes("**Models**"), zed.text().slice(0, 80));
    zed.clearUpdates();
    await zed.prompt(sid, "/usage");
    check("/usage reports credits", /credits/i.test(zed.text()), zed.text().slice(0, 120));
    const list = await zed.request("session/list", { cwd: WS });
    check("session/list includes the session", (list.result?.sessions ?? []).some((s) => s.sessionId === sid));
  }

  zed.clearUpdates();
  const restart = await zed.prompt(sid, "/restart-kiro");
  check("/restart-kiro completes", restart.result?.stopReason === "end_turn", JSON.stringify(restart.error));
  check("restart reported with the model roster", /Kiro restarted[\s\S]*Models available: \S/.test(zed.text()),
    zed.text().slice(0, 160));
  check("restart did not replay the transcript into the thread", !/PONG/.test(zed.text()));

  zed.clearUpdates();
  const p2 = await zed.prompt(sid, "Reply with the single word: AGAIN");
  check("thread keeps working after restart", p2.result?.stopReason === "end_turn" && /again/i.test(zed.text()),
    `${JSON.stringify(p2.result ?? p2.error)} text=${JSON.stringify(zed.text().slice(0, 60))} kinds=${JSON.stringify(zed.variantCounts())}`);

  if (engine === "v3") {
    const del = await zed.request("session/delete", { sessionId: sid });
    check("session/delete forwarded", !del.error, JSON.stringify(del.error));
  }

  let kiroPids = [];
  try {
    kiroPids = execSync(`pgrep -P ${zed.pid}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
  } catch {
    /* none */
  }
  await zed.stop();
  await new Promise((r) => setTimeout(r, 1500));
  check("bridge exited", !pidAlive(zed.pid));
  for (const pid of kiroPids) check(`kiro child ${pid} reaped`, !pidAlive(pid));
  check("stdout carried only JSON-RPC", !zed.stdoutGarbage, JSON.stringify(zed.stdoutGarbage?.slice(0, 2)));
}

const leaked = leaks();
check("nothing written to the real ~/.kiro", leaked.length === 0, leaked.join(", "));

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
