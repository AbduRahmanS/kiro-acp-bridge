# Research

Everything here was verified against the running systems on 2026-09-04, not taken
from documentation. Where documentation and implementation disagreed, the observed
behaviour is recorded as authoritative and the discrepancy noted.

Versions under test:

| Component | Version |
|---|---|
| Kiro CLI | 2.21.0 (`/Users/…/.local/bin/kiro-cli`) |
| ACP TypeScript SDK | `@agentclientprotocol/sdk` 1.4.0 |
| ACP protocol | version `1` (stable schema line 1.21.0) |
| Zed | inspected at `main` commit `28e52a2879f07912fd583420615ad94eaa699a3f` |

---

## 1. The core incompatibility

**Kiro speaks the legacy ACP model API. Zed removed it.**

Kiro's `session/new` response, captured verbatim:

```json
{
  "sessionId": "00000000-0000-0000-0000-000000000000",
  "modes":  { "currentModeId": "kiro_default", "availableModes": [ … ] },
  "models": { "currentModelId": "claude-opus-5", "availableModels": [ … ] }
}
```

And it implements `session/set_model`:

```
→ {"method":"session/set_model","params":{"sessionId":"…","modelId":"gpt-5.6-luna"}}
← {"result":{}}
```

But it does **not** implement config options:

```
→ {"method":"session/set_config_option","params":{…}}
← {"error":{"code":-32601,"message":"Method not found","data":"session/set_config_option"}}
```

Zed, meanwhile, pins `agent-client-protocol = "=2.0.0"` with `features = ["unstable"]`
and has **no `session/set_model` code path at all**. `AcpConnection` does not
override `model_selector()`, so it inherits the default that returns `None` for
every external agent. Models, modes and reasoning effort are all driven through
`session/set_config_option`, and `config_state()` discards `modes` entirely
whenever `configOptions` is present.

