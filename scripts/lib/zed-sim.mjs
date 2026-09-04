/**
 * A minimal stand-in for Zed: an ACP client that spawns the bridge exactly the
 * way Zed's `agent_servers` custom-agent config does, and records everything it
 * receives.
 *
 * Reused by every end-to-end verification script so the tests exercise the real
 * northbound protocol surface rather than internal APIs.
 *
 * It deliberately advertises the same capabilities current Zed advertises, so
 * the bridge behaves as it will in production:
 *   fs.readTextFile/writeTextFile, terminal, session.configOptions.boolean,
 *   elicitation.form + elicitation.url, auth.terminal.
 */
import { spawn } from "node:child_process";

export class ZedSim {
  constructor({ cwd, env = {}, permissionPolicy = "reject", onUpdate } = {}) {
    this.cwd = cwd ?? process.cwd();
    this.env = env;
    this.permissionPolicy = permissionPolicy;
    this.onUpdate = onUpdate;

    this.updates = [];
    this.permissionRequests = [];
    this.elicitations = [];
    this.stderr = [];
    this.notifications = [];

    this._buf = "";
    this._pending = new Map();
    this._nextId = 1;
  }

  /** Spawns the bridge from ./dist, as Zed would spawn the published binary. */
  start() {
    this.child = spawn(process.execPath, ["dist/index.js"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
      env: { ...process.env, ...this.env },
    });
    this.pid = this.child.pid;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (c) => this._onStdout(c));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (c) => {
      for (const line of c.split("\n")) if (line.trim()) this.stderr.push(line);
    });
    return this;
  }

  _onStdout(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // A non-JSON line on stdout is a protocol violation worth failing on.
        this.stdoutGarbage ??= [];
        this.stdoutGarbage.push(line);
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Response to one of our requests.
    if (msg.id !== undefined && !msg.method) {
      const r = this._pending.get(msg.id);
      if (r) {
        this._pending.delete(msg.id);
        r(msg);
      }
      return;
    }
    // Request from the agent -> answer as a client.
    if (msg.id !== undefined && msg.method) {
      void this._answer(msg);
      return;
    }
    // Notification from the agent.
    if (msg.method === "session/update") {
      this.updates.push(msg.params);
      this.onUpdate?.(msg.params);
    } else {
      this.notifications.push(msg);
    }
  }

  async _answer(msg) {
    const { id, method, params } = msg;
    let result = {};
    switch (method) {
      case "session/request_permission": {
        this.permissionRequests.push(params);
        const opts = params.options ?? [];
        const want =
          this.permissionPolicy === "allow"
            ? (opts.find((o) => o.kind === "allow_once") ?? opts[0])
            : (opts.find((o) => o.kind === "reject_once") ?? opts[0]);
        result = want
          ? { outcome: { outcome: "selected", optionId: want.optionId } }
          : { outcome: { outcome: "cancelled" } };
        break;
      }
      case "fs/read_text_file": {
        const { readFileSync } = await import("node:fs");
        try {
          result = { content: readFileSync(params.path, "utf8") };
        } catch {
          result = { content: "" };
        }
        break;
      }
      case "fs/write_text_file": {
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { dirname } = await import("node:path");
        mkdirSync(dirname(params.path), { recursive: true });
        writeFileSync(params.path, params.content ?? "");
        result = {};
        break;
      }
      case "elicitation/create": {
        this.elicitations.push(params);
        // Zed auto-accepts URL elicitations; mirror that.
        result = { action: "accept" };
        break;
      }
      default:
        result = {};
    }
    this._send({ jsonrpc: "2.0", id, result });
  }

  _send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params, timeoutMs = 120000) {
    const id = this._nextId++;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this._pending.delete(id);
        resolve({ __timeout: true });
      }, timeoutMs);
      this._pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  /** Standard Zed-shaped initialize. */
  initialize() {
    return this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        session: { configOptions: { boolean: {} } },
        auth: { terminal: true },
        elicitation: { form: {}, url: {} },
      },
      clientInfo: { name: "zed", version: "0.0.0-sim", title: "Stable" },
    });
  }

  newSession(cwd = this.cwd, mcpServers = []) {
    return this.request("session/new", { cwd, mcpServers });
  }

  prompt(sessionId, text) {
    return this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  setConfigOption(sessionId, configId, value) {
    return this.request("session/set_config_option", { sessionId, configId, value });
  }

  /** All session/update payloads of one variant. */
  updatesOfKind(kind) {
    return this.updates.filter((u) => u.update?.sessionUpdate === kind);
  }

  /** Concatenated agent message text. */
  text() {
    return this.updatesOfKind("agent_message_chunk")
      .map((u) => u.update.content?.text ?? "")
      .join("");
  }

  /** Counts of every variant seen, for assertions. */
  variantCounts() {
    const out = {};
    for (const u of this.updates) {
      const k = u.update?.sessionUpdate ?? "(none)";
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }

  clearUpdates() {
    this.updates = [];
  }

  /** Closes stdin and waits for the bridge to exit, then reports liveness. */
  async stop(graceMs = 4000) {
    if (!this.child || this.child.exitCode !== null) return { exited: true };
    const exited = new Promise((r) => this.child.once("exit", (code, sig) => r({ code, sig })));
    this.child.stdin.end();
    const timer = new Promise((r) => setTimeout(() => r(null), graceMs));
    const res = await Promise.race([exited, timer]);
    if (res === null) {
      this.child.kill("SIGKILL");
      await exited;
      return { exited: true, forced: true };
    }
    return { exited: true, ...res };
  }
}

/** True if a pid is still running. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
