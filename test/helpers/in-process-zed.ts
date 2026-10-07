/**
 * An in-process stand-in for Zed, driving a real `KiroBridge` over stdio streams.
 *
 * The bridge spawns `scripts/fake-kiro.mjs` as its Kiro, so these tests exercise
 * the full northbound and southbound protocol paths without a real kiro-cli —
 * which CI does not have and must not need.
 */

import { PassThrough } from "node:stream";
import { resolve } from "node:path";
import { chmodSync } from "node:fs";
import { KiroBridge } from "../../src/bridge/bridge.js";
import { Diagnostics } from "../../src/diagnostics/logging.js";

export const FAKE_KIRO = resolve(__dirname, "../../scripts/fake-kiro.mjs");
chmodSync(FAKE_KIRO, 0o755);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface SimOptions {
  engine?: string;
  env?: Record<string, string>;
  /** Advertise URL elicitation like current Zed. */
  urlElicitation?: boolean;
}

export class InProcessZed {
  readonly updates: Json[] = [];
  readonly elicitations: Json[] = [];
  readonly bridge: KiroBridge;
  private readonly toBridge = new PassThrough();
  private readonly fromBridge = new PassThrough();
  private readonly pending = new Map<number, (m: Json) => void>();
  private nextId = 1;
  private buf = "";
  private readonly served: Promise<void>;
  private readonly urlElicitation: boolean;

  constructor(opts: SimOptions = {}) {
    this.urlElicitation = opts.urlElicitation ?? true;
    this.bridge = new KiroBridge({
      diagnostics: new Diagnostics({ level: "error" }),
      kiroPath: FAKE_KIRO,
      agentEngine: opts.engine,
      cwd: process.cwd(),
      env: { ...process.env, ...opts.env },
    });
    this.fromBridge.setEncoding("utf8");
    this.fromBridge.on("data", (c: string) => this.onData(c));
    this.served = this.bridge.serve(this.toBridge, this.fromBridge);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as Json;
      if (msg.id !== undefined && msg.method === undefined) {
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      } else if (msg.id !== undefined) {
        void this.answer(msg);
      } else if (msg.method === "session/update") {
        this.updates.push(msg.params);
      }
    }
  }

  private async answer(msg: Json): Promise<void> {
    let result: Json = {};
    if (msg.method === "elicitation/create") {
      this.elicitations.push(msg.params);
      result = { action: "accept" };
    } else if (msg.method === "session/request_permission") {
      result = { outcome: { outcome: "cancelled" } };
    }
    this.toBridge.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
  }

  request(method: string, params: unknown, timeoutMs = 15_000): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
      this.pending.set(id, (m) => {
        clearTimeout(t);
        resolvePromise(m);
      });
      this.toBridge.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  initialize(): Promise<Json> {
    return this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        session: { configOptions: { boolean: {} } },
        auth: { terminal: true },
        elicitation: this.urlElicitation ? { form: {}, url: {} } : { form: {} },
      },
      clientInfo: { name: "zed", version: "0.0.0-test" },
    });
  }

  newSession(cwd = process.cwd()): Promise<Json> {
    return this.request("session/new", { cwd, mcpServers: [] });
  }

  prompt(sessionId: string, text: string): Promise<Json> {
    return this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  }

  setConfig(sessionId: string, configId: string, value: unknown): Promise<Json> {
    return this.request("session/set_config_option", { sessionId, configId, value });
  }

  /** Concatenated agent text since the last clear. */
  text(): string {
    return this.updates
      .filter((u) => u.update?.sessionUpdate === "agent_message_chunk")
      .map((u) => u.update.content?.text ?? "")
      .join("");
  }

  ofKind(kind: string): Json[] {
    return this.updates.filter((u) => u.update?.sessionUpdate === kind);
  }

  clear(): void {
    this.updates.length = 0;
  }

  /** Lets deferred notifications (setTimeout 0) land. */
  async settle(ms = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  async close(): Promise<void> {
    this.toBridge.end();
    await Promise.race([this.served, new Promise((r) => setTimeout(r, 5000))]);
  }
}

export const optionOf = (opts: Json[] | undefined, id: string) => (opts ?? []).find((o) => o.id === id);
export const valuesOf = (opt: Json | undefined): string[] =>
  (opt?.options ?? []).flatMap((x: Json) => (x.options ? x.options.map((y: Json) => y.value) : [x.value]));
