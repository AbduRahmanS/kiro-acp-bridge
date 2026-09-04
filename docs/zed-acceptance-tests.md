# Zed Acceptance Tests

Manual tests to run inside real Zed. The lettered tests are the brief's definition of
done. Each records the result from the automated end-to-end run; the manual column is
for you to confirm in the editor.

Setup: register the bridge per [zed-setup.md](zed-setup.md), open the Agent Panel,
select **Kiro**.

Automated equivalents live in `scripts/e2e-*.mjs` and drive the built bridge through a
simulated Zed against real Kiro. Where a test is fully covered there, it is marked.

---

## Test A — model switching

1. Start a Kiro thread.
2. Confirm a **Model** picker is visible.
3. Choose **Claude Opus 5**.
4. Send `Which model are you? One line.`
5. Confirm the reply identifies an Opus model.
6. In the **same thread**, switch the model to **GPT-5.6 Sol**.
7. Send the same prompt again.
8. Confirm the reply identifies a GPT model.

Pass criteria: no ACP restart, no new thread, no per-model fake agent, no config editing.

> Automated: `e2e-config.mjs` — model picker present, switch applied in-session, and a
> model self-report confirming `gpt-5.6-luna` was genuinely in effect. **PASSED.**

## Test B — reasoning effort

1. Select **GPT-5.6 Sol**.
2. Open the **Effort** picker. Confirm it includes `None` as well as Low…Max.
3. Choose **Max**.
4. Switch the model to **Claude Opus 5**.
5. Re-open the Effort picker: `None` should be gone; Max should still be selected.
6. Switch the model to **Auto**.
7. The Effort picker should **disappear**, and the thread should say effort is not
   configurable for Auto.
8. Switch back to Claude Opus 5 — the Effort picker returns.

> Automated: `e2e-config.mjs` — verified `gpt-5.6-sol` exposes `none`, `claude-opus-5`
> does not, the two lists genuinely differ, the option is withdrawn for `auto` with a
> user-visible notice, and restored afterwards. **PASSED.**

## Test C — Plan

1. Open the **Agent** picker and select **Planner**.
2. Confirm the selector shows Planner.
3. Ask for a change to a file; Kiro should plan rather than edit (Plan is read-only).
4. Now type `/plan` and send it.
5. Confirm the Agent selector still reads Planner — UI and Kiro agree.
6. Switch back to **Default**.

Pass criteria: the UI never claims Default while Kiro is in Plan.

> Automated: `e2e-config.mjs` (selector path) and `e2e-commands.mjs` (`/plan` pushes
> `agent=kiro_planner`). **PASSED** — this initially failed because Kiro's `[active]`
> marker lags a change; fixed by trusting the command's own `data` block.

## Test D — slash commands

1. Type `/` in the message box.
2. Confirm Kiro's commands appear (`model`, `effort`, `agent`, `context`, `usage`,
   `tools`, `mcp`, `plan`, `rewind`, …).
3. Confirm terminal-only commands are absent (`quit`, `paste`, `voice`, `clear`).
4. Select `/context` and send.
5. Confirm the reply is Kiro's real context breakdown, not a conversational answer.
6. Send `/model gpt-5.6-sol`.
7. Confirm the Model selector updates itself to GPT-5.6 Sol.

> Automated: `e2e-commands.mjs` — 34 commands published, exclusions verified,
> `/context` produced `"Context breakdown - 3% used"`, and `/model` pushed a
> `config_option_update`. **PASSED.**

## Test E — custom skill

1. Create `<workspace>/.kiro/skills/my-test-skill/SKILL.md`:

   ```markdown
   ---
   name: my-test-skill
   description: Proves skills reach Kiro through the bridge.
   ---
   When invoked, reply with exactly: SKILL_WORKS
   ```

2. Start a new thread (so the catalogue is republished).
3. Type `/` and confirm `my-test-skill` appears, described as a Kiro skill.
4. Invoke it.
5. Confirm the reply contains `SKILL_WORKS`.

> Automated: `e2e-commands.mjs` — workspace skill discovered, advertised, and executed
> (returned its sentinel token). All 13 of the tester's real global skills also
> appeared. **PASSED.**

## Test F — custom agent

