# Architecture Decision

**Decision: Architecture A — a standalone ACP↔ACP bridge.** No Zed patch, no Kiro
fork, no Zed-specific extension.

```
Zed  ──standard ACP v1──▶  kiro-acp-bridge  ──legacy ACP + _kiro.dev/*──▶  kiro-cli acp
     ◀─────────────────                     ◀──────────────────────────
```

The bridge is an ACP **agent** northbound and an ACP **client** southbound, both in
one process, over two independent stdio streams.

---

## Alternatives considered

### B — modify or fork Kiro: **rejected on legal grounds**

Kiro CLI is licensed as "AWS Content" under the AWS Customer Agreement
([kiro.dev/license](https://kiro.dev/license/)). The `kirodotdev/Kiro` repository
explicitly states the product source is not hosted there, and Kiro ships as signed,
stripped native binaries. There is nothing to fork and no licence permitting
derivative works.

This is not a difficulty judgement — it is a hard blocker. Kiro's supported extension
seams (custom agents, skills, steering, hooks, powers, MCP) do not reach the ACP
protocol layer where the problem lives.

### C — Zed-specific integration: **rejected as unnecessary**

Zed already renders every surface required:

- `configOptions` with `mode` / `model` / `thought_level` categories, the last with
  dedicated "Change Thinking Effort" and "Cycle Thinking Effort" keybindings
- `usage_update` as a progress ring that warns at 85%
- form and URL elicitation, with URL mode calling `cx.open_url`
- `session/list` / `load` / `resume` / `delete` / `close`, capability-gated
- an ACP log viewer at `dev: open acp logs`

Nothing about Zed needed changing to reach the target UX. Building against a
Zed-specific API would also have coupled this project to one client, when the same
bridge now works for any ACP client.

### D — bridge plus targeted Zed patches: **not required for P0 or P1**

Only one genuine Zed gap surfaced, and it is cosmetic: Zed reads
`AvailableCommand.input` as a boolean and discards the `hint` string, so Kiro's
per-subcommand hints cannot be shown. That is worth an upstream contribution but
does not justify a fork, and the bridge behaves correctly without it.

### E — something else

Considered and rejected: a persistent daemon multiplexing several Zed windows onto
one Kiro process (adds cross-window state-leak risk for no user-visible gain), and
scraping Kiro's TUI output (the brief rightly forbids parsing human-readable output
when a structured API exists — and `commands/execute` returns structured `data`).

---

## Why this works: the mismatch is narrow and mechanical

Kiro and Zed are each internally consistent; they simply implement different
generations of the same protocol.

| Concern | Kiro 2.21.0 | Current Zed |
|---|---|---|
| Model selection | `session/set_model` + `models` in `session/new` | `session/set_config_option`, `category: "model"` |
| Mode selection | `session/set_mode` (mode ids are agent ids) | config options; `modes` ignored when they are present |
| Reasoning effort | only via `commands/execute {effort}` | config options, `category: "thought_level"` |
| Slash commands | `_kiro.dev/commands/available` | `available_commands_update` |
| Context usage | `_kiro.dev/metadata`, percentage only | `usage_update` with absolute `used`/`size` |
| Session list | `_kiro.dev/session/list` | standard `session/list` |

Every row is a mechanical translation. None requires inventing behaviour, and none
requires either side to change. That is what makes a bridge the right shape rather
than a workaround.

---

## Language and SDK: TypeScript with `@agentclientprotocol/sdk` 1.4.0

Chosen over Rust primarily because the bridge must be **both** an ACP agent and an
ACP client simultaneously, and the TypeScript SDK's `agent()` / `client()` builders
support exactly that in one process with independent streams. Two further reasons:
`npx` distribution needs no per-platform binaries and works over remote/SSH Zed
projects, and the two closest reference adapters (`claude-agent-acp`, `codex-acp`)
are both TypeScript, so their patterns transfer directly.

The Rust SDK would have given a faster cold start and single-binary distribution.
Measured bridge overhead is ~15 ms of process startup against Kiro's own ~1.5 s
handshake, so that trade was not worth the loss of `npx` reach.

Targeting **stable ACP v1**, not v2. Protocol v2 is at `2.0.0-alpha.3`, drops
`fs/*` and `terminal/*` from stable client methods and renames `authenticate`, and
current Zed negotiates v1. Building against v2 would produce a bridge Zed cannot
talk to.

---

## Two semantic decisions worth recording

### D1 — credits are never rendered as currency

ACP's `Cost` requires `{amount, currency}` with an ISO 4217 code. Kiro bills in
abstract **credits** (e.g. 1234.56 of 5000). Populating `cost` with a credit count would
make Zed display "1234.56 USD", which is false.

Kiro *does* separately report real money: `overageCharges` alongside
`currency: "USD"`, being genuine billable overage beyond the plan allowance.

The rule implemented is therefore:

- `usage_update.cost` is emitted **only** when `overageCharges > 0` and a currency is
  present.
- Credits are surfaced as text through `/usage`, with the unit named.
- `overageRate` (0.04 USD per credit) makes a conversion *possible*, and it is
  deliberately not done: plan allowance is prepaid, so consuming it incurs no charge
  and reporting one would be a fabrication.

### D2 — only state-changing slash commands are intercepted

Kiro's prompt path already interprets its own commands and skills: sending the text
`/context` returns Kiro's real command output without invoking a model. So the
default is to forward prompt text unchanged, which also means commands added by a
future Kiro release work with no code change.

The exception is commands that mutate selector state — `/model`, `/effort`,
`/agent`, `/plan`, `/guide`. Kiro emits **no notification** when the model or agent
changes, so if these were merely forwarded, Kiro would change while Zed's picker kept
showing the old value. These are executed through `commands/execute` (which returns
structured `data`) and followed by a `config_option_update` push.

---

## Consequences

**Good.** Zed needs no changes. Kiro needs no changes. Kiro stays the sole runtime
and the sole owner of sessions, permissions and credentials. The bridge holds no
credentials and stores no conversation data.

**The bridge should shrink over time.** Every translation is capability-detected
rather than version-gated, so when Kiro implements `session/set_config_option`
natively the bridge can prefer the standard path and delete the corresponding
adapter. `docs/compatibility.md` lists the specific signals to watch.

**Accepted costs.** One extra process in the chain (~15 ms). A second JSON-RPC hop
per message, with streaming forwarded unbuffered so first-token latency is unaffected.
And the bridge must mirror model/agent/effort state, because Kiro announces no
changes — mirrored state is a correctness risk that only disappears if Kiro starts
emitting notifications.
