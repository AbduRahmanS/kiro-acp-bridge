# Capability Matrix

Status as measured on Kiro CLI 2.21.0 (`--agent-engine v2`), ACP v1, Zed `main`.

Legend: ✅ works · ⚠️ works with a caveat · ❌ unavailable · — not applicable

## Core chat

| Feature | Kiro direct ACP | Via bridge | Zed UX |
|---|---|---|---|
| Streaming responses | ✅ | ✅ forwarded unbuffered | native |
| Tool calls | ✅ | ✅ + path defects corrected | native |
| Tool call diffs | ⚠️ wrong base directory | ✅ re-rooted on session cwd | native |
| Tool call file locations | ❌ relative paths (violates ACP) | ✅ absolutised | native |
| Permission requests | ✅ | ✅ forwarded unchanged | native |
| Cancellation | ✅ returns `cancelled` | ✅ | native |
| Images | ⚠️ per-model, advertised agent-wide | ⚠️ same limit, error surfaced | native |
| Session creation | ✅ | ✅ | native |

## Selectors — the headline fix

| Feature | Kiro direct ACP | Via bridge | Zed UX |
|---|---|---|---|
| Model selector | ❌ uses removed `session/set_model` | ✅ `configOptions` `category:model` | **native picker** |
| Model switch in-thread | ❌ | ✅ no restart, no new thread | native |
| Credit multiplier per model | ❌ | ✅ shown as option groups | native grouping |
| Reasoning effort selector | ❌ unreachable over ACP | ✅ `category:thought_level` | **native picker** + keybindings |
| Effort varies per model | ❌ | ✅ re-queried on every model change | native |
| Effort withdrawn for `auto` | — | ✅ option removed, user told | native |
| Agent selector | ⚠️ `set_mode` only, ignored by Zed | ✅ `category:mode` | **native picker** |
| Custom agents | ⚠️ present but unreachable | ✅ discovered dynamically | native |
| Plan mode | ⚠️ only as `/plan` text | ✅ agent option + `/plan` stays in sync | native |
| Legacy `sessionModes` mirror | ✅ | ✅ emitted for older clients | — |

## Slash commands

| Feature | Kiro direct ACP | Via bridge | Zed UX |
|---|---|---|---|
| Command discovery | ⚠️ `_kiro.dev` extension only | ✅ `available_commands_update` | native `/` menu |
| Command execution | ✅ via prompt text | ✅ | native |
| State-changing commands sync the UI | ❌ selectors go stale | ✅ `config_option_update` pushed | native |
| Terminal-only commands hidden | ❌ all exposed | ✅ 11 excluded | — |
| Argument autocomplete | ❌ | ❌ **blocked upstream** | see gaps |
| Subcommand hints | ⚠️ in Kiro metadata | ⚠️ sent as `input.hint` | ❌ Zed discards it |

## Skills

| Feature | Kiro direct ACP | Via bridge | Zed UX |
|---|---|---|---|
| Global skills (`~/.kiro/skills`) | ❌ not advertised | ✅ discovered | native commands |
| Workspace skills (`.kiro/skills`) | ❌ not advertised | ✅ discovered, shadow global | native commands |
| Skill execution | ✅ via prompt text | ✅ | native |
| Added/removed mid-session | ❌ | ✅ re-read on republish | native |

## Context and billing

| Feature | Kiro direct ACP | Via bridge | Zed UX |
|---|---|---|---|
| Context usage | ⚠️ percentage only | ✅ measured absolute tokens | native ring |
| Context window size | ❌ not in ACP output | ✅ from model metadata | native |
| Per-bucket breakdown | ⚠️ only via `/context` | ✅ shown in `/usage` | text |
| Credits balance | ⚠️ only via `/usage` | ✅ named as credits | text |
| Monetary cost | — | ✅ only for real overage | native |

## Sessions

| Feature | Kiro direct ACP | Via bridge | Zed UX |
|---|---|---|---|
| `session/list` | ❌ `-32601` | ✅ built on `_kiro.dev/session/list` | native history import |
| Session titles | ⚠️ in Kiro's store | ✅ passed through | native |
| `session/load` | ✅ | ✅ | native |
| `session/resume` | ❌ not advertised | ❌ not implemented | — |
| Clean shutdown | ✅ | ✅ escalating, no orphans | — |

