# Zed Setup

## Quick start

Install:

```bash
npm install -g kiro-acp-bridge
```

Add to Zed's `settings.json` (command palette → `zed: open settings`):

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

Open the Agent Panel, choose **Kiro**, and start a thread. Three selectors appear:
Agent, Model, Effort.

## Without a global install

`npx` avoids a global install and keeps the bridge current:

```json
{
  "agent_servers": {
    "Kiro": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "kiro-acp-bridge"],
      "env": {}
    }
  }
}
```

Slower to start (npx resolves the package each launch) but convenient for trying it out.

## From a checkout, for development

```bash
git clone <repo> && cd kiro-acp-bridge
npm install && npm run build
```

```json
{
  "agent_servers": {
    "Kiro (dev)": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/kiro-acp-bridge/dist/index.js"],
      "env": { "KIRO_BRIDGE_LOG_LEVEL": "info" }
    }
  }
}
```

Use an absolute path — Zed does not expand `~` here reliably. Re-run `npm run build`
and start a new thread to pick up changes.

## When Kiro is not on Zed's PATH

This is the most common setup problem. Zed launches agent servers with a minimal
environment, so shell PATH additions from `.zshrc` are often absent.

The bridge searches PATH, then `~/.local/bin`, then platform locations including
`/Applications/Kiro CLI.app/Contents/MacOS`. If it still cannot find Kiro, set the
path explicitly:

```json
{
  "agent_servers": {
    "Kiro": {
      "type": "custom",
      "command": "kiro-acp-bridge",
      "args": [],
      "env": { "KIRO_CLI_PATH": "/Users/you/.local/bin/kiro-cli" }
    }
  }
}
```

Find the right value with `which kiro-cli` in your terminal.

## Configuration reference

All configuration is via `env` in the Zed agent block.

| Variable | Default | Purpose |
|---|---|---|
| `KIRO_CLI_PATH` | auto-discovered | Absolute path to `kiro-cli` |
| `KIRO_BRIDGE_AGENT_ENGINE` | `v2` | Kiro agent engine. **Leave this alone** — v3's ACP surface is broken |
| `KIRO_BRIDGE_LOG_LEVEL` | `warn` | `error` \| `warn` \| `info` \| `debug` \| `trace` |
| `KIRO_BRIDGE_TRACE` | off | `1` to log sanitised JSON-RPC frames |
| `KIRO_BRIDGE_TRACE_CONTENT` | off | `1` to include prompt text in traces. **Writes your prompts to disk** |
| `KIRO_BRIDGE_TRACE_FILE` | — | Also append traces to this file |

Kiro's own variables still work, and are useful for isolation while testing:

| Variable | Purpose |
|---|---|
| `KIRO_DATA_DIR` | Redirect Kiro's data dir away from `~/.kiro` |
| `KIRO_DISABLE_TELEMETRY` | Disable Kiro telemetry |

## Zed defaults for the selectors

Zed can preselect config options per agent, so a new thread starts how you like:

```json
{
  "agent_servers": {
    "Kiro": {
      "type": "custom",
      "command": "kiro-acp-bridge",
      "args": [],
      "default_config_options": {
        "model": "claude-opus-5",
        "effort": "max",
        "agent": "kiro_default"
      },
      "favorite_config_option_values": {
        "model": ["claude-opus-5", "gpt-5.6-sol"]
      }
    }
  }
}
```

`favorite_config_option_values` feeds Zed's "Cycle Favorite Models" action.

Values must be Kiro's raw ids (`claude-opus-5`, not `Claude Opus 5`). List them with:

```bash
kiro-cli chat --list-models --format json
```

## Remote and SSH projects

Zed runs agent servers on the **remote** host, so Kiro CLI and Node ≥ 22 must be
installed there and Kiro must be authenticated there. Set `KIRO_CLI_PATH` to the
remote path. The bridge itself needs no local presence.

## Verifying it works

1. Open the Agent Panel and select Kiro.
2. Confirm Agent, Model and Effort selectors are all visible.
3. Open the model picker — it should list your real Kiro models with credit
   multipliers as group headings.
4. Type `/` — Kiro's commands should appear, including your own skills.
5. Send a prompt, then switch model in the same thread and send another.

If any step fails, see [debugging.md](debugging.md). The full manual script is
[zed-acceptance-tests.md](zed-acceptance-tests.md).

## Running Kiro directly instead

For comparison, Zed can talk to Kiro without the bridge:

```json
{
  "agent_servers": {
    "Kiro (raw)": { "type": "custom", "command": "kiro-cli", "args": ["acp"] }
  }
}
```

Chat and tools work, but there will be no model, effort or agent selector and no
slash-command menu — which is the gap this project exists to close. Keeping both
configured side by side is a useful way to confirm the difference.
