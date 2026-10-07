#!/usr/bin/env node
/**
 * A fake `kiro-cli acp`, used as a fault-injection fixture.
 *
 * Some behaviour cannot be exercised against a real Kiro without damaging the
 * developer's environment — chiefly authentication failure, which would require
 * signing out of a working account. This stands in for Kiro and can be told to
 * fail in specific, realistic ways.
 *
 * It replies with Kiro's **actual** wire shapes and error strings, captured from
 * kiro-cli 2.21.0, so a test against it is meaningful rather than circular.
 *
 * Point the bridge at it with:
 *   KIRO_CLI_PATH=/abs/path/scripts/fake-kiro.mjs FAKE_KIRO_MODE=<mode>
 *
 * Modes:
 *   ok              behave like a healthy Kiro
 *   auth-expired    fail session/new with ExpiredTokenException
 *   auth-invalid    fail session/new with InvalidGrantException
 *   auth-on-prompt  succeed at session/new, fail session/prompt with TokenExpiredError
 *   no-models       omit the `models` block, as a future Kiro might
 *   crash-on-new    exit abruptly during session/new
 *   crash-on-prompt exit abruptly during the first session/prompt (v2 and V3)
 *   v3-signed-out   the V3 engine exits at startup with Kiro's "not logged in" text
 *   v3-mcp-fail     V3 reports a failed MCP server and one needing OAuth
 *
 * Engines. The fake reads `--agent-engine` from argv. `FAKE_KIRO_ENGINES` lists
 * what this "installation" supports (default `v2`), so a V3 launch on a v2-only
 * fake fails the way an old kiro-cli does and exercises the bridge's fallback.
 * V3 replies use the shapes captured from kiro-cli 2.28.0.
 *
 * `FAKE_KIRO_MODELS_FILE`, when set, is read at startup for a JSON array of extra
 * model ids. Rewriting it and restarting Kiro simulates a newly released model.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * `crash-on-prompt` crashes the first prompt only. With
 * `FAKE_KIRO_CRASH_MARKER` set, "first" means first across *processes*, so a
 * respawned Kiro behaves normally — the recovery scenario.
 */
function shouldCrashNow() {
  const marker = process.env.FAKE_KIRO_CRASH_MARKER;
  if (marker) {
    if (existsSync(marker)) return false;
    writeFileSync(marker, "crashed");
    return true;
  }
  return promptCount++ === 0;
}

const MODE = process.env.FAKE_KIRO_MODE ?? "ok";
const argv = process.argv.slice(2);

// `kiro-cli chat --list-models --format json`: the read-only listing the bridge
// polls to notice new models. Same shape as kiro-cli 2.28.
if (argv[0] === "chat" && argv.includes("--list-models")) {
  const engines = (process.env.FAKE_KIRO_ENGINES ?? "v2").split(",");
  const base = engines.includes("v3") && !engines.includes("v2")
    ? ["auto", "claude-opus-5.5", "claude-sonnet-5.5"]
    : ["auto", "claude-opus-5", "gpt-5.6-sol"];
  const ids = [...base, ...extraModelIds()];
  process.stdout.write(JSON.stringify({ models: ids.map((id) => ({ model_name: id, model_id: id, rate_multiplier: 1.0 })), default_model: "auto" }));
  process.exit(0);
}
const ENGINE = argv[argv.indexOf("--agent-engine") + 1] ?? "v2";
const SUPPORTED = (process.env.FAKE_KIRO_ENGINES ?? "v2").split(",").map((s) => s.trim());

if (!SUPPORTED.includes(ENGINE)) {
  process.stderr.write(`error: invalid value '${ENGINE}' for '--agent-engine <ENGINE>'\n`);
  process.exit(2);
}
if (ENGINE === "v3" && MODE === "v3-signed-out") {
  process.stderr.write("error: \nYou are not logged in, please log in with kiro-cli login\n");
  process.exit(1);
}

