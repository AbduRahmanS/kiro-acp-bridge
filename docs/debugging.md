# Debugging

## First checks

```bash
kiro-cli --version                              # Kiro installed and on PATH?
node --version                                  # must be >= 22
kiro-acp-bridge --version                       # bridge reachable?
kiro-cli chat --list-models --format json       # Kiro authenticated?
```

If the last command returns models, Kiro is signed in and the bridge will inherit that.

## Zed's ACP log

The fastest diagnostic. Command palette → `dev: open acp logs`.

Look for:

- `initialize` — does the response contain `agentCapabilities`?
- `session/new` — does the response contain a **`configOptions`** array? If not, the
  selectors cannot appear.
- `session/update` with `available_commands_update` — arrives shortly *after*
  `session/new`, not in the response.
- Stderr lines, shown with a warning icon. The bridge's diagnostics appear here.

## Bridge tracing

Off by default. Enable via the `env` block in Zed's agent config, or in a shell:

```bash
KIRO_BRIDGE_TRACE=1 \
KIRO_BRIDGE_TRACE_FILE=/tmp/kiro-bridge.log \
kiro-acp-bridge
```

Each frame is one line, tagged with direction:

```
2026-09-04T11:12:13.456Z [kiro-bridge] TRACE zed->bridge  request  session/prompt id=3 session=abc {…}
2026-09-04T11:12:13.470Z [kiro-bridge] TRACE bridge->kiro request  session/prompt id=7 session=abc {…}
2026-09-04T11:12:14.001Z [kiro-bridge] TRACE kiro->bridge notify   session/update    session=abc {…}
2026-09-04T11:12:14.003Z [kiro-bridge] TRACE bridge->zed  notify   session/update    session=abc {…}
```

Four directions let you localise a fault precisely: if a frame appears on
`zed->bridge` but not `bridge->kiro`, the bridge dropped it; if it appears on
`kiro->bridge` but not `bridge->zed`, the translation is at fault.

### Redaction

By design, traces are safe to share:

- Prompt and message text → `[content 412 chars]`
- Token/key/secret-bearing fields → `[redacted]`
- Base64 images → `[binary 3128 chars]`
- Long strings truncated, long arrays capped

To include prompt text — for reproducing a content-dependent bug only:

```bash
KIRO_BRIDGE_TRACE=1 KIRO_BRIDGE_TRACE_CONTENT=1 kiro-acp-bridge
```

**That writes your prompts to disk.** Secret redaction still applies, but review before
sharing.

## Log levels

```bash
KIRO_BRIDGE_LOG_LEVEL=debug kiro-acp-bridge
```

`error` · `warn` (default) · `info` · `debug` · `trace`.

`info` is usually the right level for setup problems: it reports which `kiro-cli` was
resolved and how, Kiro's advertised capabilities, session creation with the initial
model/agent/effort, and every config change.

Kiro's own stderr is forwarded at `debug`, tagged `[kiro-cli]` so it is never confused
with the bridge's own output.

## Common problems

### "Kiro CLI was not found"

The error lists every path searched. Usually Zed's minimal environment lacks your shell
PATH. Fix by setting the path explicitly:

```json
"env": { "KIRO_CLI_PATH": "/Users/you/.local/bin/kiro-cli" }
```

### No model / effort / agent selectors

1. Confirm the thread is using the bridge, not `kiro-cli acp` directly.
2. In the ACP log, check `session/new` for `configOptions`.
3. If `configOptions` is absent but `modes` is present, `refreshAll()` failed — run
   with `KIRO_BRIDGE_LOG_LEVEL=debug` and look for `commands/options` errors.

### Effort selector missing

Expected when the model is `auto`, which has no effort axis. The bridge posts a message
saying so. Switch to any other model and it returns.

### Selector shows the wrong value after a slash command

Should not happen — the bridge pushes `config_option_update` after every state-changing
command. If it does, look for `config option applied` or `command changed state` at
`info` level, and check for a `config_option_update` on `bridge->zed`.

### Slash commands missing

`available_commands_update` arrives as a notification shortly after `session/new`. If
absent, check `info` logs for `published available commands` with its counts. Zero Kiro
commands means `_kiro.dev/commands/available` never arrived from Kiro.

### A skill is missing

Skills come from `~/.kiro/skills/*/SKILL.md` and `<workspace>/.kiro/skills/*/SKILL.md`.
Each needs a `SKILL.md`; the directory name is used when frontmatter has no `name`.
Names must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` — a name with spaces is skipped with a
warning at `warn` level. Skills are re-read whenever the catalogue is republished, so
starting a new thread picks up changes.

### Images fail on one model but not another

Expected. Image support is per-model even though ACP advertises it per-agent. Claude
models handle images; some GPT variants do not. Kiro's error is surfaced rather than
hidden.

### Kiro crashed

The bridge posts `**Kiro CLI stopped unexpectedly**` into the thread with the exit code
and Kiro's last stderr. Start a new thread to reconnect. If this recurs, check for
Kiro's known ACP crash ([kiro#11068](https://github.com/kirodotdev/Kiro/issues/11068)).

### High CPU

Kiro issue [#10258](https://github.com/kirodotdev/Kiro/issues/10258): each
`kiro-cli-chat acp` session can busy-wait. Confirm whose process it is:

```bash
ps -Ao pid,ppid,%cpu,command | grep '[k]iro-cli'
```

If the parent is not a bridge or Zed process, it is an orphan from an earlier run. The
bridge reaps its own child on shutdown; a leftover from a hard kill can be removed by
pid.

## Isolating from your real Kiro data

Useful when testing, so nothing lands in `~/.kiro`:

```bash
KIRO_DATA_DIR=/tmp/kiro-probe/datadir \
KIRO_DISABLE_TELEMETRY=1 \
KIRO_DISABLE_SESSION_SEARCH_INDEX=1 \
kiro-acp-bridge
```

Authentication still works, because credentials live outside the data directory.

Note that writing to `~/.kiro/settings/mcp.json` or `~/.kiro/agents/` triggers Kiro's
file watcher, which reconciles and restarts MCP servers **inside running sessions** at
the next idle boundary. Avoid editing those while sessions are live.

## Reproducing outside Zed

The end-to-end scripts drive the built bridge through a simulated Zed, which is often
faster than reproducing in the editor:

```bash
npm run build
node scripts/e2e-spine.mjs      # streaming, tools, permissions, paths, cancel
node scripts/e2e-config.mjs     # selectors
node scripts/e2e-commands.mjs   # slash commands, skills, state sync
node scripts/e2e-usage.mjs      # usage, credits, session list
node scripts/e2e-failures.mjs   # failure paths, redaction, crash, images
```

Each prints PASS/FAIL per assertion and exits non-zero on failure.

## Filing a bug

Include: bridge `--version`, `kiro-cli --version`, Zed version, OS/arch, the relevant
section of a `KIRO_BRIDGE_TRACE=1` log (safe to share — content is redacted), and what
Zed's ACP log showed for `session/new`.
