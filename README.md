# Kiro ACP Bridge

Native Kiro selectors and slash commands inside Zed's Agent Panel.

```
Kiro
Agent    Default          ▾
Model    Claude Opus 5    ▾
Effort   Max              ▾
```

## The problem it solves

Zed and Kiro both speak the Agent Client Protocol, but different generations of it.

Kiro CLI 2.21.0 exposes model selection through `session/set_model` and a `models`
block on `session/new` — an unstable API that was **removed from ACP** and removed
from Zed in [zed#58308](https://github.com/zed-industries/zed/pull/58308). Current Zed
drives models, modes and reasoning effort exclusively through
`session/set_config_option`, which Kiro answers with `-32601 Method not found`.

Neither side is broken. They just cannot see each other. The visible symptoms are
[zed#59169](https://github.com/zed-industries/zed/issues/59169) (no model picker),
[kiro#9998](https://github.com/kirodotdev/Kiro/issues/9998) (reasoning effort
unreachable) and [kiro#10034](https://github.com/kirodotdev/Kiro/issues/10034).

This bridge sits between them and translates. Zed sees clean, standard ACP; Kiro keeps
using the protocol it already implements.

## What you get

- **Native model picker** with Kiro's real models, discovered dynamically, showing
  each model's credit multiplier. Switch models mid-thread — no restart, no new
  conversation.
- **Native reasoning-effort picker** whose options are re-queried per model. GPT models
  offer `none`; Claude models do not; `auto` has no effort axis, so the selector is
  withdrawn and you are told why.
- **Native agent picker** including Plan, Guide and your own custom agents from
  `~/.kiro/agents/`.
- **Slash commands** — type `/` and Kiro's commands appear, including all your skills
  from `~/.kiro/skills/` and `.kiro/skills/`, which Kiro does not publish over ACP at
  all.
- **Real context usage** in Zed's context ring, using measured token counts rather
  than numbers inferred from a percentage.
- Tool calls, permission prompts, cancellation and images, with two Kiro path defects
  corrected so diffs and file links point at the right files.
- **Sign in from inside Zed.** Kiro advertises no ACP auth method at all, so a
  signed-out user has no way in; the bridge adds ACP Terminal Auth backed by
  `kiro-cli login`.

## Requirements

- Node.js ≥ 22
- Kiro CLI, already signed in (`kiro-cli --version` should work)
- Zed with external agent support

The bridge holds no credentials. It uses your existing authenticated Kiro CLI.

## Install

```bash
npm install -g kiro-acp-bridge
```

Then in Zed's `settings.json`:

```json
{
  "agent_servers": {
    "Kiro": {
      "type": "custom",
      "command": "kiro-acp-bridge",
      "args": [],
      "env": {}
    }
  }
}
```

Open the Agent Panel, pick **Kiro** as the agent, and the three selectors appear.

Full options, including `npx` usage and remote projects, are in
[docs/zed-setup.md](docs/zed-setup.md).

## Architecture

```
Zed  ──standard ACP v1──▶  kiro-acp-bridge  ──legacy ACP + _kiro.dev/*──▶  kiro-cli acp
```

One process, two ACP connections: an agent northbound to Zed, a client southbound to
Kiro. All Kiro-specific vocabulary stays on the southbound side.

The three translations that matter:

| Zed asks for | Bridge sends to Kiro |
|---|---|
| `set_config_option` `model` | `session/set_model` |
| `set_config_option` `effort` | `commands/execute {effort, {level}}` |
| `set_config_option` `agent` | `session/set_mode` |

See [docs/architecture.md](docs/architecture.md) for module layout and
[docs/architecture-decision.md](docs/architecture-decision.md) for why a bridge rather
than a fork.

## Supported versions

| Component | Verified |
|---|---|
| Kiro CLI | 2.21.0, agent engine **v2** |
| ACP | protocol version 1 (stable) |
| SDK | `@agentclientprotocol/sdk` 1.4.0 |

The v3 agent engine is **not** supported: its ACP surface is broken (`session/new`
fails, all `_kiro.dev/*` methods return an internal error). The bridge pins v2.

Feature detection is used throughout rather than version checks, so most Kiro updates
need no change here. See [docs/compatibility.md](docs/compatibility.md).

## Known limitations

- **No slash-command argument autocomplete.** ACP v1 has no completion mechanism, and
  Zed reads `AvailableCommand.input` as a boolean while discarding the hint text. Not
  fixable in a bridge.
- **Image support is per-model**, but ACP advertises it per-agent. Sending an image to
  a non-vision model surfaces Kiro's error rather than silently degrading.
- **MCP OAuth is implemented but not verified end-to-end** — no OAuth-requiring MCP
  server was available to test against.
- **`/spawn` and `/rewind` work as commands** but have no richer Zed UI, because ACP
  has no surface for parallel sessions or checkpoint selection.

Full list with reasons: [docs/capability-matrix.md](docs/capability-matrix.md).

## Troubleshooting

**"Kiro CLI was not found"** — the message lists every path searched and how to fix it.
Set `KIRO_CLI_PATH` in the `env` block of your Zed agent config.

**Selectors missing** — confirm you selected the bridge, not `kiro-cli` directly.
Check with `dev: open acp logs` in Zed's command palette: `session/new` should return
a `configOptions` array.

**Anything else** — enable tracing and read the frames:

```bash
KIRO_BRIDGE_TRACE=1 KIRO_BRIDGE_TRACE_FILE=/tmp/kiro-bridge.log kiro-acp-bridge
```

More in [docs/debugging.md](docs/debugging.md).

## Privacy and security

- No telemetry. No network calls of its own — it only speaks to your local `kiro-cli`.
- No credentials stored or read. Kiro owns authentication.
- **Prompt content is not logged**, even with tracing on. `KIRO_BRIDGE_TRACE_CONTENT=1`
  opts in explicitly; the resulting file will contain your prompts.
- Secret-bearing keys (tokens, API keys, authorization headers, client secrets) are
  redacted from all diagnostics.
- OAuth URLs are never logged and never opened by the bridge — they go to Zed, which
  asks you first.
- Kiro's permission model is untouched: the bridge never auto-approves a tool call and
  never adds an option Kiro did not offer.
- Subprocesses are spawned with a fixed argument array and `shell: false`, so there is
  no shell interpolation path.

## Development

```bash
npm install
npm run build
npm test                      # 186 unit tests
node scripts/handshake.mjs    # real Kiro handshake, proves clean teardown
```

End-to-end scripts under `scripts/` drive the built bridge through a simulated Zed
against real Kiro. They use `KIRO_DATA_DIR` isolation so they never touch `~/.kiro`,
and prefer the cheapest model to keep credit spend negligible.

```bash
node scripts/e2e-spine.mjs      # streaming, tools, permissions, paths, cancel
node scripts/e2e-config.mjs     # model / effort / agent selectors
node scripts/e2e-commands.mjs   # slash commands, skills, state sync
node scripts/e2e-usage.mjs      # context usage, credits, session list
node scripts/e2e-failures.mjs   # failure paths, redaction, crash, images
```

## Licence

Apache-2.0. See [docs/research.md](docs/research.md#11-licensing) for licence findings
on the projects studied as references — no code was copied from any of them.
