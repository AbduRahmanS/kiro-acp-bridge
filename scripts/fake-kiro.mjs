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
 *
 * Note it is invoked as `<path> acp --agent-engine v2`, so it ignores argv.
 */

const MODE = process.env.FAKE_KIRO_MODE ?? "ok";

const MODELS = [
  { modelId: "auto", name: "auto", description: "Models chosen by task" },
  { modelId: "claude-opus-5", name: "claude-opus-5", description: "Claude Opus 5 model with 1M context window" },
  { modelId: "gpt-5.6-sol", name: "gpt-5.6-sol", description: "Experimental preview of OpenAI GPT 5.6 Sol" },
];
const AGENTS = [
  { id: "kiro_default", name: "kiro_default", description: "The default agent for Kiro CLI" },
  { id: "kiro_planner", name: "kiro_planner", description: "Specialized planning agent" },
];
const EFFORTS = { "claude-opus-5": ["low", "medium", "high", "xhigh", "max"], "gpt-5.6-sol": ["none", "low", "medium", "high", "xhigh", "max"], auto: [] };

let currentModel = "claude-opus-5";
let currentAgent = "kiro_default";

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
/** Kiro surfaces auth problems as generic internal errors with detail in `data`. */
const authFail = (id, detail) =>
  send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error", data: { details: detail } } });
const notFound = (id, method) =>
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found", data: method } });

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification; nothing to answer

  switch (method) {
    case "initialize":
      // Exactly what kiro-cli 2.21.0 returns, including the empty authMethods
      // that makes the bridge's terminal-auth addition necessary.
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
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FAKE_OK" } } },
      });
      return ok(id, { stopReason: "end_turn" });

    case "session/set_model":
      currentModel = params.modelId;
      return ok(id, {});

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
          options: MODELS.map((m) => ({ value: m.modelId, label: m.modelId, description: m.modelId === currentModel ? `${m.description} [active]` : m.description, group: "1.00x credits" })),
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