That single mismatch is the whole problem. It is the root cause of
[zed#59169](https://github.com/zed-industries/zed/issues/59169) (no model selector),
[kiro#9998](https://github.com/kirodotdev/Kiro/issues/9998) (effort unreachable) and
[kiro#10034](https://github.com/kirodotdev/Kiro/issues/10034) (asking Kiro to adopt
standard methods). Zed's [PR #58308](https://github.com/zed-industries/zed/pull/58308)
is where the legacy selector was removed.

**Correction to a common assumption:** `session/set_model` does not exist anywhere
in current ACP — not in v1 stable, v1 unstable, v2 stable or v2 unstable. It is a
removed unstable API, not a standard one. There is no dedicated model API to wait
for; config options *are* the mechanism.

---

## 2. Kiro's ACP surface (measured)

### `initialize` response

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": true, "audio": false, "embeddedContext": false },
    "mcpCapabilities": { "http": true, "sse": false },
    "sessionCapabilities": {},
    "auth": {}
  },
  "authMethods": [],
  "agentInfo": { "name": "Kiro CLI Agent", "title": "Kiro CLI Agent", "version": "2.21.0" }
}
```

Two things matter here:

- **`sessionCapabilities: {}`** — Kiro advertises no session list/delete/resume/close,
  even though `_kiro.dev/session/list` works perfectly. The capability declaration
  understates the implementation.
- **`authMethods: []`** — Kiro relies on an already-authenticated CLI. This blocks
  ACP Registry publication, which requires every listed agent to return valid
  `authMethods`.

### Standard methods Kiro implements

| Method | Result |
|---|---|
| `initialize` | ✅ |
| `session/new` | ✅ returns non-standard `models` + `modes` |
| `session/load` | ✅ (capability advertised) |
| `session/prompt` | ✅ |
| `session/cancel` | ✅ returns `stopReason: "cancelled"` correctly |
| `session/set_model` | ✅ **legacy** — removed from ACP and from Zed |
| `session/set_mode` | ✅ mode ids are *agent* ids |
| `session/set_config_option` | ❌ `-32601` |
| `session/list` | ❌ `-32601` (but the `_kiro.dev` variant works) |

### `session/update` variants Kiro actually emits

Only three, measured across streaming, tool-using and cancelled turns:

- `agent_message_chunk`
- `tool_call`
- `tool_call_update`

Never observed: `agent_thought_chunk` (so reasoning is not streamed separately
even at `max` effort), `plan`, `usage_update`, `available_commands_update`,
`current_mode_update`, `config_option_update`, `session_info_update`.

### `_kiro.dev/*` extensions

Confirmed working:

| Method | Kind | Notes |
|---|---|---|
| `_kiro.dev/commands/available` | notification | 25 commands with rich metadata |
| `_kiro.dev/commands/options` | request | `command` is a **plain string enum**; `"/model"` fails, `"model"` works |
| `_kiro.dev/commands/execute` | request | `command` is a serde **adjacently tagged** enum: `{command:{command,args}}` |
| `_kiro.dev/session/list` | request | full saved-session index |
| `_kiro.dev/settings/list` | request | `{chat.defaultModel, chat.terminalTitle, …}` |
| `_kiro.dev/metadata` | notification | **percentage only**, no absolute tokens |
| `_kiro.dev/subagent/list_update` | notification | `{subagents:[],pendingStages:[]}` |
| `_kiro.dev/mcp/startup_status` | request | `{allStarted,failed,pending,determinable}` |
| `_session/spawn` | request | requires `task` |
| `_session/steer` | request | requires `message` |

Documented but **absent** in 2.21.0 v2: `_session/terminate` (`-32601`),
`_kiro.dev/commands/model/options` and `_kiro.dev/commands/agent/options` (`-32601`,
despite being advertised as `optionsMethod` values), `_kiro.dev/session/update`,
`_kiro/account/getUsage` (that is a v3 method).

### The `commands/options` enum

The deserialiser's own error message enumerates the accepted set:

```
model, agent, context, compact, clear, quit, usage, mcp, tools, prompts,
feedback, chat, rewind, effort
```

Option payloads carry semantic content in `group` and mark the active entry with
an `[active]` suffix inside `description` — there is no dedicated active field:

```json
{"value":"claude-opus-5","label":"claude-opus-5",
 "description":"Claude Opus 5 model with 1M context window [active]",
 "group":"2.20x credits"}
```

**Important defect:** the `[active]` marker **lags a change**. After `/plan`
succeeded and reported `"Agent changed to kiro_planner"`, `commands/options{agent}`
still marked `kiro_default` active. The command's own `data` block is the only
reliable post-change signal.

### `commands/execute` shape

`TuiCommand` is adjacently tagged with tag `command` and content `args`, both
required:

```json
{"sessionId":"…","command":{"command":"model","args":{"modelName":"gpt-5.6-sol"}}}
```

Arg keys by command: `model→modelName`, `effort→level`, `rewind→turnIndex`,
`compact→targetTokens`, `prompts→promptName`, `context→verbose`,
`feedback→feedbackType`.

---

## 3. Reasoning effort is genuinely per-model

Measured by switching model and re-reading `commands/options{effort}`:

| Model | Valid effort levels |
|---|---|
| `claude-opus-5` | low, medium, high, xhigh, max |
| `claude-sonnet-5` | low, medium, high, xhigh, max |
| `gpt-5.6-sol` | **none**, low, medium, high, xhigh, max |
| `gpt-5.6-luna` | **none**, low, medium, high, xhigh, max |
| `auto` | **`[]` — no effort axis at all** |

This validates the brief's central design concern. A static model→effort table
would have been wrong in two directions: it would have missed `none` on the GPT
family and would have shown a meaningless picker for `auto`.

There is no `session/set_effort`. Effort is reachable only through
`commands/execute {effort, {level}}`.

---

## 4. Agents, modes, Plan and Guide

**Kiro has no separate mode system.** What ACP calls modes, Kiro calls agents.
`session/new` returns agents in the `modes` field, and `session/set_mode` takes an
agent id. `session/set_mode` with `"plan"` fails (`Mode 'plan' not found`); the id
is `kiro_planner`.

`/plan` is an agent switch, confirmed by its own response:

```json
{"success":true,"message":"Agent changed to kiro_planner","data":{"agent":{"name":"kiro_planner","index":6}}}
```

Agents observed on the test machine, grouped by Kiro as `Built-in` / `Global`:
`kiro_default`, `kiro_guide`, `kiro_planner`, plus five user-defined `kirocrew*`
agents discovered dynamically from `~/.kiro/agents/`.

So the mental model the brief asked for holds, with one correction: **Agent and
Mode are the same axis in Kiro**, and only Model and Effort are genuinely
independent.

---

## 5. Slash commands

`_kiro.dev/commands/available` publishes 25 commands with metadata richer than ACP
can express:

```json
{"name":"/agent","description":"Select or list available agents",
 "meta":{"optionsMethod":"_kiro.dev/commands/agent/options","inputType":"selection",
         "hint":"","subcommands":["create","edit","swap"],
         "subcommandHints":{"create":"<name>","edit":"[name]","swap":"<name>"},
         "subcommandDescriptions":{"create":"Create a new agent"}}}
```

Note names arrive **with** a leading slash; ACP wants them without.

**Kiro's prompt path already interprets slash commands.** Sending the literal text
`/context` through `session/prompt` returned `"Context breakdown - 3% used"` with a
single `agent_message_chunk` and no model invocation. This is why forwarding is the
correct default and costs nothing.

### Skills are invisible over ACP

With 13 global skills installed and one workspace skill added, `commands/available`
still listed only the 25 built-ins. Skills are entirely absent from Kiro's ACP
surface.

But they **work** when invoked as prompt text: `/probe-test-skill say the phrase`
activated the skill and returned its sentinel token. So Kiro's runtime supports
skills; only discovery is missing. That asymmetry is what justifies the bridge
reading `SKILL.md` files itself — the only place this project parses Kiro config
from disk.

---

## 6. Context usage and credits

`_kiro.dev/metadata` carries a **percentage only**:

```json
{"sessionId":"…","contextUsagePercentage":0.8828000426292419}
```

This is [kiro#9992](https://github.com/kirodotdev/Kiro/issues/9992) — per-turn token
counts were dropped from ACP output in 2.10+.

However `/context` exposes real absolute counts per bucket:

```
contextFiles    tokens=1523     percent=0.5599
tools           tokens=7285     percent=2.6783
kiroResponses   tokens=777      percent=0.2923
yourPrompts     tokens=344      percent=0.1294
sessionFiles    tokens=0        percent=0
SUM                    = 9929
contextUsagePercentage = 3.659926
implied window         = 271290   (declared: 272000)
```

The 0.3% agreement between the summed tokens and Kiro's own percentage confirms both
describe the same quantity, so `used` can be *measured* rather than inferred from a
percentage — which the brief explicitly required.

`/usage` returns genuine billing structure (balance figures below are illustrative,
not a real account):

```json
{"planName":"KIRO PRO MAX","billingCycleReset":"2026-10-01","overagesEnabled":true,
 "isEnterprise":true,
 "usageBreakdowns":[{"resourceType":"CREDIT","displayName":"Credits","used":1234.56,
   "limit":5000,"percentage":25,"currentOverages":0,"overageRate":0.04,
   "overageCharges":0,"currency":"USD","hasLimit":true}],
 "bonusCredits":…,"addOnCredits":…,"overageCapable":true}
```

Two distinct quantities live here: abstract **credits** (1234.56 / 5000) and genuine
**money** (`overageCharges`, `currency: "USD"`). ACP's `Cost` requires an ISO 4217
currency, so only the latter may populate it. See `docs/architecture-decision.md`
for the resulting rule.

---

## 7. Tool calls and permissions

Permission options Kiro offers:

```json
[{"optionId":"allow_once","name":"Yes","kind":"allow_once"},
 {"optionId":"allow_always","name":"Always","kind":"allow_always"},
 {"optionId":"reject_once","name":"No","kind":"reject_once"}]
```

No `reject_always`. Rejecting genuinely prevents the operation — verified by
confirming the target file did not exist afterwards.

### Two path defects

`tool_call.locations[].path` is **relative**, which violates ACP's "all paths MUST
be absolute":

```json
"locations":[{"path":"probe_out.txt","line":1}]
```

`tool_call.content[].diff.path` is absolute but its base directory depends on
something surprising — **whether the client implements `fs/write_text_file`**:

- client stubs it out → path uses the **Kiro process cwd**, not the session cwd.
  Observed: `/Users/…/kiro-zed-acp/probe_out.txt` reported while actually writing
  `/tmp/kiro-probe/ws/probe_out.txt`.
- client performs the write → path is the correct directory but **symlink-resolved**
  (`/private/tmp/...` for a session cwd of `/tmp/...`).

Both forms mislead Zed, which associates files with a project by path.

---

## 8. Images are per-model, not per-agent

`initialize` advertises `promptCapabilities.image: true` for the whole agent, but
support varies by model. A 48×48 PNG with `claude-opus-5` returned the correct
answer ("Blue"). The same image on `gpt-5.6-luna` returned
`-32603 "Encountered an error in the response stream: Improperly formed request"`.

On a later run the same luna request completed with `end_turn` instead of erroring,
so the behaviour is not perfectly deterministic. The honest statement is: image
support is a per-model property that ACP's single agent-level capability flag
cannot express.

---

## 9. The v3 engine is not usable

`kiro-cli acp --agent-engine v3` fails at `session/new` (returns no session id) and
rejects every `_kiro.dev/*` method:

```json
{"error":{"code":-32603,"message":"Internal error",
 "data":{"details":"[PersistenceClassification] Ext method \"_kiro.dev/commands/options\" has no persistence classification. Add it to KnownExtMethod in persistence-classification.ts."}}}
```

v3 also moves extensions to a different `_kiro/*` namespace. This matches
[kiro#10761](https://github.com/kirodotdev/Kiro/issues/10761) and
[kiro#10877](https://github.com/kirodotdev/Kiro/issues/10877). **v2 is the only
viable target**, and the bridge pins it.

---

## 10. Zed's client behaviour (source-verified)

| Capability | Status in Zed |
|---|---|
| `configOptions` + `session/set_config_option` | ✅ primary mechanism |
| `sessionModes` + `session/set_mode` | ✅ but **ignored** when `configOptions` present |
| `session/set_model` / `models` | ❌ not implemented at all |
| `category: "thought_level"` | ✅ dedicated "Change/Cycle Thinking Effort" actions |
| Config option kinds | `select` and `boolean` only; others render blank |
| `availableCommands` | ✅ listed and grouped in the `/` menu |
| Command argument hints | ❌ `input` read as a boolean; **hint string discarded** |
| Command transport | plain `ContentBlock::Text` in `session/prompt` |
| `usage_update` | ✅ progress ring, warns at 85% |
| `session/list`/`load`/`resume`/`delete`/`close` | ✅ all, capability-gated |
| Elicitation (form + url) | ✅ URL mode auto-accepts and calls `cx.open_url` |
| `mcpServers` forwarding | ✅ stdio + http on new/load/resume |
| Permission kinds | 4 recognised; **unknown kinds render as reject-always** |
| ACP log viewer | ✅ `dev: open acp logs` |
| Unknown `session/update` variants | silently dropped, no warning |

Zed's custom-agent settings schema:

```json
{
  "agent_servers": {
    "Kiro": { "type": "custom", "command": "…", "args": ["…"], "env": {} }
  }
}
```

Also supported: `default_mode`, `default_config_options`,
`favorite_config_option_values`.

---

## 11. Licensing

**Kiro CLI cannot legally be forked or modified.** Per
[kiro.dev/license](https://kiro.dev/license/) it is licensed as "AWS Content" under
the AWS Customer Agreement; the `kirodotdev/Kiro` repository states the product
source is not hosted there, and the product ships as signed, stripped native
binaries. This eliminates "modify Kiro" as an architecture, on legal grounds rather
than difficulty.

Reference implementations inspected, all **Apache-2.0**, so patterns may be adapted
with attribution: the ACP spec repo, `agentclientprotocol/typescript-sdk`,
`agentclientprotocol/claude-agent-acp`, `agentclientprotocol/codex-acp` (whose
`LICENSE` carries a `Copyright 2025 JetBrains s.r.o.` header on otherwise standard
Apache-2.0 text). AWS's own Kiro-ACP samples are MIT-0.

No code was copied from any of these. `codex-acp`'s treatment of reasoning effort as
a `thought_level` config option informed the design; the implementation here is
independent.

---

## 12. Documentation discrepancies found

| Claim | Reality |
|---|---|
| Kiro docs list `_session/terminate` | `-32601` on 2.21.0 v2 |
| `commands/available` advertises `optionsMethod: "_kiro.dev/commands/model/options"` | that method is `-32601`; options come from `commands/options{model}` |
| Kiro advertises `sessionCapabilities: {}` | `_kiro.dev/session/list` works fine |
| `promptCapabilities.image: true` (agent-wide) | image support is per-model |
| Kiro docs describe CLI 3.0 features | installed 2.21.0 defaults to engine v2; v3 ACP is broken |
| ACP docs suggest `availableCommands` on session creation | not in `NewSessionResponse`; notification only |
