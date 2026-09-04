# Architecture

## Shape

One process, two ACP connections over independent stdio streams.

```
             ┌──────────────── kiro-acp-bridge ────────────────┐
             │                                                  │
Zed ◀──stdio─┼─▶ agent()      translation      client() ◀─stdio─┼─▶ kiro-cli acp
   standard  │   northbound       layer        southbound       │   legacy ACP +
   ACP v1    │                                                  │   _kiro.dev/*
             └──────────────────────────────────────────────────┘
```

The northbound face is standards-compliant ACP v1. All Kiro-specific vocabulary is
confined to the southbound side and the translation modules. That separation is the
point: as Kiro adopts standard ACP, translation modules can be deleted without
touching the northbound code.

## Modules

```
src/
  index.ts                 executable entry: stdout protection, signals, exit codes
  lib.ts                   library surface for embedding

  bridge/
    bridge.ts              KiroBridge — the northbound agent, request handlers
    config.ts              model / effort / agent  ⇄  ACP config options
    commands.ts            slash-command translation and dispatch planning
    skills.ts              skill discovery (Kiro does not publish these)
    usage.ts               context tokens and credit semantics
    mcp.ts                 MCP de-duplication and OAuth → URL elicitation
    paths.ts               correction of Kiro's two tool-call path defects
    labels.ts              id → human label, generated not tabulated
    session.ts             per-session mirrored state

  kiro/
    discovery.ts           locating kiro-cli, with an actionable failure
    process.ts             child lifecycle, escalating shutdown
    connection.ts          southbound ACP client, typed Kiro dialect
    protocol.ts            Kiro wire types and method registry

  diagnostics/
    logging.ts             stderr-only logging, tracing, redaction
```

## Two invariants

**stdout belongs to the protocol.** A stray `console.log` anywhere — including from a
dependency — would corrupt the JSON-RPC stream and Zed would drop the connection.
`src/index.ts` therefore reassigns `console.log`/`info`/`warn`/`debug` to stderr
*before any other import runs*. All diagnostics go to stderr or an explicit file.

