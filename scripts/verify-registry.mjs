#!/usr/bin/env node
/**
 * Pre-submission check for the ACP Registry.
 *
 * Reproduces locally what the registry's CI enforces, so a PR is not opened
 * only to fail validation:
 *
 *   1. `initialize` returns `authMethods` with at least one `agent` or
 *      `terminal` method  (registry AUTHENTICATION.md)
 *   2. that holds even WITHOUT kiro-cli present, because the CI runner will not
 *      have Kiro installed
 *   3. the declared terminal-auth args actually work
 *   4. agent.json satisfies the documented required fields and rules
 *   5. icon.svg is 16x16, square, and monochrome via currentColor
 */
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ENTRY = "registry/kiro-acp-bridge";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** Runs one `initialize` against the bridge and returns the parsed response. */
function initializeOnce(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/index.js"], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => (out += c));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          // The registry's verifier advertises terminal auth, as Zed does.
          clientCapabilities: { fs: {}, terminal: true, auth: { terminal: true } },
          clientInfo: { name: "acp-registry-verifier", version: "1.0.0" },
        },
      }) + "\n",
    );
    setTimeout(() => {
      child.kill("SIGKILL");
      try {
        resolve(JSON.parse(out.trim().split("\n")[0] ?? "{}"));
      } catch {
        resolve({});
      }
    }, 6000);
  });
}

console.log("=== 1. authMethods with Kiro installed ===");
{
  const res = await initializeOnce({
    KIRO_DATA_DIR: "/tmp/kiro-registry-check/datadir",
    KIRO_DISABLE_TELEMETRY: "1",
  });
  const methods = res.result?.authMethods ?? [];
  console.log(`  authMethods: ${JSON.stringify(methods)}`);
  check("initialize succeeded", !!res.result, JSON.stringify(res.error?.code));
  check("authMethods is non-empty", methods.length > 0, `count=${methods.length}`);
  check(
    "at least one method is type agent or terminal",
    methods.some((m) => m.type === "agent" || m.type === "terminal"),
    JSON.stringify(methods.map((m) => m.type)),
  );
  check("terminal method declares args", Array.isArray(methods.find((m) => m.type === "terminal")?.args));
}

console.log("\n=== 2. authMethods WITHOUT kiro-cli (the CI environment) ===");
{
  // The registry CI installs via npx on a clean runner; kiro-cli will not exist.
  // initialize must still complete and still advertise an auth method.
  const res = await initializeOnce({ KIRO_CLI_PATH: "/nonexistent/kiro-cli", PATH: "" });
  const methods = res.result?.authMethods ?? [];
  console.log(`  authMethods: ${JSON.stringify(methods)}`);
  check("initialize still succeeds (degraded, not rejected)", !!res.result,
    JSON.stringify(res.error?.code));
  check("authMethods still advertised", methods.length > 0, `count=${methods.length}`);
  check("still offers agent or terminal",
    methods.some((m) => m.type === "agent" || m.type === "terminal"));
  check("capabilities reported conservatively",
    res.result?.agentCapabilities?.loadSession === false,
    JSON.stringify(res.result?.agentCapabilities?.loadSession));
}

console.log("\n=== 3. the declared terminal-auth args work ===");
{
  const { stderr } = await execFileAsync(
    process.execPath,
    ["dist/index.js", "--login", "--help"],
    { env: { ...process.env }, timeout: 30000 },
  ).catch((e) => ({ stderr: e.stderr ?? String(e) }));
  check("--login reaches kiro-cli login", /kiro-cli login/.test(stderr),
    JSON.stringify(stderr.slice(0, 120)));

  const missing = await execFileAsync(
    process.execPath,
    ["dist/index.js", "--login"],
    { env: { ...process.env, KIRO_CLI_PATH: "/nonexistent/kiro-cli", PATH: "" }, timeout: 20000 },
  ).catch((e) => ({ code: e.code, stderr: e.stderr ?? "" }));
  check("--login without kiro-cli exits 127 with guidance",
    missing.code === 127 && /Kiro CLI was not found/.test(missing.stderr),
    `code=${missing.code}`);
}

console.log("\n=== 4. agent.json ===");
{
  const j = JSON.parse(readFileSync(`${ENTRY}/agent.json`, "utf8"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));

  for (const f of ["id", "name", "version", "description", "distribution"]) {
    check(`required field '${f}' present`, j[f] !== undefined);
  }
  check("id is lowercase letters/digits/hyphens starting with a letter",
    /^[a-z][a-z0-9-]*$/.test(j.id), j.id);
  check("id matches the directory name", ENTRY.endsWith(`/${j.id}`), j.id);
  check("version is semver x.y.z", /^\d+\.\d+\.\d+$/.test(j.version), j.version);
  check("version matches package.json", j.version === pkg.version, `${j.version} vs ${pkg.version}`);
  check("at least one distribution method", Object.keys(j.distribution ?? {}).length > 0);

  const npx = j.distribution?.npx;
  check("npx distribution declares a package", typeof npx?.package === "string", npx?.package);
  check("npx package is version-pinned, not @latest",
    !!npx?.package && npx.package.includes("@") && !npx.package.includes("@latest"), npx?.package);
  check("npx package version matches the entry version",
    npx?.package?.endsWith(`@${j.version}`), npx?.package);
  check("npx package name matches package.json name",
    npx?.package?.startsWith(pkg.name), `${npx?.package} vs ${pkg.name}`);
  check("license is an SPDX identifier", j.license === pkg.license, `${j.license} vs ${pkg.license}`);

  // Placeholders must not reach a PR.
  const raw = readFileSync(`${ENTRY}/agent.json`, "utf8");
  check("no REPLACE_ME placeholders remain", !raw.includes("REPLACE_ME"),
    raw.includes("REPLACE_ME") ? "still contains REPLACE_ME" : "");
}

console.log("\n=== 5. icon.svg ===");
{
  const svg = readFileSync(`${ENTRY}/icon.svg`, "utf8");
  const w = /width="(\d+)"/.exec(svg)?.[1];
  const h = /height="(\d+)"/.exec(svg)?.[1];
  check("declares width and height", !!w && !!h, `${w}x${h}`);
  check("is exactly 16x16", w === "16" && h === "16", `${w}x${h}`);
  check("is square", w === h);
  check("has a viewBox", /viewBox="0 0 16 16"/.test(svg));

  const fills = [...svg.matchAll(/fill="([^"]*)"/g)].map((m) => m[1]);
  const strokes = [...svg.matchAll(/stroke="([^"]*)"/g)].map((m) => m[1]);
  const allowed = new Set(["currentColor", "none", "inherit"]);
  check("all fills are currentColor/none/inherit", fills.every((f) => allowed.has(f)),
    JSON.stringify(fills));
  check("all strokes are currentColor/none/inherit", strokes.every((s) => allowed.has(s)),
    JSON.stringify(strokes));
  check("no hardcoded colours", !/#[0-9a-fA-F]{3,8}\b|rgb\(|\bred\b|\bblue\b/.test(svg));
}

console.log(`\n${failures === 0 ? "READY TO SUBMIT" : `${failures} CHECK(S) FAILED — do not submit yet`}`);
process.exit(failures === 0 ? 0 : 1);
