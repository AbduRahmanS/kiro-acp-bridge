# Final Report

## Architecture

A standalone ACP↔ACP bridge, in TypeScript, on `@agentclientprotocol/sdk` 1.4.0.

```
Zed  ──standard ACP v1──▶  kiro-acp-bridge  ──legacy ACP + _kiro.dev/*──▶  kiro-cli acp
```

One process, two ACP connections over independent stdio streams: an ACP **agent**
northbound, an ACP **client** southbound. ~4,400 lines of source across 13 modules,
186 unit tests, 5 end-to-end suites.

The reason a bridge is the right shape is that the mismatch turned out to be narrow and
purely mechanical. Kiro and Zed are each internally consistent — they implement
different generations of the same protocol. Six translations cover the whole gap:

| Concern | Kiro 2.21.0 | Current Zed | Bridge does |
|---|---|---|---|
| Model | `session/set_model` | `set_config_option` `category:model` | translate |
| Agent/mode | `session/set_mode` | `set_config_option` `category:mode` | translate |
| Effort | `commands/execute {effort}` | `set_config_option` `category:thought_level` | translate |
| Commands | `_kiro.dev/commands/available` | `available_commands_update` | translate |
| Usage | `_kiro.dev/metadata` (%) | `usage_update` (absolute) | measure and translate |
| Sessions | `_kiro.dev/session/list` | `session/list` | implement standard on top |

**Zed needed no changes. Kiro needed no changes.**

---

## Where the brief's assumptions were wrong

The brief asked to be challenged. Seven of its premises did not survive contact with
the running systems.

