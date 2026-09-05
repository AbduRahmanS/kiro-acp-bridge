/**
 * Authentication.
 *
 * Kiro's ACP auth surface is **state-dependent**, which is easy to misread.
 * Measured against kiro-cli 2.21.0 with an authenticated CLI, `initialize`
 * returns `authMethods: []`. But the shipped binary contains a `kiro-login`
 * method ("Kiro Login", "Run `… login` in terminal to authenticate") which it
 * advertises when authentication is actually required — so an empty list means
 * "nothing needed right now", not "no method exists".
 *
 * Two real gaps remain, and the bridge closes both:
 *
 *  1. **The state is not knowable before the handshake.** A client decides what
 *     to render from a single `initialize` response. Advertising a terminal method
 *     unconditionally means a sign-in affordance always exists — including for a
 *     token that expires mid-session.
 *  2. **`kiro-cli` may be absent entirely.** The bridge ships via npx and does not
 *     bundle Kiro, so on a fresh machine — or the ACP Registry's CI runner — there
 *     is no Kiro process to advertise anything at all.
 *
 * ACP's **Terminal Auth** (stabilised in schema 1.21.0) models this exactly: the
 * client re-runs the agent binary with replacement arguments, the agent presents an
 * interactive terminal UI, and exit code 0 means success. `kiro-cli login` is
 * precisely that — a browser/device OAuth flow driven from a terminal. This is a
 * faithful translation of Kiro's own mechanism, not an invention.
 *
 * The bridge never touches credentials. `kiro-cli` performs the flow and owns the
 * resulting tokens.
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
