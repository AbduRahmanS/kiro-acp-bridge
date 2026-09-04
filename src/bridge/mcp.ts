/**
 * MCP translation.
 *
 * Two responsibilities:
 *
 * **Server forwarding.** Zed forwards every MCP server it knows about on
 * `session/new`. Kiro *also* loads its own servers from `.kiro/settings/mcp.json`
 * and agent configs. Passing Zed's list through unfiltered would start the same
 * server twice whenever a user has configured it in both places — duplicate tools,
 * duplicate OAuth prompts, doubled token cost. So we de-duplicate by name.
 *
 * **OAuth.** Kiro announces that an MCP server needs authorisation with a
 * `_kiro.dev/mcp/oauth_request` notification carrying a URL. ACP has a purpose-built
 * mechanism for exactly this: `elicitation/create` with `mode: "url"`, stabilised
 * in ACP 1.21.0 and supported by current Zed (which declares
 * `elicitation.url` and opens the link via `cx.open_url`).
 *
 * Security constraints, treated as hard requirements:
 *   - the URL goes to the *client*, which asks the user; the bridge never opens it
 *   - no token, code, or verifier is ever logged
 *   - the OAuth flow never passes through the model
 */

import type * as schema from "@agentclientprotocol/sdk";

/** An MCP server entry as it appears in an ACP `session/new` request. */
type McpServer = schema.NewSessionRequest["mcpServers"][number];

/** Extracts the server name from any MCP transport variant. */
export function mcpServerName(server: McpServer): string | undefined {
  const s = server as unknown as { name?: unknown };
  return typeof s.name === "string" ? s.name : undefined;
}

/**
 * Filters Zed's MCP list against the servers Kiro already manages.
 *
 * Name comparison is case-insensitive and trims whitespace, because the two
 * config sources are edited by hand and by different tools.
 */
export function deduplicateMcpServers(
  fromClient: readonly McpServer[],
  kiroManagedNames: readonly string[],
): { forward: McpServer[]; skipped: string[] } {
  const managed = new Set(kiroManagedNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const forward: McpServer[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const server of fromClient) {
    const name = mcpServerName(server);
    const key = (name ?? "").trim().toLowerCase();
    if (!key) {
      // Unnamed servers cannot be de-duplicated; forward and let Kiro decide.
      forward.push(server);
      continue;
    }
    if (managed.has(key) || seen.has(key)) {
      skipped.push(name ?? key);
      continue;
    }
    seen.add(key);
    forward.push(server);
  }
  return { forward, skipped };
}

/** Names of the MCP servers Kiro is managing itself, from its startup status. */
export function kiroManagedServerNames(status: unknown): string[] {
  if (!status || typeof status !== "object") return [];
  const s = status as Record<string, unknown>;
  const names: string[] = [];
  for (const key of ["failed", "pending", "started", "servers"]) {
    const list = s[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === "string") names.push(entry);
      else if (entry && typeof entry === "object") {
        const n = (entry as Record<string, unknown>).name;
        if (typeof n === "string") names.push(n);
      }
    }
  }
  return names;
}

/**
 * Builds a URL elicitation for an MCP OAuth request.
 *
 * Returns undefined when Kiro supplied no URL, so we never raise an empty prompt.
 * The `elicitationId` is required by ACP so the client can be told when the flow
 * completes; we derive it from the server name plus a nonce, which keeps it
 * meaningful in logs without containing anything sensitive.
 */
export function buildOauthElicitation(
  sessionId: string,
  serverName: string | undefined,
  url: string | undefined,
  nonce: string,
): schema.CreateElicitationRequest | undefined {
  if (!url) return undefined;
  // Only http(s) may be handed to a browser-opening client.
  if (!/^https?:\/\//i.test(url)) return undefined;

  const label = serverName ?? "an MCP server";
  return {
    sessionId: sessionId as schema.SessionId,
    mode: "url",
    elicitationId: `kiro-mcp-oauth-${slug(label)}-${nonce}`,
    url,
    message: `**${label}** needs authorisation. Open the link to sign in, then return here.`,
  } as schema.CreateElicitationRequest;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "server";
}

/** Renders MCP startup status as a short Markdown notice, or undefined if fine. */
export function formatMcpStatus(status: {
  allStarted?: boolean | undefined;
  failed?: unknown[] | undefined;
  pending?: unknown[] | undefined;
}): string | undefined {
  const failed = status.failed ?? [];
  if (failed.length === 0) return undefined;

  const names = failed
    .map((f) => {
      if (typeof f === "string") return f;
      if (f && typeof f === "object") {
        const o = f as Record<string, unknown>;
        const name = typeof o.name === "string" ? o.name : "unknown";
        const reason = typeof o.reason === "string" ? o.reason : undefined;
        return reason ? `${name} (${reason})` : name;
      }
      return "unknown";
    })
    .join(", ");

  return `**MCP server${failed.length > 1 ? "s" : ""} failed to start:** ${names}`;
}
