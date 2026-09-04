# Implementation Plan

Written before coding, updated at the research gate, and annotated on completion. Kept
as a record of what was planned versus what actually happened.

## Research gate — the 16 questions answered

The brief required stopping after research to answer these before writing code.

**1. Is a standalone bridge still the best architecture?** Yes. Forking Kiro is legally
impossible (AWS Content, binaries only, no source). Zed already renders every surface
needed, so a Zed-specific integration would add coupling for nothing.

**2. What can standard ACP already provide?** Almost everything: config options with
`mode`/`model`/`thought_level` categories, `available_commands_update`, `usage_update`,
form and URL elicitation, `session/list`/`load`, permissions, terminals, fs access.

**3. What Kiro features require translation?** Six: model selection, mode selection,
effort, command catalogue, usage, session listing. All mechanical.

**4. What Zed features are missing?** One, cosmetic: it discards
`AvailableCommand.input.hint`.

**5. Does anything require modifying Zed?** No, for the whole P0+P1 scope.

**6. Does anything require modifying Kiro?** Nothing for this scope. Several things would
*simplify* the bridge — see the retirement triggers in `compatibility.md`.

**7. Which SDK?** `@agentclientprotocol/sdk` 1.4.0 (TypeScript). The bridge must be both
agent and client in one process, which its `agent()`/`client()` builders support
directly; `npx` distribution also works over remote Zed.

**8. What protocol version?** v1 stable. v2 is alpha and current Zed negotiates v1.

**9. How will model discovery work?** `commands/options{model}` — the only source that
also carries credit multipliers and the active marker; `session/new`'s `models` block as
the seed.

**10. How will effort discovery work?** `commands/options{effort}`, re-queried after every
model change. Verified to genuinely differ per model.

**11. How will agents be discovered?** `commands/options{agent}`, which includes
user-defined agents and provenance grouping.

**12. How will slash commands be discovered?** The `_kiro.dev/commands/available`
notification, plus filesystem discovery for skills, which Kiro does not publish.

**13. How will argument completion work?** It cannot. No mechanism exists in ACP or Zed.
Documented as an upstream gap.

**14. How will sessions be listed?** Implement standard `session/list` on top of
`_kiro.dev/session/list`. Kiro stays the only store.

**15. How will MCP OAuth work?** `_kiro.dev/mcp/oauth_request` → `elicitation/create`
with `mode: "url"`, which is ACP's purpose-built mechanism and is supported by Zed.

**16. What cannot reach full native UX, and why?** Argument autocomplete (no protocol
support); `/rewind` checkpoint selection and `/spawn` parallel sessions (no ACP surface
for either); credits (ACP `Cost` demands ISO currency).

### Plan changes made at the gate

- **Pin `--agent-engine v2`.** Not in the original plan; added after v3 proved unusable.
- **Add filesystem skill discovery.** The brief assumed Kiro published skills. It does not.
- **Add path correction as a first-class task.** Two ACP violations found during probing.
- **Drop `session/resume`.** Kiro does not advertise it and `session/load` suffices.
- **Treat command `data` blocks as authoritative.** Added after finding the `[active]`
  marker lags changes.

## Task sequence

Vertical slices, each independently demoable, per the brief's §47.

| # | Task | Outcome |
|---|---|---|
| 1 | Skeleton + Kiro client connection | done — handshake against real Kiro, clean teardown |
| 2 | Pass-through spine | done — 24/24; both path defects fixed |
| 3 | Model config option | done — Test A |
| 4 | Per-model effort | done — Test B |
| 5 | Agent selector + Plan | done — Tests C, F |
| 6 | Slash commands | done — Test D |
| 7 | Skills | done — Test E |
| 8 | Usage + credits | done |
| 9 | Session list | done |
| 10 | MCP status + OAuth | done; OAuth not verified live |
| 11 | Diagnostics + failure handling | done |
| 12 | Docs, packaging, cleanup | done |

Tasks 3–5 were built together rather than sequentially, because a model change
invalidates the effort set — they share one state machine and could not be verified in
isolation. Tasks 6–7 were likewise combined, sharing the command-advertisement path.

## Milestones

**P0 — complete and verified.** Dynamic model selector including `claude-opus-5` and
`gpt-5.6-sol`; dynamic effort selector; agent/mode selector; dynamic slash commands;
streaming, tool calls, permissions, cancellation, images, session creation.

**P1 — complete except where blocked.** Skills ✅, context usage ✅, `/usage` ✅, session
list ✅, custom agents ✅, MCP status ✅, MCP OAuth ⚠️ (untested live), Plan sync ✅,
diagnostics ✅. Argument autocomplete ❌ — impossible upstream. Compaction/clear status ❌
— no stable ACP surface.

**P2 — not attempted, deliberately.** Rewind and spawn remain reachable as commands;
neither has an ACP surface worth faking. Knowledge, prompts and hooks work through the
command system. Landing P0 and P1 solidly was judged more valuable than half-building six
more surfaces.

## Verification approach

Every task had to be demonstrated against **real Kiro** before being marked done, not
merely compile. That discipline found six bugs that unit tests alone would have missed —
including the discovery hijack, the stale marker, and the ESM `require` fault. Details in
[final-report.md](final-report.md#bugs-found-by-testing-and-fixed).

Cost control: config queries and slash commands invoke no model, so most testing is free.
Where a model was needed, `gpt-5.6-luna` (0.1× multiplier) and micro-prompts kept spend
negligible.

Isolation: all probing ran with `KIRO_DATA_DIR` redirected, so nothing touched `~/.kiro`.
`pkill`/`killall` were never used — only PIDs the tests spawned themselves were signalled.
This mattered because the development machine had live Kiro sessions throughout, including
two owned by a running Zed.
