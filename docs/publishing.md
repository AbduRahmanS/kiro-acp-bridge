# Publishing to the ACP Registry

The ACP Registry is how ACP clients discover agents. Once listed, Zed users select
Kiro from a list instead of hand-editing `settings.json`, and Zed's agent block
becomes:

```json
{ "agent_servers": { "Kiro": { "type": "registry" } } }
```

**Published.** `kiro-acp-bridge@0.1.0` is live on npm:
<https://www.npmjs.com/package/kiro-acp-bridge>

**ACP Registry PR submitted:**
<https://github.com/agentclientprotocol/registry/pull/575>

Verified after publishing by installing the package from the registry into a clean
directory and driving the installed binary through a full ACP handshake against a
live `kiro-cli` — protocol v1 negotiated, terminal auth advertised, all three
selectors delivered, model switching applied, and the effort list correctly
refreshed to include `none` for a GPT model. That is a materially different test
from anything run against the dev tree: it exercises the artifact users actually
receive, so it catches packaging faults such as a file missing from the `files`
allowlist or a broken `bin` shebang.

## How 0.1.0 was actually published

Recorded because the path was not obvious and will be needed again if trusted
publishing is ever unavailable.

npm requires 2FA to publish. The account had 2FA disabled, and enabling it turned
out to be a dead end for CLI publishing: **npm has disabled new TOTP enrolments**,
so 2FA is now passkey/WebAuthn only — and the npm CLI cannot satisfy a passkey
challenge for `publish`, because its 2FA path is `--otp=` and there is no code to
supply. Upgrading npm from 10.9.8 to 12.0.2 made no difference; the limitation is
in the flow, not the version.

The documented answer for this configuration is a **granular access token with
"Bypass 2FA" enabled**. Two non-obvious constraints:

- The token must be scoped to **All packages**, not "Only select packages". A new
  package cannot be selected because it does not exist yet, and a narrowly-scoped
  token yields `E404` on publish — npm masks the permission failure as "not found"
  so it does not leak which packages exist.
- Verify the token before publishing with
  `npm whoami --userconfig <file>`. A wrong or truncated paste also produces
  `E404`, which is indistinguishable from the scope problem by symptom alone.

The token was passed via `--userconfig` pointing at a temporary file rather than a
CLI flag, so it never entered shell history or `ps` output, and was deleted
immediately afterwards. **Revoke it once trusted publishing is configured** — it
carries write access to every package on the account.

---

## The blocker that had to be solved first

The registry refuses to list an agent that cannot authenticate. Its CI runs:

```bash
python3 .github/workflows/verify_agents.py --auth-check
```

and requires `initialize` to return `authMethods` containing at least one method of
`type: "agent"` or `type: "terminal"`.

**Kiro's auth surface is state-dependent.** With a signed-in CLI, `initialize`
returns `authMethods: []`; the binary does contain a `kiro-login` method that it
advertises when authentication is required. So the bridge is not filling a total
void — but two gaps are real: a client must decide what to render from one
response without knowing the auth state, and `kiro-cli` may be absent entirely,
which is exactly the ACP Registry runner's condition since the bridge ships via
npx and does not bundle Kiro.

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