function extraModelIds() {
  const file = process.env.FAKE_KIRO_MODELS_FILE;
  if (!file) return [];
  try {
    const ids = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(ids) ? ids.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const MODELS = [
  { modelId: "auto", name: "auto", description: "Models chosen by task" },
  { modelId: "claude-opus-5", name: "claude-opus-5", description: "Claude Opus 5 model with 1M context window" },
  { modelId: "gpt-5.6-sol", name: "gpt-5.6-sol", description: "Experimental preview of OpenAI GPT 5.6 Sol" },
  ...extraModelIds().map((id) => ({ modelId: id, name: id, description: `${id} model` })),
];
const AGENTS = [
  { id: "kiro_default", name: "kiro_default", description: "The default agent for Kiro CLI" },
  { id: "kiro_planner", name: "kiro_planner", description: "Specialized planning agent" },
];
const EFFORTS = { "claude-opus-5": ["low", "medium", "high", "xhigh", "max"], "gpt-5.6-sol": ["none", "low", "medium", "high", "xhigh", "max"], auto: [] };
for (const id of extraModelIds()) EFFORTS[id] = ["low", "medium", "high"];

let currentModel = "claude-opus-5";
let currentAgent = "kiro_default";
let promptCount = 0;

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
/** Kiro surfaces auth problems as generic internal errors with detail in `data`. */
const authFail = (id, detail) =>
  send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error", data: { details: detail } } });
const notFound = (id, method) =>
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found", data: method } });

/** Agent-to-client requests the fake has sent, awaiting the client's answer. */
const outgoing = new Map();
let outgoingId = 0;
function requestClient(method, params) {
  const id = `fake-${++outgoingId}`;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => outgoing.set(id, resolve));
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === undefined && msg.id !== undefined && outgoing.has(msg.id)) {
      outgoing.get(msg.id)(msg);
      outgoing.delete(msg.id);
      continue;
    }
    if (ENGINE === "v3") void handleV3(msg);
    else handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification; nothing to answer

  switch (method) {
    case "initialize":
      // Exactly what kiro-cli 2.21.0 returns when ALREADY AUTHENTICATED. Kiro does
      // advertise kiro-login when auth IS required; [] means "nothing needed now".
      return ok(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: false },
          mcpCapabilities: { http: true, sse: false },
          sessionCapabilities: {},
          auth: {},
        },
        authMethods: [],
        agentInfo: { name: "Kiro CLI Agent", title: "Kiro CLI Agent", version: "2.21.0-fake" },
      });

    case "session/new": {
      if (MODE === "auth-expired") return authFail(id, "ExpiredTokenException: The security token included in the request is expired");
      if (MODE === "auth-invalid") return authFail(id, "InvalidGrantException: refresh token is invalid");
      if (MODE === "crash-on-new") process.exit(3);
      const res = { sessionId: "fake-session-0001", modes: { currentModeId: currentAgent, availableModes: AGENTS } };
      if (MODE !== "no-models") res.models = { currentModelId: currentModel, availableModels: MODELS };
      ok(id, res);
      // Kiro pushes its command catalogue shortly after the response.
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "_kiro.dev/commands/available",
          params: {
            sessionId: "fake-session-0001",
            commands: [
              { name: "/model", description: "Select a model", meta: { inputType: "selection" } },
              { name: "/effort", description: "Set reasoning effort", meta: { inputType: "selection" } },
              { name: "/context", description: "Show context files and usage", meta: { inputType: "panel" } },
            ],
          },
        });
      }, 10);
      return;
    }

    case "session/prompt":
      if (MODE === "auth-on-prompt") return authFail(id, "TokenExpiredError: token has expired and must be refreshed");
      if (MODE === "crash-on-prompt" && shouldCrashNow()) process.exit(3);
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FAKE_OK" } } },
      });
      return ok(id, { stopReason: "end_turn" });

    case "session/set_model":
      currentModel = params.modelId;
      return ok(id, {});

    case "session/load": {
      // Real v2 replays the transcript before answering; "REPLAYED" marks it.
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier question" } } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED" } } } });
      return ok(id, { modes: { currentModeId: currentAgent, availableModes: AGENTS }, models: { currentModelId: currentModel, availableModels: MODELS } });
    }

    case "session/set_mode":
      if (!AGENTS.some((a) => a.id === params.modeId)) {
        return send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error", data: `Mode '${params.modeId}' not found` } });
      }
      currentAgent = params.modeId;
      return ok(id, {});

    case "_kiro.dev/commands/options": {
      const c = params.command;
      if (c === "model")
        return ok(id, {
          options: MODELS.map((m) => ({
            value: m.modelId,
            label: m.modelId,
            description: m.modelId === currentModel ? `${m.description} [active]` : m.description,
            group: "1.00x credits",
            // kiro-cli 2.28: per-model effort axis inline; models without one omit it.
            ...((EFFORTS[m.modelId] ?? []).length > 0
              ? { reasoning: { thinking: "alwaysOn", effortLevels: EFFORTS[m.modelId] } }
              : {}),
          })),
          hasMore: false,
        });
      if (c === "agent")
        return ok(id, {
          options: AGENTS.map((a) => ({ value: a.id, label: a.id, description: a.id === currentAgent ? `${a.description} [active]` : a.description, group: "Built-in" })),
          hasMore: false,
        });
      if (c === "effort")
        return ok(id, { options: (EFFORTS[currentModel] ?? []).map((v) => ({ value: v, label: v })), hasMore: false });
      return ok(id, { options: [], hasMore: false });
    }

    case "_kiro.dev/commands/execute": {
      const cmd = params.command?.command;
      const args = params.command?.args ?? {};
      if (cmd === "model") {
        if (args.modelName) currentModel = args.modelName;
        return ok(id, { success: true, message: `Model changed to ${currentModel}`, data: { model: { id: currentModel, name: currentModel } } });
      }
      if (cmd === "effort") return ok(id, { success: true, message: `Effort set to ${args.level}` });
      if (cmd === "context")
        return ok(id, {
          success: true,
          message: "Context breakdown - 1% used",
          data: { model: currentModel, contextUsagePercentage: 1.0, breakdown: { tools: { tokens: 5000, percent: 0.5 }, yourPrompts: { tokens: 5000, percent: 0.5 } } },
        });
      if (cmd === "usage")
        return ok(id, {
          success: true,
          message: "Plan: FAKE",
          data: { planName: "FAKE PLAN", usageBreakdowns: [{ resourceType: "CREDIT", displayName: "Credits", used: 10, limit: 1000, percentage: 1, overageCharges: 0, currency: "USD", hasLimit: true }] },
        });
      return ok(id, { success: true, message: `ran ${cmd}` });
    }

    case "_kiro.dev/session/list":
      return ok(id, { sessions: [{ sessionId: "fake-session-0001", cwd: process.cwd(), title: "Fake session", updatedAt: new Date().toISOString(), messageCount: 1 }] });

    case "_kiro.dev/settings/list":
      return ok(id, { "chat.defaultModel": currentModel });

    case "_kiro.dev/mcp/startup_status":
      return ok(id, { allStarted: true, failed: [], pending: [], determinable: true });

    case "session/cancel":
      return ok(id, {});

    default:
      return notFound(id, method);
  }
}

