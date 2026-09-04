# Safety & Isolation Plan

**Context:** the developer machine has **live Kiro CLI sessions in active use**, including two
`kiro-cli acp` process trees owned by a running Zed instance. Every step of this project must be
provably non-interfering. This document is the contract; it was written **before** any probing began.

## 1. Baseline captured at session start

Recorded before any action, so interference can be disproven afterwards.

### Live process baseline (27 Kiro processes)

| PID | PPID | Elapsed | What it is |
|---|---|---|---|
| 48596 | 1 | — | **`/Applications/Zed.app/Contents/MacOS/zed`** — owns the ACP trees below |
| 32000 → 32024 | 48596 | 1h15m | `kiro-cli acp` → `kiro-cli-chat acp` (**Zed ACP thread #1**) |
| 64195 → 64440 | 48596 | 14h49m | `kiro-cli acp` → `kiro-cli-chat acp` (**Zed ACP thread #2**) |
| 39674, 41684, 66731 | various | 19m–14h39m | KAS `acp-server.js --transport=stdio --auth=acp-callback` |
| 39636, 41640, 66696 | various | 14m–14h39m | `kiro-cli --v3` interactive TUI chats |
| 79385 | 1 | 2d02h | `kiro_cli_desktop` |
| 9× `zsh (kiro-cli-term)` | — | — | terminal host shells |

**Consequence:** Zed is *already* an ACP client of Kiro on this machine. Both live ACP trees are
in-scope for damage and out-of-scope for touching.

### Mutable-state baseline

```
~/.kiro/settings/cli.json   mtime=2026-09-01T11:52:56  size=111
                            sha256=e125234cead5c1a36ec52e7ce951ca68587b0123f041398bfd199c9fd5d057ee
~/.kiro/settings/mcp.json   ABSENT   (must remain absent)
~/.kiro/sessions/cli/       98 entries
~/.kiro/sessions/           18 workspace-hash dirs
```

These are re-verified at the end of every work phase.

## 2. The four concrete interference risks

Each is a real mechanism confirmed during research, not a hypothetical.

| # | Risk | Mechanism | Mitigation |
|---|---|---|---|
| R1 | **Changing the model/effort of live sessions** | `/model` and `/effort` auto-persist to `~/.kiro/settings/cli.json`. Executing them in a probe would rewrite shared global state. | Never invoke mutating slash commands against the real data dir. Probe with `KIRO_DATA_DIR` redirected. Verify `cli.json` sha256 unchanged after every phase. |
| R2 | **MCP/agent hot-reload storm** | A file watcher on `.kiro/agents` and `mcp.json` reconciles and **restarts changed MCP servers at the next idle boundary between turns** — i.e. it would reach into live sessions. | Zero writes to `~/.kiro/agents/`, `~/.kiro/settings/mcp.json`, or any workspace `.kiro/` outside this repo. `mcp.json` is absent and stays absent. |
| R3 | **Killing the user's processes** | `pkill kiro`, `killall`, `kill %1` would destroy Zed's two ACP trees and 4 TUI chats. | **`pkill`/`killall` are banned outright for this project.** Only PIDs captured from processes this project spawned are ever signalled, and only after confirming `ppid == our shell`. |
| R4 | **Orphaned probe processes / CPU burn** | Kiro issue #10258: each `kiro-cli-chat acp` session busy-waits at ~250% CPU. Issue #10666: a session-ownership lock survives owner death and then makes `session/load` refuse with a dead PID. | Every probe is spawned under `timeout`, tracked by PID, drained via stdin EOF → SIGTERM → SIGKILL escalation, and reaped in a `trap`. Post-phase process count must return to the 27-process baseline. |

## 3. Isolation mechanism (validated, not assumed)

Extracted from the shipped binary's string table and then verified empirically:

| Env var | Purpose | Status |
|---|---|---|
| `KIRO_DATA_DIR` | redirects Kiro's data dir away from `~/.kiro` | **validated** — `KIRO_DATA_DIR=/tmp/kiro-probe/datadir kiro-cli chat --list-models --format json` returned the real model list, so **auth survives redirection** (credentials are held outside the data dir, in the macOS keychain). No stray files were created. |
| `KIRO_HOME` | alternate home root | available, unused unless needed |
| `KIRO_ACP_RECORD_PATH` | **Kiro's own built-in ACP recorder** | to be used for capturing protocol fixtures — a first-party facility, far safer than tampering |
| `KIRO_DISABLE_SESSION_SEARCH_INDEX` | stops session-index writes | set in all probes |
| `KIRO_DISABLE_TELEMETRY=1` | no telemetry from probes | set in all probes |
| `KIRO_LOG_LEVEL`, `KIRO_CHAT_LOG_FILE` | redirect logs to the probe dir | set in all probes |

Standard probe preamble:

```sh
export KIRO_DATA_DIR=/tmp/kiro-probe/datadir
export KIRO_DISABLE_TELEMETRY=1
export KIRO_DISABLE_SESSION_SEARCH_INDEX=1
export KIRO_CHAT_LOG_FILE=/tmp/kiro-probe/logs/probe.log
```

## 4. Rules of engagement

**Never:**
- `pkill` / `killall` / `kill` any PID not spawned by this project
- write to `~/.kiro/settings/`, `~/.kiro/agents/`, `~/.kiro/skills/`, `~/.kiro/sessions/`
- create `~/.kiro/settings/mcp.json`
- run `/logdump`, `/checkpoint`, `/rewind`, `/clear`, `/compact`, `kiro-cli settings <k> <v>`, or `chat --delete-session`
- run `kiro-cli acp` bare against the real data dir
- attach to, signal, or read the stdio of PIDs 32000/32024/64195/64440 or any KAS server

**Always:**
- confine writes to `/Users/abdurahman/Codes/kiro-zed-acp` and `/tmp/kiro-probe`
- run probes under `timeout` with explicit PID capture and a reaping `trap`
- re-verify the `cli.json` sha256 and the process count after each phase
- prefer read-only introspection (`--help`, `--list-models`, `--list-sessions`) over live sessions
- keep credit spend near zero: exercise `initialize` / `session/new` / config handshakes, which do
  not invoke a model. Real `session/prompt` calls are used sparingly and only with a cheap model
  (`gpt-5.6-luna`, 0.1× multiplier) once the wire shape is already understood.

## 5. Verification checkpoints

After each phase:

```sh
shasum -a 256 ~/.kiro/settings/cli.json    # must equal the baseline hash
test ! -f ~/.kiro/settings/mcp.json        # must still be absent
ps -Ao pid,command | grep -c '[k]iro'      # must return to 27
ps -p 32000,32024,64195,64440              # all four must still be alive
```

A failure of any checkpoint halts work and is reported immediately rather than worked around.


---

# Post-hoc correction — `KIRO_DATA_DIR` does not isolate session storage

**A claim made in §3 of this document turned out to be wrong, and is corrected here
rather than quietly edited out.**

§3 recorded `KIRO_DATA_DIR` as "validated" for isolation. That validation was too weak:
it only confirmed that `kiro-cli chat --list-models` still authenticated and wrote no
stray files. It did **not** test whether session writes were redirected — and they are
not.

## What was actually measured afterwards

```
session logs (*.jsonl) in every isolated datadir : 0
new files in ~/.kiro/sessions/cli during the work: 51
sessions attributable to test cwds under /tmp     : 25
```

Kiro honours `KIRO_DATA_DIR` for some purposes but its session store ignores it. Every
probe and end-to-end run therefore wrote its session into the **real**
`~/.kiro/sessions/cli`.

## Actual impact

| Risk from §2 | Outcome |
|---|---|
| R1 — changing model/effort of live sessions | **Did not occur.** `~/.kiro/settings/cli.json` sha256 is byte-identical to the baseline (`e125234c…`), so no global setting was mutated. |
| R2 — MCP/agent hot-reload storm | **Did not occur.** `~/.kiro/settings/mcp.json` is still absent; nothing under `~/.kiro/agents/` was written. |
| R3 — killing the user's processes | **Did not occur.** `pkill`/`killall` were never invoked; only PIDs obtained from `pgrep -P <our own bridge pid>` or captured at spawn were ever signalled. |
| R4 — orphaned probe processes | **Did not occur.** Every run asserted its child was reaped; final process count returned below baseline. |
| *Unanticipated* — session-store pollution | **Occurred.** 25 throwaway sessions were added to the user's session list. |

The pollution is **additive only**: files were created, none modified or deleted, and no
existing session was touched. The consequence is clutter in `/chat resume` and
`--list-sessions`, not data loss.

## Why the mitigation still mostly worked

The two genuinely dangerous risks — mutating shared settings and triggering the MCP
file-watcher inside live sessions — were avoided by *not performing those operations at
all*, not by the environment variable. Choosing never to run `/model`, `/effort`,
`kiro-cli settings`, or to write MCP/agent config was the effective control. The env var
added nothing.

## Lesson

"Validated" should have meant "observed the specific write I care about landing
elsewhere", not "the command still worked and made no visible mess". A negative
observation on one code path is not evidence about a different code path.

## Cleanup

The 25 stray sessions are identifiable by cwd:

```
/private/tmp/kiro-bridge-fail/ws     11
/private/tmp/kiro-bridge-e2e/ws       6
/private/tmp/kiro-bridge-cmds/ws      3
/private/tmp/kiro-bridge-config/ws    2
/private/tmp/kiro-bridge-usage/ws     2
/private/tmp/kiro-probe/ws            1
```

They can be removed with `kiro-cli chat --delete-session <id>`. Because deletion is
irreversible, this is left for the user to approve rather than done unilaterally.