**1. The hypothesised architecture was right, but for the wrong reason.** The brief
framed this as Kiro lacking features. It is the opposite: Kiro implements model
selection perfectly well, via `session/set_model`. **Zed deleted that API**
([zed#58308](https://github.com/zed-industries/zed/pull/58308)) in favour of session
config options, and Kiro has not migrated. The bridge is a *generational* adapter, not
a feature-filling one.

**2. `session/set_model` is not a standard ACP method.** The brief lists it among the
methods to investigate. It does not exist in ACP v1 stable, v1 unstable, v2 stable or
v2 unstable. It is a removed unstable API. There is no dedicated model API to wait for —
config options *are* the mechanism.

**3. Kiro has no separate mode system.** The brief asks to "not collapse model and agent
into one selector" and to distinguish agents from modes. Agents and modes are the *same
axis* in Kiro: `session/new` returns agents in the `modes` field, and `session/set_mode`
takes an agent id. Only Model and Effort are genuinely independent. The desired mental
model is therefore `Agent(=Mode) ≠ Model ≠ Effort`.

**4. Plan is an agent, not a mode.** `/plan` replies `"Agent changed to kiro_planner"`.
`session/set_mode` with `"plan"` fails outright.

**5. Kiro does not expose skills over ACP at all.** The brief says "Kiro already
exposes them through command availability" and warns against a second discovery
mechanism. With 13 global skills installed, `commands/available` listed only the 25
built-in commands. Skills *execute* fine as prompt text but are entirely absent from
discovery, so the bridge must read `SKILL.md` files. This is the one place the project
parses Kiro config from disk, and it is unavoidable.

**6. `_kiro.dev/commands/options` is not per-command.** The brief implies endpoints like
`_kiro.dev/commands/model/options`. Kiro *advertises* those as `optionsMethod` values but
they return `-32601`. There is one endpoint taking a string enum. Similarly
`_session/terminate`, which the brief lists, does not exist in 2.21.0 v2.

**7. Argument autocomplete is impossible, not merely hard.** The brief asks whether a
bridge-only solution exists. It does not: ACP v1 has no completion RPC,
`AvailableCommandInput` offers only a static `hint`, and Zed reads `input` as a boolean
while discarding the hint. This needs a protocol addition.

One further discovery the brief could not have anticipated: **Kiro's tool-call diff paths
change shape depending on whether the client implements `fs/write_text_file`** — process
cwd when stubbed, symlink-resolved session cwd when implemented. Both mislead Zed.

---

## Supported features

Full matrix in [capability-matrix.md](capability-matrix.md). Headlines:

| Feature | Status | Verified by |
|---|---|---|
| Native model selector, dynamic | ✅ | Test A |
| In-thread model switching, no restart | ✅ | Test A |
| Credit multiplier per model | ✅ | `e2e-config` |
| Native effort selector, **per model** | ✅ | Test B |
| Effort withdrawn where absent (`auto`) | ✅ | Test B |
| Native agent selector incl. custom agents | ✅ | Tests C, F |
| Plan mode, with `/plan` keeping the UI in sync | ✅ | Test C |
| Slash commands, dynamic | ✅ | Test D |
| Skills as slash commands | ✅ | Test E |
| Streaming, tools, permissions, cancellation | ✅ | Tests G, H |
| Images | ✅ per-model | Test J |
| Context usage from measured tokens | ✅ | `e2e-usage` |
| Credits reported honestly | ✅ | `e2e-usage` |
| `session/list` on Kiro's own store | ✅ | `e2e-usage` |
| Path defects corrected | ✅ | `e2e-spine` |
| Sanitised tracing with redaction | ✅ | `e2e-failures` |
| Crash reporting, clean teardown | ✅ | `e2e-failures` |

The per-model effort result is the one worth restating, because it validates the
brief's central design worry:

| Model | Valid effort levels |
|---|---|
| claude-opus-5 | low, medium, high, xhigh, max |
| gpt-5.6-sol | **none**, low, medium, high, xhigh, max |
| auto | **none at all** |

A static matrix would have been wrong in both directions.

---

## Unsupported, with reasons

| Feature | Why not |
|---|---|
| **Slash-command argument autocomplete** | No mechanism exists at any layer. ACP v1 has no completion RPC; Zed discards the hint it is already sent. Requires a protocol addition. |
| **`/rewind` checkpoint picker** | `commands/execute {rewind}` returns a structured turn list, so a UI is *possible*, but ACP has no checkpoint-selection surface. Works as a command; Kiro owns the semantics, per the brief's instruction not to build our own rollback. |
| **`/spawn` as parallel Zed threads** | Kiro spawns real parallel sessions and reports them via `_kiro.dev/subagent/list_update`, but ACP has no multi-session-per-thread concept. Faking it would misrepresent the semantics. Works as a command. |
| **`session/resume`** | Kiro does not advertise the capability; `session/load` covers reopening. |
| **Compaction / clear status** | Recognised and logged, but ACP's compaction updates are unstable-only, so there is no stable target. |
| **v3 agent engine** | Its ACP surface is broken — `session/new` fails and every `_kiro.dev/*` method returns a `PersistenceClassification` internal error. Pinned to v2. |
| **ACP Registry publication** | **Now unblocked.** The Registry requires an `agent` or `terminal` auth method; Kiro returns `[]` when signed in and may be absent entirely on a CI runner; the bridge adds ACP Terminal Auth backed by `kiro-cli login`. Remaining work is npm publish plus the PR — see [publishing.md](publishing.md). |
| **Terminal-only commands** | 11 excluded (`/quit`, `/paste`, `/voice`, `/reply`, `/editor`, `/theme`, `/copy`, `/transcript`, `/clear`…). Zed does each better natively. Functional parity, not TUI emulation. |

---

## Gaps by owner

### Zed

- **Read `AvailableCommand.input.hint`.** It is already sent; Zed reduces `input` to a
  boolean and discards the text. Subcommand hints would appear with no bridge change.
- **Log unknown `session/update` variants.** `handle_session_update` has a silent
  `_ => {}`, which makes new agent-side features invisible when debugging.
- Minor: unknown `PermissionOptionKind` values render as reject-always styling.

### Kiro

Ordered by how much they would simplify this bridge:

1. **Implement `session/set_config_option`.** Retires the largest adapter here and fixes
   Zed compatibility at source ([#10034](https://github.com/kirodotdev/Kiro/issues/10034)).
2. **Emit a notification on model/agent/effort change.** Their absence forces the bridge
   to mirror state, which is the only real correctness risk in the design.
3. **Advertise `sessionCapabilities.list`** — `_kiro.dev/session/list` already works.
4. **Publish skills through `commands/available`** — they execute but are undiscoverable.
5. **Report absolute tokens over ACP** ([#9992](https://github.com/kirodotdev/Kiro/issues/9992)).
6. **Fix `locations[].path`** — relative paths violate ACP's absolute-path rule.
7. **Fix the diff base directory** — it should follow session cwd, not process cwd.
8. **Return `authMethods`** so Registry listing becomes possible.
9. **Repair the v3 ACP surface** ([#10761](https://github.com/kirodotdev/Kiro/issues/10761),
   [#10877](https://github.com/kirodotdev/Kiro/issues/10877)).
10. Make the `[active]` marker in `commands/options` update immediately.

### ACP

- **An argument-completion mechanism** for slash commands. Several agents have rich
  argument metadata with nowhere to put it.
- **A non-currency usage quantity.** `Cost` requires ISO 4217, so abstract balances like
  Kiro credits have no honest home. This forced credits into message text.

---

## Tests

### Automated — 186 unit tests, all passing

| Suite | Tests | Covers |
|---|---|---|
| `config` | 33 | model/effort/agent translation, effort invalidation, invalid values |
| `commands` | 39 | parsing, catalogue, exclusions, dispatch planning |
| `paths` | 27 | both Kiro path defects, against captured payloads |
| `usage` | 27 | token summation, credit semantics, cost suppression |
| `skills` | 21 | frontmatter, scope precedence, malformed input |
| `mcp` | 18 | de-duplication, OAuth elicitation, status |
| `logging` | 13 | redaction, trace gating |
| `discovery` | 8 | executable resolution, actionable errors |

Fixtures are captured from real Kiro traffic — including the per-model effort matrix and
the exact defective `tool_call` payload — so no credits are spent and no Kiro process is
needed. Credit balances in fixtures are scrubbed.

### End-to-end against real Kiro — all passing

| Script | Result |
|---|---|
| `e2e-spine.mjs` | 24/24 — streaming, tools, permissions, path correction, cancellation, no orphans |
| `e2e-config.mjs` | 40/40 — Tests A, B, C, F |
| `e2e-commands.mjs` | all — Tests D, E, state sync |
| `e2e-usage.mjs` | all — usage, credits, session list |
| `e2e-failures.mjs` | all — failure paths, redaction, crash recovery, images |

These drive the **built** bridge through a simulated Zed advertising the same
capabilities current Zed does, so they exercise the real northbound protocol rather than
internal APIs.

### Bugs found by testing, and fixed

1. **Discovery hijacked by Kiro's own env var.** `KIRO_CHAT_CLI_BIN` is exported inside
   every Kiro CLI session; honouring it as an override resolved to an internal binary.
   Now only `KIRO_CLI_PATH` overrides.
2. **Stale `[active]` marker.** `/plan` succeeded but the UI showed the old agent,
   because `commands/options` lags. Fixed by treating the command's own `data` block as
   authoritative.
3. **`require` in an ESM module.** `KIRO_BRIDGE_TRACE_FILE` threw instead of writing.
   Fixed with a static import plus non-fatal error handling.
4. **"Kiro not found" never reached stderr.** Because Kiro spawns lazily, the guidance
   was buried in a JSON-RPC payload — invisible in Zed's ACP log. Now written to stderr
   explicitly.
5. **Symlink-spelled diff paths.** `/private/tmp` vs `/tmp` would break Zed's
   file-to-project association. Now canonicalised to the spelling Zed supplied.
6. **Over-aggressive redaction** hid `agentCapabilities.auth`, a capability object.

### Honestly not verified

| Area | Why |
|---|---|
| **MCP OAuth end-to-end** | No OAuth-requiring MCP server available. Code path implemented and unit-tested; live flow unexercised. |
| **MCP de-duplication live** | No `~/.kiro/settings/mcp.json` on the test machine, so no collision to observe. |
| **Zed's thread-import UI** | `session/list` verified; Zed's import button not driven automatically. |
| **Linux / Windows** | Discovery paths implemented, never executed there. |
| **Remote / SSH Zed** | Requires a second host. |
| **`session/load` replay** | Handler exists; not exercised end-to-end. |

One behavioural inconsistency worth recording: `gpt-5.6-luna` rejected an image with
`-32603 "Improperly formed request"` in early probing, but on a later run the same
request completed normally. Image support appears per-model and not perfectly
deterministic. The bridge surfaces whatever Kiro returns rather than masking it.

---

## Installation

```bash
npm install -g kiro-acp-bridge
```

Zed `settings.json`:

```json
{
  "agent_servers": {
    "Kiro": { "type": "custom", "command": "kiro-acp-bridge", "args": [], "env": {} }
  }
}
```

If Kiro is not on Zed's PATH — common, since Zed uses a minimal environment — add
`"env": { "KIRO_CLI_PATH": "/Users/you/.local/bin/kiro-cli" }`.

Requires Node ≥ 22 and an authenticated Kiro CLI. Full guide:
[zed-setup.md](zed-setup.md).

**Published.** `kiro-acp-bridge@0.1.0` is live on npm and verified by installing it
from the registry into a clean directory and driving the installed binary through a
full ACP handshake against a live `kiro-cli`.

**ACP Registry PR:** [agentclientprotocol/registry#575](https://github.com/agentclientprotocol/registry/pull/575).
Their `build_registry.py` accepts the entry locally (`Added agent: kiro-acp-bridge
v0.1.0`). Listing was initially blocked because the Registry requires at least one
`agent` or `terminal` auth method and Kiro returns `authMethods: []` when signed in; resolved by
advertising ACP **Terminal Auth** backed by `kiro-cli login`, which is not a
workaround but an accurate description of how Kiro authentication works — and it
makes signing in reachable from inside an editor for the first time.

`npm run verify:registry` reproduces the Registry's checks locally, including the
case where `kiro-cli` is absent, as it will be on their runner. Steps and the
non-obvious npm 2FA constraints are documented in [publishing.md](publishing.md).

---

## Future work

**Should do next**

1. Verify MCP OAuth against a real OAuth MCP server — the largest untested path.
2. Run the suite on Linux; add CI across macOS and Linux.
3. Publish to npm after 1 and 2.

**Worth doing**

4. Retire translations as Kiro modernises — see the trigger table in
   [compatibility.md](compatibility.md). Success looks like this codebase shrinking.
5. Contribute the `input.hint` fix to Zed; it is small and generic.
6. Propose argument completion to ACP, and a non-currency usage quantity.
7. Consider whether `/rewind`'s structured turn list justifies a richer surface once ACP
   has somewhere to put it.

**Deliberately not planned**

Multiplexing several Zed windows onto one Kiro process (cross-window state-leak risk for
no visible gain); a v3 southbound dialect until v3's ACP surface works; any Zed fork.

---

## Assessment against the definition of success

The brief's test was whether one can use Kiro in a normal Zed thread and stop thinking
about the adapter. Against its own checklist: choosing Claude Opus 5 ✅, choosing
GPT-5.6 Sol ✅, switching within the thread ✅, controlling effort ✅, switching agents ✅,
using Plan ✅, typing `/` for commands ✅, invoking skills ✅, using tools ✅, approving
operations ✅, images ✅, MCP ✅ (OAuth untested), context status ✅, sessions ✅ (list
verified, Zed's import UI manual), and benefiting automatically from future models and
commands ✅ — nothing is hardcoded.

The two honest caveats: MCP OAuth is unverified live, and slash-command argument
autocomplete is impossible without upstream protocol work. Neither is a workaround or a
hack; the first needs an environment, the second needs a spec change.