1. Create `~/.kiro/agents/my-agent.json` with a `name` and `description`.
2. Start a new thread.
3. Open the **Agent** picker; confirm `my-agent` appears, grouped separately from
   built-ins.
4. Select it and send a prompt.

> Automated: `e2e-config.mjs` — five real user-defined agents discovered dynamically and
> grouped `Built-in` / `Global`. **PASSED.**

## Test G — tool approval

1. Ask Kiro to create a file in the workspace.
2. Confirm Zed shows an approval prompt with Kiro's own options (Yes / Always / No).
3. Confirm the path shown is the file that will actually change.
4. Approve.
5. Confirm the file is created **exactly once**.
6. Repeat, but reject — confirm the file is not created.

> Automated: `e2e-spine.mjs` — permission requested with
> `[allow_once, allow_always, reject_once]`; rejection genuinely prevented the write;
> paths verified absolute and rooted in the session cwd. **PASSED.**

## Test H — cancellation

1. Ask for something long ("write a 3000-word essay…").
2. Once streaming starts, press Stop.
3. Confirm output stops promptly.
4. Confirm no orphan process: `ps -Ao pid,command | grep '[k]iro-cli'`.

> Automated: `e2e-spine.mjs` — `stopReason: "cancelled"` returned; child reaped.
> **PASSED.**

## Test I — session restore

1. Have a conversation, note something distinctive in it.
2. Quit Zed entirely.
3. Reopen, open the Agent Panel history, and use **Import Threads**.
4. Confirm Kiro sessions appear with titles.
5. Open one and confirm the history is present.

> Automated: `e2e-usage.mjs` — `session/list` returned 41 sessions, all with absolute
> cwd, 22 with titles, cwd filter working. **PARTIAL:** the standard method is verified;
> Zed's import UI itself was not driven automatically. Needs manual confirmation.

## Test J — images

1. Select **Claude Opus 5** (a vision-capable model).
2. Paste or attach a screenshot.
3. Ask a question about it.
4. Confirm the reply reflects the image content.
5. Switch to a non-vision model and retry — confirm a clear error rather than a silent
   wrong answer.

> Automated: `e2e-failures.mjs` — a 48×48 PNG on `claude-opus-5` returned the correct
> answer ("Blue"); the per-model failure path surfaces rather than being swallowed.
> **PASSED.**

---

## State consistency (brief §39)

| Scenario | Expected | Status |
|---|---|---|
| Select Opus in the UI | UI, bridge and Kiro all show Opus | automated ✅ |
| `/model gpt-5.6-sol` | Kiro changes, bridge detects, Zed updates, no stale selector | automated ✅ |
| `/plan` | Agent selector switches to Planner | automated ✅ |
| `/effort max` | Effort selector shows Max | automated ✅ |
| Model change invalidating effort | Effort refreshed; user told if it changed | automated ✅ |
| Rejected invalid value | State unchanged, `-32602` returned | automated ✅ |

## Not covered automatically

These need a human, or environment this project could not provide.

| Area | Why | How to check |
|---|---|---|
| **MCP OAuth** | No OAuth-requiring MCP server was available | Configure one, confirm Zed shows a URL prompt and does not auto-open it |
| **MCP de-duplication** | No `~/.kiro/settings/mcp.json` existed | Configure the same server in Kiro and Zed; confirm its tools appear once |
| **Zed thread import UI** | Zed UI automation out of scope | Test I above |
| **Remote / SSH projects** | Needs a second host | Install Kiro + Node ≥ 22 remotely, set `KIRO_CLI_PATH` |
| **Windows** | Untested; discovery has Windows paths but no CI | Run Test A on Windows |
| **`/rewind`, `/spawn`** | Work as commands; no richer UI | Invoke and confirm Kiro's own behaviour |

## Regression run

Before a release:

```bash
npm test                        # 186 unit tests
npm run build
node scripts/e2e-spine.mjs
node scripts/e2e-config.mjs
node scripts/e2e-commands.mjs
node scripts/e2e-usage.mjs
node scripts/e2e-failures.mjs
```

Then Tests A–J manually in Zed. The end-to-end scripts use `KIRO_DATA_DIR` isolation and
the cheapest model, so a full run costs a negligible number of credits.