**The child is always reaped.** Kiro issue #10258 makes an orphaned `kiro-cli-chat acp`
expensive — it busy-waits at high CPU — and #10666 shows a stale session lock can make
a later `session/load` refuse. Shutdown escalates: stdin EOF (Kiro's normal exit path)
→ SIGTERM → SIGKILL, each with a bounded grace period. Signals, transport close and
Kiro crashes all route through the same path.

## Request flow

### `initialize`

Zed's capabilities are forwarded to Kiro unchanged, because the bridge proxies `fs/*`
and `terminal/*` transparently. Kiro's capabilities are then reported northbound with
one honest addition: `sessionCapabilities.list`, which the bridge implements on top of
`_kiro.dev/session/list` even though Kiro advertises no session capabilities.

Kiro is spawned lazily here rather than at process start, because the southbound
`initialize` needs Zed's capabilities. The consequence is that a missing `kiro-cli`
surfaces inside a JSON-RPC request, so the actionable guidance is written to stderr
explicitly — otherwise it would be buried in an error payload where Zed's log viewer
never shows it.

### `session/new`

1. Drop MCP servers Kiro already manages, so nothing starts twice.
2. Create the Kiro session; seed mirrored state from its non-standard `models` and
   `modes` blocks.
3. `refreshAll()` — enrich from `commands/options`, which is the only source of credit
   multipliers, agent grouping, active markers and the effort axis.
4. Return `configOptions` plus a legacy `modes` mirror.
5. **After** responding, publish the command catalogue, read usage, and check MCP
   status. These are notifications and must not race the response.

### `session/prompt`

```
prompt arrives
  ├─ leading slash command?
  │    ├─ /usage           → bridge renders plan, credits and context
  │    ├─ state-changing?  → commands/execute, then push config_option_update
  │    └─ anything else     → forward verbatim (Kiro's prompt path handles it)
  └─ plain prompt          → forward
```

Streaming is forwarded frame by frame with no buffering, so the bridge adds no
perceptible first-token latency. `tool_call` and `tool_call_update` are the only
frames rewritten, and only to correct paths.

### Config option changes

`session/set_config_option` → validate → apply to Kiro → **re-read effort** →
return the complete `configOptions` array. Returning the full array matters: Zed
replaces its local state wholesale from the response, so a partial reply would silently
drop selectors.

## Why the bridge mirrors state

**Kiro emits no notification when the model or agent changes.** Verified: both
`session/set_model` and `/model <name>` produce only a `_kiro.dev/metadata`
context-percentage notification — nothing identifying the new model.

Since every mutation path runs through the bridge, it can be the authoritative mirror
and push `config_option_update` to Zed. Without this, `/model gpt-5.6-sol` would change
Kiro while Zed's picker kept showing the old value.

Two hazards are handled explicitly:

**Stale active markers.** The `[active]` marker in `commands/options` *lags* a change.
After `/plan` reported `"Agent changed to kiro_planner"`, `commands/options{agent}` still
marked `kiro_default`. So a command's own `data` block is treated as authoritative and
re-asserted *after* any list refresh.

**Superseded async work.** Each session carries a generation counter. Handlers capture
it before awaiting and discard their result if it changed, so a slow effort re-query
cannot overwrite newer state.

## The effort dependency

Effort is the only option whose valid values depend on another option:

```
model change → set_model → re-query commands/options{effort}
                              ├─ previous level still valid → keep it
                              ├─ invalid                    → Kiro's default + notice
                              └─ empty (e.g. `auto`)        → withdraw option + notice
```

An empty effort set is meaningful, not an error. `auto` has no effort axis, so the
option is removed from `configOptions` entirely rather than shown empty — and the user
is told, rather than having a control disappear silently.

## Path correction

Kiro reports tool-call paths in two defective forms, and which one you get depends on
whether the client implements `fs/write_text_file`:

| Field | Defect | Correction |
|---|---|---|
| `locations[].path` | relative — violates ACP's absolute-path rule | resolve against session cwd |
| `content[].diff.path` | rooted in the **Kiro process** cwd | re-root on session cwd using `rawInput`'s relative tail |
| `content[].diff.path` | symlink-resolved (`/private/tmp` vs `/tmp`) | re-spell using the cwd Zed supplied |

The last one matters because Zed associates files with a project **by path**; the
resolved spelling would not match. Symlink comparison resolves the deepest *existing*
ancestor, so it works for directories a tool is about to create.

Correction is deliberately conservative: an absolute path is only re-rooted when
Kiro's own `rawInput` proves it started out relative. The filesystem is never probed to
decide, because a translation layer that consulted the disk would behave differently
depending on timing.

## Security boundaries

- Kiro owns authentication. The bridge never reads or stores credentials.
- Kiro owns permissions. The bridge forwards `session/request_permission` unchanged,
  never auto-approves, and never adds an option Kiro did not offer. Paths inside the
  request are corrected so the approval prompt names the file that will actually change
  — a correctness issue for consent, not cosmetics.
- OAuth URLs go to the client, which asks the user. The bridge never opens a browser and
  never logs the URL, which can embed client identifiers and PKCE challenges.
- Subprocess spawning uses a fixed argument array with `shell: false`.
- Secret-bearing keys are redacted from all diagnostics; prompt content is excluded by
  default even when tracing.

## Testing strategy

**Unit tests (186)** run against fixtures captured from real Kiro traffic, including
the per-model effort matrix and the exact defective `tool_call` payload. No credits are
spent and no Kiro process is needed.

**End-to-end scripts** drive the *built* bridge through a simulated Zed
(`scripts/lib/zed-sim.mjs`) against real Kiro, exercising the genuine northbound
protocol rather than internal APIs. They advertise the same capabilities current Zed
does, so the bridge behaves as it will in production. All use `KIRO_DATA_DIR`
isolation and prefer the cheapest model.
