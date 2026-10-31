import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");

function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of ["NODE_TEST_CONTEXT", "CI", "NODE_ENV", "AMEM_TELEMETRY_DISABLED", "DO_NOT_TRACK", "AMEM_POLICY_PATH"]) {
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

test("usage ping: first run once, then once a day, never memory content; off switch works", async () => {
  await withCollector(async (url, pings) => {
    const home = mkdtempSync(join(tmpdir(), "amem-tel-"));
    const env = cleanEnv({ AMEM_HOME: home, AMEM_TELEMETRY_URL: url });
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });

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
    writeFileSync(join(home, "telemetry.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(home, "telemetry.json"), "utf8")), lastPing: "2000-01-01" }));
    run("platforms");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(pings.length, 2, "off means no ping");
  });
});

test("usage ping never runs under a managed policy or DO_NOT_TRACK", async () => {
  await withCollector(async (url, pings) => {
    const policy = join(mkdtempSync(join(tmpdir(), "amem-pol-")), "policy.toml");
    writeFileSync(policy, "allow_export = true\n");
    for (const extra of [{ AMEM_POLICY_PATH: policy }, { DO_NOT_TRACK: "1" }]) {
      const home = mkdtempSync(join(tmpdir(), "amem-tel-"));
      const env = cleanEnv({ AMEM_HOME: home, AMEM_TELEMETRY_URL: url, ...extra });
      spawnSync(process.execPath, [CLI, "platforms"], { env });
      const status = spawnSync(process.execPath, [CLI, "telemetry"], { env, encoding: "utf8" }).stdout;
      assert.match(status, /telemetry: off/);
      assert.equal(existsSync(join(home, "telemetry.json")), false);
    }
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(pings.length, 0);
  });
});