// ---------------------------------------------------------------------------
// CLI V3 engine (shapes from kiro-cli 2.28.0 --agent-engine v3 --auth-method=cli)
// ---------------------------------------------------------------------------

const V3_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const V3_LEVEL_NAMES = { low: "Low", medium: "Medium", high: "High", xhigh: "xHigh", max: "Max" };
const V3_MODELS = [
  { id: "auto", name: "Auto", rate: 1 },
  { id: "claude-opus-5.5", name: "Claude Opus 5.5", rate: 2, effort: "medium" },
  { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", rate: 1.3, effort: "high" },
  ...extraModelIds().map((x) => ({ id: x, name: x, rate: 1, effort: "high" })),
];
const V3_MODES = [
  ["vibe", "Default", "General coding assistance"],
  ["spec", "Spec", "Structured feature development"],
  ["plan", "Plan", "Plan-only mode"],
];
const v3State = new Map(); // sessionId -> { mode, model, effort, autopilot }
let v3SessionCounter = 0;

function v3Options(s) {
  const model = V3_MODELS.find((m) => m.id === s.model);
  const out = [
    {
      type: "select", id: "mode", name: "Mode", category: "mode", currentValue: s.mode,
      options: V3_MODES.map(([value, name, description]) => ({ value, name, description, _meta: { kiro: { source: "bundled" } } })),
    },
    {
      type: "select", id: "model", name: "Model", category: "model",
      // Like the real V3, an unknown model is echoed back rather than rejected.
      currentValue: s.model,
      options: V3_MODELS.map((m) => ({
        value: m.id, name: m.name, description: `${m.name} model`,
        _meta: { kiro: { rateMultiplier: m.rate, rateUnit: "Credit", hasEffort: !!m.effort, ...(m.effort ? { effortLevels: V3_LEVELS, defaultEffortLevel: m.effort } : {}) } },
      })),
    },
  ];
  if (model?.effort) {
    out.push({
      type: "select", id: "effortLevel", name: "Effort", category: "thought_level", currentValue: s.effort ?? model.effort,
      options: V3_LEVELS.map((l) => ({ value: l, name: V3_LEVEL_NAMES[l] })),
    });
  }
  out.push({
    type: "select", id: "autopilot", name: "Autopilot", currentValue: s.autopilot,
    options: [
      { value: "on", name: "Autopilot", description: "Agent executes tools without confirmation" },
      { value: "off", name: "Supervised", description: "Agent asks for approval before file changes" },
    ],
  });
  return out;
}

const v3Update = (sessionId, update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const v3Info = (sessionId, kiro) => v3Update(sessionId, { sessionUpdate: "session_info_update", _meta: { kiro } });

function v3SessionState(sessionId) {
  let s = v3State.get(sessionId);
  if (!s) {
    s = { mode: "vibe", model: "auto", effort: undefined, autopilot: "on" };
    v3State.set(sessionId, s);
  }
  return s;
}

function v3EmitSessionStart(sessionId) {
  const s = v3SessionState(sessionId);
  // As observed: commands, then config, then context usage — before the response.
  v3Update(sessionId, {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "bug-fix", description: "Steering: bug-fix", input: { hint: "optional context" }, _meta: { kiro: { type: "steering" } } },
      { name: "context-gatherer", description: "Investigates the codebase", input: { hint: "task to delegate" }, _meta: { kiro: { type: "custom-agent" } } },
    ],
  });
  v3Update(sessionId, { sessionUpdate: "config_option_update", configOptions: v3Options(s) });
  v3Info(sessionId, { kind: "context_usage", usagePercentage: 0.9, breakdown: { tools: { tokens: 4928, percent: 0.5 } } });
  if (MODE === "v3-mcp-fail") {
    send({
      jsonrpc: "2.0", method: "_kiro/mcp/status",
      params: {
        sessionId,
        servers: [
          { name: "github", status: "connected", origin: { origin: "user" } },
          { name: "broken", status: "failed", failedAuthorization: false, errorMessage: "spawn ENOENT", origin: { origin: "workspace" } },
          { name: "linear", status: "failed", failedAuthorization: true, authorizationUrl: "https://example.invalid/oauth", errorMessage: "auth", origin: { origin: "user" } },
        ],
      },
    });
  }
}

