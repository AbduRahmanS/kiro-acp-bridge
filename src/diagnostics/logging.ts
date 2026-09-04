/**
 * Diagnostics for the bridge.
 *
 * Hard rule: stdout belongs exclusively to the ACP JSON-RPC stream that Zed
 * reads. Every diagnostic byte goes to stderr or to an explicit file. Nothing
 * in this module may ever write to stdout.
 */

import { createWriteStream } from "node:fs";

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/** Direction of a traced JSON-RPC frame, in the bridge's four-way topology. */
export type TraceDirection =
  | "zed->bridge"
  | "bridge->zed"
  | "bridge->kiro"
  | "kiro->bridge"
  | "kiro-stderr";

export interface DiagnosticsOptions {
  /** Minimum level to emit. Defaults to `warn`. */
  level?: LogLevel;
  /** Enable sanitised JSON-RPC frame tracing. Off by default. */
  trace?: boolean;
  /** Include prompt/message text in traces. Off by default even when tracing. */
  tracePromptContent?: boolean;
  /** Optional file to receive traces in addition to stderr. */
  traceFile?: string;
}

/**
 * Keys whose values are replaced wholesale. Matched case-insensitively against
 * the *whole* key, so we do not accidentally scrub unrelated fields.
 */
const SECRET_KEYS = new Set(
  [
    "token",
    "accessToken",
    "refreshToken",
    "idToken",
    "bearerToken",
    "apiKey",
    "api_key",
    // NB: "authorization" only. A bare "auth" key is a *capability* object in
    // ACP (`agentCapabilities.auth`), so redacting it would hide diagnostics
    // without protecting anything.
    "authorization",
    "password",
    "passwd",
    "secret",
    "clientSecret",
    "client_secret",
    "credentials",
    "credential",
    "privateKey",
    "private_key",
    "sessionToken",
    "session_token",
    "cookie",
    "setCookie",
    "set_cookie",
    "code_verifier",
    "codeVerifier",
    "clientId",
    "client_id",
  ].map((k) => k.toLowerCase()),
);

/** Keys holding free-form model/user text, redacted unless explicitly enabled. */
const CONTENT_KEYS = new Set(["text", "content", "message", "summary", "prompt", "data"].map((k) => k.toLowerCase()));

const REDACTED = "[redacted]";

/**
 * Recursively sanitise a JSON-RPC payload for logging.
 *
 * Removes secrets unconditionally. Removes free-text content unless
 * `includeContent` is set. Truncates long strings and large arrays so a trace
 * stays readable and cannot blow up memory.
 */
