/**
 * Authentication.
 *
 * Kiro returns `authMethods: []` from `initialize` — it assumes an
 * already-authenticated CLI and offers no in-protocol way to sign in. That has
 * two consequences:
 *
 *  1. A client cannot help a user who is signed out. Zed advertises
 *     `auth.terminal: true` and would happily run a setup flow, but there is
 *     nothing to run.
 *  2. The ACP Registry refuses to list agents that return no auth method, so
 *     Kiro cannot be published as-is.
 *
 * ACP's **Terminal Auth** (stabilised in schema 1.21.0) fits Kiro exactly:
 * the client re-runs the agent binary with replacement arguments, the agent
 * presents an interactive terminal UI, and exit code 0 means success. Kiro's
 * `kiro-cli login` is precisely that — a browser/device OAuth flow driven from a
 * terminal.
 *
 * So the bridge advertises a terminal auth method and implements it by handing
 * control to `kiro-cli login`. This is not a workaround to satisfy a registry
 * check: it is the honest description of how Kiro authentication actually works,
 * and it makes signing in reachable from inside Zed.
 *
 * The bridge still never touches credentials. `kiro-cli` performs the flow and
 * owns the resulting tokens.
 */

import type * as schema from "@agentclientprotocol/sdk";

/** Identifier for the terminal sign-in method, stable across releases. */
export const KIRO_LOGIN_METHOD_ID = "kiro-cli-login";

/** The argument that puts the bridge into interactive login mode. */
export const LOGIN_FLAG = "--login";

/**
 * Builds the auth methods to advertise.
 *
 * Kiro's own methods are passed through when it ever reports any. The terminal
 * method is added only when the client says it can run one — advertising a flow
 * the client cannot execute would be a dead end in the UI.
 */
export function buildAuthMethods(
  kiroAuthMethods: readonly schema.AuthMethod[] | undefined,
  clientCapabilities: schema.ClientCapabilities | undefined,
): schema.AuthMethod[] {
  const methods: schema.AuthMethod[] = [...(kiroAuthMethods ?? [])];

  const clientSupportsTerminalAuth = clientCapabilities?.auth?.terminal === true;
  if (!clientSupportsTerminalAuth) return methods;

  // Do not duplicate if Kiro ever starts advertising its own terminal method.
  const alreadyPresent = methods.some(
    (m) => (m as { type?: string }).type === "terminal",
  );
  if (alreadyPresent) return methods;

  methods.push({
    id: KIRO_LOGIN_METHOD_ID as schema.AuthMethodId,
    name: "Sign in to Kiro",
    description: "Runs `kiro-cli login` in a terminal to authenticate this machine.",
    type: "terminal",
    // These REPLACE the normal args for the setup run, per the ACP spec.
    args: [LOGIN_FLAG],
    env: {},
  } as unknown as schema.AuthMethod);

  return methods;
}

/**
 * Error fragments Kiro emits when credentials are missing or stale.
 *
 * Taken from Kiro's own error vocabulary. Matching on text is unavoidable: Kiro
 * surfaces these as generic internal errors over ACP with no distinguishing
 * code, and issue #10416 shows the same strings reaching other ACP clients.
 */
const AUTH_ERROR_PATTERNS = [
  "expiredtoken",
  "tokenexpired",
  "invalidgrant",
  "accessdenied",
  "unauthorized",
  "not logged in",
  "no valid credentials",
  "authentication required",
  "please log in",
  "please login",
  "reauthenticate",
  "re-authenticate",
];

/**
 * True when an error from Kiro looks like an authentication failure.
 *
 * Used to translate into ACP's `-32000 authentication required`, which is the
 * signal clients use to offer the auth methods from `initialize`. Without this
 * translation a signed-out user sees an opaque internal error instead of a
 * sign-in prompt.
 */
export function isAuthError(err: unknown): boolean {
  const haystack = collectErrorText(err).toLowerCase();
  if (!haystack) return false;
  return AUTH_ERROR_PATTERNS.some((p) => haystack.includes(p));
}

/** Gathers message and nested data text from an arbitrary error value. */
function collectErrorText(err: unknown): string {
  if (err === null || err === undefined) return "";
  if (typeof err === "string") return err;
  const parts: string[] = [];
  const e = err as { message?: unknown; data?: unknown; code?: unknown };
  if (typeof e.message === "string") parts.push(e.message);
  if (e.data !== undefined) {
    try {
      parts.push(typeof e.data === "string" ? e.data : JSON.stringify(e.data));
    } catch {
      /* unserialisable */
    }
  }
  return parts.join(" ");
}

/** Guidance shown when authentication is required. */
export function authRequiredMessage(): string {
  return [
    "**Kiro is not authenticated.**",
    "",
    "Sign in with the terminal auth method, or run this in a terminal:",
    "",
    "```",
    "kiro-cli login",
    "```",
    "",
    "Then start a new thread.",
  ].join("\n");
}