async function handleV3(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return;

  switch (method) {
    case "initialize":
      // As 2.28 sends it: no agentInfo; `_meta.kiro.extensionMethods` marks V3.
      return ok(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { list: {}, close: {}, delete: {}, fork: { _meta: { kiro: { messageId: true } } } },
          _meta: { kiro: { extensionMethods: ["_kiro/knowledge", "_kiro/session/context", "_kiro/session/compact"], replayMarking: true } },
        },
        authMethods: [{ id: "aws-builder-id", name: "AWS Builder ID" }, { id: "aws-iam-identity-center", name: "AWS IAM Identity Center" }],
      });

    case "session/new": {
      if (MODE === "auth-expired") return authFail(id, "ExpiredTokenException: The security token included in the request is expired");
      const sessionId = `sess_fake-${++v3SessionCounter}`;
      v3EmitSessionStart(sessionId);
      return ok(id, { _meta: { id: sessionId, source: "local" }, sessionId, modes: { currentModeId: "vibe", availableModes: [] }, configOptions: v3Options(v3SessionState(sessionId)) });
    }

    case "session/load": {
      const s = v3SessionState(params.sessionId);
      // Replay precedes the response, marked as the real V3 marks local replay.
      v3Update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier question" }, _meta: { kiro: { replay: true } } });
      v3Update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED" }, _meta: { kiro: { replay: true } } });
      // Observed on 2.28 for a session with history: the load response OMITS the
      // model option, which follows ~75 ms later as a config_option_update.
      const withoutModel = v3Options(s).filter((o) => o.id !== "model" && o.id !== "effortLevel");
      setTimeout(() => v3Update(params.sessionId, { sessionUpdate: "config_option_update", configOptions: v3Options(s) }), 75);
      // Like the real V3: no sessionId in the load response.
      return ok(id, { _meta: { id: params.sessionId }, modes: { currentModeId: s.mode, availableModes: [] }, configOptions: withoutModel });
    }

    case "session/set_config_option": {
      const s = v3SessionState(params.sessionId);
      if (params.configId === "model") {
        s.model = params.value; // no validation, as observed
        s.effort = undefined; // reset to the new model's default
      } else if (params.configId === "effortLevel") {
        if (V3_LEVELS.includes(params.value)) s.effort = params.value; // bogus values silently ignored
      } else if (params.configId === "mode") s.mode = params.value;
      else if (params.configId === "autopilot") s.autopilot = params.value;
      v3Update(params.sessionId, { sessionUpdate: "config_option_update", configOptions: v3Options(s) });
      return ok(id, { configOptions: v3Options(s) });
    }

    case "session/set_mode": {
      const s = v3SessionState(params.sessionId);
      s.mode = params.modeId;
      v3Update(params.sessionId, { sessionUpdate: "config_option_update", configOptions: v3Options(s) });
      return ok(id, {});
    }

    case "session/list":
      return ok(id, {
        sessions: [...v3State.keys()].map((sessionId) => ({ sessionId, cwd: params?.cwd ?? process.cwd(), title: "Fake V3 session", updatedAt: new Date().toISOString(), _meta: { kiro: { source: "local" } } })),
      });

    case "session/close":
      return ok(id, {});

    case "session/delete":
      v3State.delete(params.sessionId);
      return ok(id, {});

    case "session/prompt": {
      if (MODE === "crash-on-prompt" && shouldCrashNow()) process.exit(3);
      if (MODE === "v3-service-error") {
        return send({ jsonrpc: "2.0", id, error: { code: -32000, message: "A network error occurred. Please check your connection and try again.", data: { errorType: "ClientNetworkError", retryErrorType: "TRANSIENT" } } });
      }
      const text = params.prompt?.[0]?.text ?? "";
      if (text.includes("trigger-open-url")) {
        const res = await requestClient("_kiro/openExternalUrl", { url: "https://example.invalid/consent" });
        v3Update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: res.error ? "URL_DECLINED" : "URL_OPENED" } });
        return ok(id, { stopReason: "end_turn" });
      }
      v3Info(params.sessionId, { kind: "turn_start", turnStart: true });
      v3Update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `FAKE_V3_OK:${text}` } });
      v3Info(params.sessionId, { kind: "context_usage", usagePercentage: 2.35, breakdown: { tools: { tokens: 4928, percent: 0.5 }, yourPrompts: { tokens: 0, percent: 1.7 } } });
      v3Info(params.sessionId, { kind: "turn_completion", promptTurnSummaries: [{ unit: "credit", unitPlural: "credits", usage: 0.07 }], status: "success" });
      v3Info(params.sessionId, { kind: "turn_end", stopReason: "end_turn" });
      return ok(id, { stopReason: "end_turn" });
    }

    case "_kiro/session/context":
      // Real V3 answers null without a subcommand.
      if (params.subcommand !== "show") return ok(id, null);
      return ok(id, { success: true, entries: [], breakdown: { tools: { tokens: 4928, percent: 0.5 }, yourPrompts: { tokens: 0, percent: 1.7 } } });

    case "_kiro/session/compact":
      return ok(id, { success: true });

    case "_kiro/account/getUsage":
      return ok(id, {
        success: true,
        message: "Plan: FAKE V3 | 1 usage breakdowns",
        data: { planName: "FAKE V3 PLAN", usageBreakdowns: [{ resourceType: "CREDIT", displayName: "Credits", used: 12.5, limit: 1000, percentage: 1, overageCharges: 0, currency: "USD", hasLimit: true }] },
      });

    case "session/cancel":
      return ok(id, {});

    default:
      // V3 removed the v2 command API; calling it is a bridge bug.
      return notFound(id, method);
  }
}
