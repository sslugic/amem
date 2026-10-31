import assert from "node:assert/strict";
import test from "node:test";
import { _resetHitsForTests } from "../shop/hits.mjs";
import { _resetUsageForTests, getNpmDownloads, getUsageStats, recordUsage, rollupUsage } from "../shop/usage.mjs";

const req = (ip, ua = "amem-cli") => ({ headers: { "user-agent": ua, "x-forwarded-for": ip } });
const ping = (over = {}) => ({
  event: "active",
  id: "11111111-2222-4333-8444-555555555555",
  version: "0.7.4",
  node: "v22.3.0",
  platform: "darwin",
  arch: "arm64",
  firstSeen: "2026-01-01",
  features: { hook: 12, mcp: 3 },
  ...over,
});

test("usage pings roll up per install id, by feature, version and platform", async () => {
  delete process.env.AMEM_HITS_S3_BUCKET;
  _resetHitsForTests();
  _resetUsageForTests();
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(recordUsage(req("203.0.113.9"), ping()));
  assert.ok(recordUsage(req("203.0.113.9"), ping({ features: { hook: 4 } })));
  assert.ok(
    recordUsage(
      req("198.51.100.7"),
      ping({ event: "first_run", id: "aaaaaaaa-2222-4333-8444-555555555555", version: "0.7.3", platform: "linux", arch: "x64", firstSeen: today, features: { cli: 1 } }),
    ),
  );
  assert.equal(recordUsage(req("203.0.113.9"), ping({ id: "bad id" })), null);
  assert.equal(recordUsage(req("203.0.113.9"), ping({ event: "other" })), null);
  recordUsage(req("203.0.113.10", "curl/8"), ping({ id: "bbbbbbbb-2222-4333-8444-555555555555" }));

  const stats = await getUsageStats({ days: 7 });
  assert.equal(stats.active.today, 2);
  assert.equal(stats.active.d30, 2);
  assert.equal(stats.newInstalls.window, 1);
  assert.equal(stats.returning, 1);
  assert.deepEqual(
    stats.features.filter((f) => f.installs).map((f) => [f.feature, f.installs, f.runs]),
    [["mcp", 1, 3], ["hook", 1, 16], ["cli", 1, 1]],
  );
  assert.deepEqual(stats.versions.map((v) => v.version).sort(), ["0.7.3", "0.7.4"]);
  assert.ok(stats.platforms.some((p) => p.platform === "linux/x64"));
  assert.equal(stats.daily.length, 7);
  assert.equal(stats.daily.at(-1).active, 2);
  assert.ok(!JSON.stringify(stats).includes("203.0.113.9"));
  _resetUsageForTests();
});

test("rollupUsage keeps installs outside the window out of window counts", () => {
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  const rows = [{ ts: old, kind: "usage", event: "first_run", id: "x".repeat(20), version: "1", node: "v20", platform: "darwin", arch: "arm64", firstSeen: old.slice(0, 10), features: {}, cc: "", net: "unknown", bot: false }];
  const s = rollupUsage(rows, 7);
  assert.equal(s.active.window, 0);
  assert.equal(s.active.d30, 1);
  assert.equal(s.newInstalls.window, 0);
});

test("getNpmDownloads sums the registry range and reports errors", async () => {
  _resetUsageForTests();
  const downloads = Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, downloads: i < 23 ? 1 : 10 }));
  const ok = await getNpmDownloads({ fetchImpl: async () => ({ ok: true, json: async () => ({ downloads }) }) });
  assert.equal(ok.d30, 23 + 70);
  assert.equal(ok.d7, 70);
  const bad = await getNpmDownloads({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.match(bad.error, /503/);
});
