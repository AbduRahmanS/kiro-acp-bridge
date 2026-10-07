# Compatibility

## Verified

| Component | Version | Notes |
|---|---|---|
| Kiro CLI | 2.28.0 | engine **v2** (default) and **CLI V3** (`KIRO_BRIDGE_AGENT_ENGINE=v3` or `auto`) |
| ACP protocol | 1 | stable schema line |
| ACP TS SDK | 1.7.0 | pinned exactly |
| Node.js | 22.22.3 | `>= 22` required |
| Zed | `main` @ `28e52a2` | source-inspected |
| Platform | macOS arm64 | Linux paths implemented, untested; Windows paths implemented, untested |

## Design principles

The bridge is built to survive Kiro changing underneath it.

**1. Capability detection over version checks.** Nothing branches on a Kiro version
string. The bridge reads what `initialize` advertises and what methods actually answer.
A Kiro release that adds a capability is picked up without code changes.

**2. Dynamic discovery over hardcoded lists.** Models, agents, effort levels, commands
and skills are all discovered at runtime. There is no model table anywhere — a new Kiro
model appears in the picker on the day it ships, with a label generated from its id and
its credit multiplier read from Kiro. The one place with tabulated knowledge
(`labels.ts`) holds only orthography: acronym casing such as `gpt → GPT`, and the
`kiro_` prefix that every built-in agent carries.

**3. Standard ACP over custom behaviour.** The northbound face uses only stable ACP v1.
No `_kiro.dev/*` method or vendor `_meta` leaks toward Zed.

**4. Graceful degradation.** Every enrichment step is individually fault-tolerant. If
`commands/options{model}` fails, the seed data from `session/new` is still used. If
`/context` fails, no `usage_update` is emitted rather than a wrong one. A failed slash-
command interception falls through to Kiro's prompt path so the user's input is never
lost.

**5. Unknown things are logged, not dropped.** Unrecognised `_kiro.dev/*` notifications
are logged at `debug` with their method name, so a new Kiro release is visible in
diagnostics instead of silently ignored.

**6. Structured APIs over parsed output.** The bridge never scrapes human-readable text.
`commands/execute` returns structured `data`, and that is what is consumed. The single
exception is skill discovery, which reads `SKILL.md` files — justified because Kiro
exposes no API for skills at all, so the alternative is that skills are unreachable.

## Retirement triggers

The bridge should get **smaller** as Kiro modernises. Each row below is a signal to
delete code, not add it.