## MCP

| Feature | Kiro direct ACP | Via bridge | Zed UX |
|---|---|---|---|
| Kiro-native MCP config | ✅ | ✅ untouched | — |
| Zed-forwarded servers | ✅ | ✅ de-duplicated by name | native |
| Startup status | ⚠️ extension only | ✅ failures reported in thread | text |
| OAuth | ⚠️ extension notification | ⚠️ → URL elicitation, **untested live** | native prompt |

## Authentication

| Feature | Kiro direct ACP | Via bridge | Zed UX |
|---|---|---|---|
| Uses existing signed-in CLI | ✅ | ✅ no credentials touched | — |
| `authMethods` advertised | ❌ `[]` | ✅ terminal method | native sign-in |
| In-editor sign-in | ❌ impossible | ✅ runs `kiro-cli login` | native |
| Auth failure signalled as `-32000` | ❌ opaque internal error | ✅ | native prompt |
| `initialize` survives missing Kiro | ❌ | ✅ degraded, still advertises auth | agent connects |

## Diagnostics

| Feature | Kiro direct ACP | Via bridge | Zed UX |
|---|---|---|---|
| stdout protocol purity | ✅ | ✅ console redirected to stderr | — |
| Sanitised JSON-RPC trace | ❌ | ✅ opt-in, 4 directions | `dev: open acp logs` |
| Secret redaction | — | ✅ | — |
| Actionable "not installed" error | ❌ bare failure | ✅ full guidance on stderr | agent panel |
| Kiro crash surfaced | ❌ silent | ✅ message in thread | native |

---

## Not implemented

| Feature | Why |
|---|---|
| **Argument autocomplete** | No mechanism exists. ACP v1 has no completion RPC; `AvailableCommandInput` offers only a static `hint`, and Zed discards even that. Needs an ACP protocol addition — a bridge cannot synthesise it. |
| **`/rewind` checkpoint picker** | `commands/execute {rewind}` returns a structured turn list, so a richer UI is *possible*, but ACP has no checkpoint-selection surface. `/rewind` works as a command; Kiro owns the semantics, as the brief requires. |
| **`/spawn` as parallel Zed threads** | Kiro spawns real parallel sessions (`_session/spawn` needs a `task`) and reports them via `_kiro.dev/subagent/list_update`, but ACP has no multi-session-per-thread concept. Faking it would misrepresent the semantics. `/spawn` remains available as a command. |
| **`session/resume`** | Kiro does not advertise the capability and `session/load` already covers reopening. |
| **Compaction / clear status** | `_kiro.dev/compaction/status` and `_kiro.dev/clear/status` are recognised and logged, but ACP's compaction updates are unstable-only, so there is no stable surface to map them to. |
| **v3 agent engine** | Broken for ACP: `session/new` fails and all `_kiro.dev/*` methods return a `PersistenceClassification` internal error. Pinned to v2. |
| **ACP Registry publication** | Unblocked. The Registry requires at least one `agent` or `terminal` auth method; Kiro returns `authMethods: []`, so the bridge adds an ACP Terminal Auth method that runs `kiro-cli login`. See [publishing.md](publishing.md). Remaining steps are npm publish and the PR. |

## Gaps by owner

**Zed should fix:** read `AvailableCommand.input.hint` and show it (it is already
sent); log unknown `session/update` variants instead of dropping them silently.

**Kiro should fix:** implement `session/set_config_option` so this bridge can retire
its main adapter; emit a notification when model/agent/effort changes (the absence of
this forces the bridge to mirror state); advertise `sessionCapabilities.list`, which
already works; report absolute tokens over ACP again (#9992); expose skills through
`commands/available`; return `authMethods` so Registry listing is possible; fix
relative `locations[].path` and the diff base directory; repair the v3 ACP surface.

**ACP should consider:** an argument-completion mechanism for slash commands, and a
non-currency usage quantity so abstract balances like credits have an honest home.
