# Upstream Reports

Defects found while building this bridge, reported to the projects that own them.
Each one, if fixed, lets the bridge delete code — which is the stated goal in
[compatibility.md](compatibility.md): this project should shrink over time.

## Filed

| Issue | What | If fixed, the bridge can… |
|---|---|---|
| [kirodotdev/Kiro#11230](https://github.com/kirodotdev/Kiro/issues/11230) | `tool_call.locations[].path` is relative (violates ACP's absolute-path rule); `content[].diff.path` is resolved against the Kiro **process** cwd rather than the session cwd, and its shape changes depending on whether the client implements `fs/write_text_file` | delete most of `src/bridge/paths.ts` (~150 lines + 27 tests) |
| [kirodotdev/Kiro#11231](https://github.com/kirodotdev/Kiro/issues/11231) | The `[active]` marker in `commands/options` is stale immediately after a change, and **no notification is emitted** when the model or agent changes | stop mirroring selector state in `src/bridge/session.ts` and drop the generation-counter machinery |
| [kirodotdev/Kiro#11232](https://github.com/kirodotdev/Kiro/issues/11232) | `--agent-engine v3` is unusable over ACP: `session/new` returns nothing and every `_kiro.dev/*` method fails with a `PersistenceClassification` internal error | unpin `--agent-engine v2` |
| [zed-industries/zed#63796](https://github.com/zed-industries/zed/issues/63796) | `AvailableCommand.input.hint` is received and discarded, so argument hints are invisible | nothing — the bridge already sends hints; this is purely a rendering gap |

## Not filed, and why

**`session/set_config_option` unimplemented in Kiro** — already covered by
[kirodotdev/Kiro#10034](https://github.com/kirodotdev/Kiro/issues/10034). This is
the single biggest simplification available: it would retire the entire translation
layer in `src/bridge/config.ts`.

**Absolute token counts absent from ACP output** — already covered by
[kirodotdev/Kiro#9992](https://github.com/kirodotdev/Kiro/issues/9992). Would let
`src/bridge/usage.ts` forward `usage_update` directly instead of summing `/context`
buckets.

**Skills not advertised over ACP** — partially overlaps
[kirodotdev/Kiro#6324](https://github.com/kirodotdev/Kiro/issues/6324) (custom
agents not loading skills). Worth filing separately if that one is resolved without
addressing discovery, since `src/bridge/skills.ts` only exists because skills are
undiscoverable over the protocol despite being executable.

**`sessionCapabilities: {}` despite `_kiro.dev/session/list` working** — minor, and
would be resolved as a side effect of #10034 adopting standard methods.

**No argument-completion mechanism in ACP** — not a defect, a genuine protocol gap.
Would need an RFD to the ACP spec rather than a bug report, since no RPC exists for
enumerating candidate argument values. Noted in
[capability-matrix.md](capability-matrix.md#not-implemented).

## Reporting standard used

Each report includes the exact wire payload observed, the reproduction sequence, the
expected behaviour, and a link to the workaround in this repository so anyone hitting
the same thing has something to copy. Findings are stated as measured, with the
conditions under which they were measured — one earlier finding in this project was
wrong precisely because a single-state observation was generalised (see the
`authMethods` correction in [research.md](research.md)).
