# Publishing to the ACP Registry

The ACP Registry is how ACP clients discover agents. Once listed, Zed users select
Kiro from a list instead of hand-editing `settings.json`, and Zed's agent block
becomes:

```json
{ "agent_servers": { "Kiro": { "type": "registry" } } }
```

Registry: <https://github.com/agentclientprotocol/registry> ·
Index: <https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json>

There is currently **no Kiro entry** in the registry (39 agents listed, none Kiro).

---

## The blocker that had to be solved first

The registry refuses to list an agent that cannot authenticate. Its CI runs:

```bash
python3 .github/workflows/verify_agents.py --auth-check
```

and requires `initialize` to return `authMethods` containing at least one method of
`type: "agent"` or `type: "terminal"`.

**Kiro returns `authMethods: []`.** It assumes an already-authenticated CLI and offers
no in-protocol sign-in. Passing that through would fail validation.

The fix is ACP **Terminal Auth**, and it is not a workaround — it is an accurate
description of how Kiro authentication actually works. `kiro-cli login` is an
interactive terminal OAuth flow, which is exactly what Terminal Auth exists to model.
So the bridge advertises:

```json
{
  "id": "kiro-cli-login",
  "name": "Sign in to Kiro",
  "description": "Runs `kiro-cli login` in a terminal to authenticate this machine.",
  "type": "terminal",
  "args": ["--login"],
  "env": {}
}
```

and implements it: `kiro-acp-bridge --login` hands the terminal to `kiro-cli login`,
forwarding any extra arguments (`--license pro`, `--use-device-flow`, …). The bridge
still never handles credentials.

Two supporting changes were needed:

- **`initialize` no longer fails when Kiro is missing.** The registry's CI runner will
  not have `kiro-cli` installed, so a hard failure would return no `authMethods` at
  all. It now completes with conservative capabilities plus the auth method, and the
  real problem surfaces at `session/new`. This is better behaviour in Zed too: the
  agent connects and can offer sign-in, rather than appearing dead.
- **Kiro's credential errors map to ACP `-32000`.** Clients use that specific code to
  decide when to present auth methods. Without the translation, a signed-out user got
  an opaque internal error instead of a sign-in prompt.

Verify all of this locally before opening a PR:

```bash
npm run verify:registry
```

It reproduces the registry's checks, including the no-Kiro-installed case.

---

## Steps

### 1. Fill in the placeholders

`registry/kiro-acp-bridge/agent.json` contains `REPLACE_ME` in two fields. Set them to
your real GitHub repository and author. `npm run verify:registry` fails until they are
gone — deliberately, so a placeholder cannot reach a PR.

Also set `repository` in `package.json`; npm and the registry both use it, and the
registry relies on it for automatic version bumps.

### 2. Publish to npm

The registry validates that the exact pinned version exists on
`registry.npmjs.org`, so npm must come first.

```bash
npm login
npm publish --access public     # runs build + tests via prepublishOnly
```

`kiro-acp-bridge` was available at the time of writing. Confirm with
`npm view kiro-acp-bridge`.

### 3. Push the source

The registry wants a real `repository` URL, and reviewers will look at it.

```bash
git init && git add -A && git commit -m "Initial commit: Kiro ACP bridge"
git branch -M main
git remote add origin git@github.com:<you>/kiro-acp-bridge.git
git push -u origin main
```

Check that `.gitignore` is doing its job first — `node_modules/`, `dist/` and trace
logs must not be committed. Trace files can contain prompt text when
`KIRO_BRIDGE_TRACE_CONTENT=1` was used.

### 4. Submit the registry PR

```bash
gh repo fork agentclientprotocol/registry --clone
cd registry
mkdir -p kiro-acp-bridge
cp /path/to/kiro-acp-bridge/registry/kiro-acp-bridge/agent.json  kiro-acp-bridge/
cp /path/to/kiro-acp-bridge/registry/kiro-acp-bridge/icon.svg    kiro-acp-bridge/
```

Run their validator before pushing:

```bash
uv run --with jsonschema .github/workflows/build_registry.py
python3 .github/workflows/verify_agents.py --auth-check --agent kiro-acp-bridge
```

Then commit and open the PR.

### 5. After merge

Versions update **automatically every hour** from npm, so routine releases need only
`npm publish`. Manual PRs are needed only for metadata changes such as the
description or adding binary platforms.

---

## What the entry declares

```json
{
  "id": "kiro-acp-bridge",
  "name": "Kiro",
  "version": "0.1.0",
  "description": "Kiro CLI with native model, reasoning-effort and agent selectors plus dynamic slash commands and skills.",
  "license": "Apache-2.0",
  "distribution": { "npx": { "package": "kiro-acp-bridge@0.1.0", "args": [] } }
}
```

`npx` distribution rather than binaries: it needs no per-platform build, works on every
platform Node runs on, and works for remote/SSH Zed projects where Zed executes the
agent on the remote host. Binaries can be added later if cold-start latency matters.

Note the display `name` is **Kiro**, not "Kiro ACP Bridge" — the user is choosing Kiro;
the bridge is plumbing they should not have to think about.

## Validation rules worth remembering

- `id` must be lowercase, start with a letter, and match the directory name.
- `version` must be `x.y.z`, and must equal the pinned distribution version.
- `@latest` is rejected everywhere. Versions must be pinned.
- The npm package must already exist and be publicly resolvable.
- `icon.svg` must be exactly 16×16, square, and monochrome using `currentColor`.
  Hardcoded colours fail.
- Required: `id`, `name`, `version`, `description`, `distribution`. Optional but
  expected: `repository`, `website`, `authors`, `license`.

## Before you submit

Recommended, since the registry exposes this to everyone:

1. `npm test` — 199 unit tests.
2. `npm run e2e` — all five suites against real Kiro.
3. `npm run verify:registry` — must print `READY TO SUBMIT`.
4. Verify the terminal auth flow by hand: sign out with `kiro-cli logout`, then use
   Zed's sign-in affordance and confirm it recovers.
5. Ideally one run on Linux — the discovery paths are implemented but untested there.

Item 4 is the one that has not been exercised end-to-end, because it means signing out
of a working account.
