import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const POSTINSTALL = join(import.meta.dirname, "..", "scripts", "postinstall.js");

function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of ["NODE_TEST_CONTEXT", "CI", "NODE_ENV", "AMEM_TELEMETRY_DISABLED", "DO_NOT_TRACK", "AMEM_POLICY_PATH", "AMEM_SYSTEM_POLICY"]) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

async function withCollector(fn) {
  const pings = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      pings.push({ path: req.url, body: JSON.parse(body) });
      res.writeHead(204).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/api/beacon/usage`;
  try {
    await fn(url, pings);
  } finally {
    server.close();
  }
}

async function waitFor(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

test("fresh install with default policy sends nothing, from the CLI or from postinstall", async () => {
  await withCollector(async (url, pings) => {
    const home = mkdtempSync(join(tmpdir(), "amem-tel-"));
    const env = cleanEnv({ AMEM_HOME: home, AMEM_TELEMETRY_URL: url, AMEM_INSTALL_PING_URL: url });
    spawnSync(process.execPath, [POSTINSTALL], { env, timeout: 30000 });
    for (const args of [["platforms"], ["setup"], ["context", "anything"], ["mcp", "--print-config"]]) {
      spawnSync(process.execPath, [CLI, ...args], { env, input: "", timeout: 15000 });
    }
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(pings.length, 0, "opt-in: no network call without `amem telemetry on`");
    const status = spawnSync(process.execPath, [CLI, "telemetry", "status"], { env, encoding: "utf8" }).stdout;
    assert.match(status, /telemetry: off \(opt-in:/);
    const attest = JSON.parse(spawnSync(process.execPath, [CLI, "doctor", "--attest", "--json"], { env, encoding: "utf8" }).stdout);
    assert.equal(attest.privacy.telemetry, false);
    assert.equal(attest.privacy.network_egress, "none");
  });
});

test("`amem telemetry on` sets policy.telemetry and every report agrees; postinstall follows it", async () => {
  await withCollector(async (url, pings) => {
    const home = mkdtempSync(join(tmpdir(), "amem-tel-"));
    const env = cleanEnv({ AMEM_HOME: home, AMEM_TELEMETRY_URL: url, AMEM_INSTALL_PING_URL: url });
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
    assert.match(run("telemetry", "on").stdout, /telemetry: on/);
    assert.match(readFileSync(join(home, "policy.toml"), "utf8"), /^telemetry = true$/m);
    const attest = JSON.parse(run("doctor", "--attest", "--json").stdout);
    assert.equal(attest.privacy.telemetry, true);
    assert.equal(attest.privacy.usage_ping.enabled, true);

    const install = spawnSync(process.execPath, [POSTINSTALL], { env, timeout: 30000, encoding: "utf8" });
    assert.equal(install.status, 0, `postinstall: ${install.stderr}`);
    assert.ok(await waitFor(() => pings.some((p) => p.body.event === "npm_install"), 15000), "install ping once opted in");
    assert.equal(pings.filter((p) => p.body.event === "npm_install").length, 1);
    // The CLI runs above already sent their first-run ping; start the daily checks clean.
    await new Promise((r) => setTimeout(r, 500));
    rmSync(join(home, "telemetry.json"), { force: true });
    pings.length = 0;
    await runDailyPingChecks(run, home, pings);
  });
});

async function runDailyPingChecks(run, home, pings) {
  run("platforms");
  assert.ok(await waitFor(() => pings.length === 1), "first-run ping arrives");
  const first = pings[0].body;
  assert.equal(first.event, "first_run");
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(first.features, { cli: 1 });
  assert.deepEqual(Object.keys(first).sort(), ["arch", "event", "features", "firstSeen", "id", "node", "platform", "version"]);

  run("platforms");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(pings.length, 1, "no second ping the same day");
  const state = JSON.parse(readFileSync(join(home, "telemetry.json"), "utf8"));
  assert.deepEqual(state.pending, { cli: 1 });

  // Next day: the pending count goes out with the daily ping.
  writeFileSync(join(home, "telemetry.json"), JSON.stringify({ ...state, lastPing: "2000-01-01" }));
  run("platforms");
  assert.ok(await waitFor(() => pings.length === 2));
  assert.equal(pings[1].body.event, "active");
  assert.equal(pings[1].body.id, first.id);
  assert.deepEqual(pings[1].body.features, { cli: 2 });

  assert.match(run("telemetry", "off").stdout, /telemetry: off/);
  assert.match(readFileSync(join(home, "policy.toml"), "utf8"), /^telemetry = false$/m);
  writeFileSync(join(home, "telemetry.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(home, "telemetry.json"), "utf8")), lastPing: "2000-01-01" }));
  run("platforms");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(pings.length, 2, "off means no ping");
}

test("usage ping never runs under a managed policy or DO_NOT_TRACK, even when opted in", async () => {
  await withCollector(async (url, pings) => {
    const policy = join(mkdtempSync(join(tmpdir(), "amem-pol-")), "policy.toml");
    writeFileSync(policy, "allow_export = true\n");
    for (const extra of [{ AMEM_POLICY_PATH: policy }, { DO_NOT_TRACK: "1" }]) {
      const home = mkdtempSync(join(tmpdir(), "amem-tel-"));
      writeFileSync(join(home, "policy.toml"), "telemetry = true\n");
      const env = cleanEnv({ AMEM_HOME: home, AMEM_TELEMETRY_URL: url, AMEM_INSTALL_PING_URL: url, ...extra });
      spawnSync(process.execPath, [CLI, "platforms"], { env });
      spawnSync(process.execPath, [POSTINSTALL], { env, timeout: 30000 });
      const status = spawnSync(process.execPath, [CLI, "telemetry"], { env, encoding: "utf8" }).stdout;
      assert.match(status, /telemetry: off/);
      assert.equal(existsSync(join(home, "telemetry.json")), false);
    }
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(pings.length, 0);
  });
});