| When Kiro… | Do this |
|---|---|
| implements `session/set_config_option` | Detect it at `initialize`, prefer the native path, retire `config.ts`'s translation. This is the single biggest simplification available. |
| emits a notification on model/agent change | Stop mirroring state in `session.ts`; react to Kiro instead. Removes the whole stale-state hazard. |
| advertises `sessionCapabilities.list` | Forward `session/list` instead of implementing it on `_kiro.dev/session/list`. |
| publishes skills via `commands/available` | Delete `skills.ts` entirely and stop touching the filesystem. |
| reports absolute tokens over ACP ([#9992](https://github.com/kirodotdev/Kiro/issues/9992)) | Forward `usage_update` directly; drop the `/context` summation in `usage.ts`. |
| fixes relative `locations[].path` | Simplify `paths.ts` case 1. |
| fixes the diff base directory | Simplify `paths.ts` case 2. |
| returns non-empty `authMethods` | ACP Registry publication becomes possible. |
| makes the v3 engine's ACP surface work | **Met on 2.28** (V3 adapter added, opt-in). Make V3 the default once it reports token counts. |
| V3 becomes the only engine | Delete `config.ts`'s v2 translation, `skills.ts`, the `_kiro.dev/*` dialect in `protocol.ts`. |

Correspondingly, if **Zed** starts reading `AvailableCommand.input.hint`, subcommand
hints become visible with no bridge change — the hints are already sent.

## Known-fragile assumptions

Honest list of what could break, and how it would show up.

| Assumption | Risk if it changes | Detection |
|---|---|---|
| `commands/execute` uses the adjacent tag `{command, args}` | Requests rejected with a serde parse error | State-changing commands fail; error visible at `warn`, and the prompt falls through to Kiro so nothing is lost |
| `commands/options` accepts a bare string enum | Option discovery fails | Selectors fall back to `session/new` seed data; effort disappears |
| The `[active]` marker identifies the current value | Wrong value shown as selected | Mitigated already: command `data` blocks take precedence |
| `/context` bucket names and `tokens` fields | Usage reporting stops | `usage_update` is withheld rather than wrong |
| `/usage` `resourceType: "CREDIT"` | Credit summary stops | `/usage` falls back to "no usage information" |
| Kiro's mode ids are agent ids | Agent switching breaks | `set_mode` returns an error, surfaced as `-32602` |
| Kiro accepts `--agent-engine v2` | Startup fails | Actionable stderr message |

Each of these degrades to "feature unavailable" rather than "bridge broken" — that was
the design intent, and the failure paths are exercised in `e2e-failures.mjs`.

## Kiro engine versions

The bridge has two southbound adapters, chosen per connection from what Kiro's
`initialize` advertises (`agentCapabilities._meta.kiro.extensionMethods` marks CLI V3;
both generations negotiate ACP protocol 1, so the protocol version cannot tell them apart).

| `KIRO_BRIDGE_AGENT_ENGINE` | Behaviour |
|---|---|
| unset / `v2` | v2 engine (default) |
| `v3` | CLI V3 engine, launched with `--auth-method=cli` |
| `auto` | V3 first; v2 if V3 cannot start (older kiro-cli). A signed-out V3 is **not** a fallback reason — it surfaces as "authentication required". |

The first engine that starts is locked in for the bridge's lifetime, so a restart never
changes the dialect under existing threads.

**Why v2 stays the default.** V3 works on 2.28, but moving users silently would lose:
absolute token counts (V3 reports a percentage only, so Zed's context ring has no data),
and v2 commands with no V3 route (`/tools`, `/hooks`, `/rewind`, `/knowledge`, `/chat`,
`/prompts`). V3 is also still early access. Flip the default when V3 reports a context
window or token counts.

### What the V3 adapter does

Zed sees the same option ids (`agent`, `model`, `effort`) and command names on both engines.

| Concern | V3 behaviour (measured on 2.28) | Bridge handling |
|---|---|---|
| Config options | native `configOptions` + `session/set_config_option` | passed through; `mode`/`effortLevel` renamed to `agent`/`effort` by category; other options (`autopilot`, `memoryReflection`, …) passed through |
| Unknown model | **accepted**, session then has no usable model | rejected with `-32602` before reaching Kiro |
| Unknown effort | silently ignored | rejected with `-32602` |
| `autopilot` | defaults to `on` (no tool confirmations) | set to `off` on new sessions; override with Zed's `default_config_options` |
| Effort across model switch | reset to the new model's default | a user-chosen level is re-applied when supported |
| `session/load` with history | response omits the model option; it follows ~75 ms later as `config_option_update` | adopted in order; a stale response never overwrites a newer notification |
| Slash commands | `_kiro.dev/commands/*` removed; only steering/subagents advertised | `/model /agent /effort /plan /context /compact /usage /mcp /help` routed per Kiro's migration guide |
| Context usage | `session_info_update` `context_usage` (percentage; bucket token counts are stale) | shown in `/context` and `/usage` as percentages; no `usage_update` |
| MCP | full `_kiro/mcp/status` snapshots | each failure reported once; OAuth URLs offered via URL elicitation |
| `_kiro/openExternalUrl` | requested only if the client opts in | opted in; turned into a URL elicitation |
| Auth methods | `aws-builder-id`, `aws-iam-identity-center` | not forwarded: with CLI-owned auth a signed-out V3 exits before it can answer `authenticate`; the terminal `kiro-cli login` method is offered instead |

`v2` limitations kept: no `session/delete` (not advertised); `session/close` only frees bridge state.

## New models

Kiro's model roster is server-side (it changed from 6 to 21 to 3 models during one
afternoon of testing) and loaded once per Kiro process. Zed keeps one agent process for
all threads, so a newly released model stays hidden until Kiro restarts. The bridge
compares the running Kiro's list with `kiro-cli chat --list-models` (read-only, ~4–7 s,
creates no files; a failed check is ignored) at most every
`KIRO_BRIDGE_MODEL_CHECK_MINUTES` (default 10), triggered after a turn. On a change it
reloads Kiro before the next `session/new` if no turn is running, and posts a one-time
note in open threads. `/restart-kiro`
restarts only the Kiro child and re-attaches the thread (`session/load`, transcript replay
suppressed), so the picker updates without restarting Zed. It refuses while another
thread has a turn running.

## ACP protocol versions

Targeting **v1 stable** deliberately. Protocol v2 is at `2.0.0-alpha.3`; it removes
`fs/*` and `terminal/*` from stable client methods, renames `authenticate` → `auth/login`,
and drops the `tool_call` and `current_mode_update` session-update variants. Current Zed
negotiates v1, so building against v2 would produce a bridge Zed cannot talk to.

The SDK is pinned exactly (`1.7.0`) rather than with a caret range, because ACP is
evolving quickly and a silent minor bump could change wire behaviour. Upgrades should be
deliberate: bump, run the unit suite, then run all five end-to-end scripts.

## Platform support

| Platform | Status |
|---|---|
| macOS arm64 | verified |
| macOS x86_64 | expected to work; same discovery paths |
| Linux | discovery paths implemented (`~/.local/bin`, `/usr/local/bin`, `/opt/kiro-cli/bin`); untested |
| Windows | discovery implemented (`.exe`/`.cmd`, `LOCALAPPDATA`, `ProgramFiles`); untested, and Kiro's own Windows support is unconfirmed |
| Remote / SSH Zed | should work — Zed runs agent servers remotely, so Kiro and Node must be installed there |