export function sanitize(value: unknown, includeContent = false, depth = 0): unknown {
  if (depth > 12) return "[depth-limit]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return value.length > 400 ? `${value.slice(0, 400)}…[+${value.length - 400} chars]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const head = value.slice(0, 40).map((v) => sanitize(v, includeContent, depth + 1));
    if (value.length > 40) head.push(`[+${value.length - 40} more]`);
    return head;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (SECRET_KEYS.has(lower)) {
        out[k] = REDACTED;
        continue;
      }
      // Base64 image payloads are never useful in a trace and are enormous.
      if (lower === "data" && typeof v === "string" && v.length > 256) {
        out[k] = `[binary ${v.length} chars]`;
        continue;
      }
      if (!includeContent && CONTENT_KEYS.has(lower) && typeof v === "string") {
        out[k] = `[content ${v.length} chars]`;
        continue;
      }
      out[k] = sanitize(v, includeContent, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Reads diagnostics configuration from the environment. */
export function diagnosticsFromEnv(env: NodeJS.ProcessEnv = process.env): DiagnosticsOptions {
  const truthy = (v: string | undefined) => v === "1" || v === "true" || v === "yes";
  const rawLevel = (env.KIRO_BRIDGE_LOG_LEVEL ?? "").toLowerCase();
  const level = (Object.keys(LEVEL_ORDER) as LogLevel[]).includes(rawLevel as LogLevel)
    ? (rawLevel as LogLevel)
    : undefined;
  const opts: DiagnosticsOptions = {
    trace: truthy(env.KIRO_BRIDGE_TRACE),
    tracePromptContent: truthy(env.KIRO_BRIDGE_TRACE_CONTENT),
  };
  if (level) opts.level = level;
  if (env.KIRO_BRIDGE_TRACE_FILE) opts.traceFile = env.KIRO_BRIDGE_TRACE_FILE;
  // Tracing implies at least debug verbosity so the trace is not filtered out.
  if (opts.trace && !level) opts.level = "debug";
  return opts;
}

export class Diagnostics {
  private readonly level: LogLevel;
  private readonly traceEnabled: boolean;
  private readonly includeContent: boolean;
  private readonly traceFile: string | undefined;
  private fileStream: import("node:fs").WriteStream | undefined;
  /** Set once the trace file proves unusable, so we stop retrying every line. */
  private fileStreamFailed = false;

  constructor(options: DiagnosticsOptions = {}) {
    this.level = options.level ?? "warn";
    this.traceEnabled = options.trace ?? false;
    this.includeContent = options.tracePromptContent ?? false;
    this.traceFile = options.traceFile;
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] <= LEVEL_ORDER[this.level];
  }

  private emit(line: string): void {
    // stderr only — never stdout.
    process.stderr.write(`${line}\n`);
    if (this.traceFile && !this.fileStreamFailed) {
      try {
        if (!this.fileStream) {
          this.fileStream = createWriteStream(this.traceFile, { flags: "a" });
          // A file that becomes unwritable mid-run must not take the bridge down.
          this.fileStream.on("error", (err) => {
            this.fileStreamFailed = true;
            process.stderr.write(
              `[kiro-bridge] WARN trace file unusable (${(err as Error).message}); continuing on stderr only\n`,
            );
          });
        }
        this.fileStream.write(`${line}\n`);
      } catch (err) {
        // Never let diagnostics break the protocol path.
        this.fileStreamFailed = true;
        process.stderr.write(
          `[kiro-bridge] WARN could not open trace file (${(err as Error).message}); continuing on stderr only\n`,
        );
      }
    }
  }

  log(level: LogLevel, message: string, detail?: unknown): void {
    if (!this.enabled(level)) return;
    const ts = new Date().toISOString();
    let line = `${ts} [kiro-bridge] ${level.toUpperCase()} ${message}`;
    if (detail !== undefined) {
      line += ` ${JSON.stringify(sanitize(detail, this.includeContent))}`;
    }
    this.emit(line);
  }

  error(message: string, detail?: unknown): void {
    this.log("error", message, detail);
  }
  warn(message: string, detail?: unknown): void {
    this.log("warn", message, detail);
  }
  info(message: string, detail?: unknown): void {
    this.log("info", message, detail);
  }
  debug(message: string, detail?: unknown): void {
    this.log("debug", message, detail);
  }

  /** Traces one JSON-RPC frame. No-op unless tracing is explicitly enabled. */
  trace(direction: TraceDirection, frame: unknown): void {
    if (!this.traceEnabled) return;
    const ts = new Date().toISOString();
    const f = frame as { method?: string; id?: unknown; error?: unknown; params?: { sessionId?: string } };
    const kind = f?.method ? (f.id === undefined ? "notify" : "request") : f?.error ? "error" : "response";
    const parts = [ts, `[kiro-bridge] TRACE`, direction.padEnd(11), kind.padEnd(8)];
    if (f?.method) parts.push(String(f.method));
    if (f?.id !== undefined) parts.push(`id=${String(f.id)}`);
    const sid = f?.params?.sessionId;
    if (sid) parts.push(`session=${sid}`);
    this.emit(`${parts.join(" ")} ${JSON.stringify(sanitize(frame, this.includeContent))}`);
  }

  /** Forwards a line of Kiro's stderr, tagged so it cannot be confused with ours. */
  kiroStderr(line: string): void {
    if (!this.enabled("debug")) return;
    this.emit(`${new Date().toISOString()} [kiro-cli] ${line}`);
  }

  close(): void {
    this.fileStream?.end();
    this.fileStream = undefined;
  }
}
