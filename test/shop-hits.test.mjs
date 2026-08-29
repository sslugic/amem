import assert from "node:assert/strict";
import test from "node:test";
import {
  _resetHitsForTests,
  clientIp,
  getHitStats,
  isAssetOrProbePath,
  isBotUa,
  lookupGeo,
  rawDropReason,
  recordBeacon,
  recordNpmInstall,
  recordRawRequest,
  shouldRecordPath,
} from "../shop/hits.mjs";
import { classifyNetwork } from "../shop/net-class.mjs";

test("shouldRecordPath skips health webhook admin public beacon", () => {
  assert.equal(shouldRecordPath("/"), true);
  assert.equal(shouldRecordPath("/pricing"), true);
  assert.equal(shouldRecordPath("/what"), true);
  assert.equal(shouldRecordPath("/health"), false);
  assert.equal(shouldRecordPath("/webhook"), false);
  assert.equal(shouldRecordPath("/api/beacon"), false);
  assert.equal(shouldRecordPath("/api/beacon/npm-install"), false);
  assert.equal(shouldRecordPath("/admin"), false);
  assert.equal(shouldRecordPath("/admin/api/stats"), false);
  assert.equal(shouldRecordPath("/public/logo.png"), false);
});

test("isBotUa and asset/probe paths", () => {
  assert.equal(isBotUa(""), true);
  assert.equal(isBotUa("curl/8.0"), true);
  assert.equal(isBotUa("Mozilla/5.0 Chrome/120"), false);
  assert.equal(isAssetOrProbePath("/favicon.ico"), true);
  assert.equal(isAssetOrProbePath("/.well-known/security.txt"), true);
  assert.equal(isAssetOrProbePath("/wp-admin/install.php"), true);
  assert.equal(isAssetOrProbePath("/wlwmanifest.xml"), true);
  assert.equal(isAssetOrProbePath("/pricing"), false);
});

test("rawDropReason filters scanners", () => {
  const browser = {
    method: "GET",
    headers: { "user-agent": "Mozilla/5.0 Safari/605" },
  };
  assert.equal(rawDropReason(browser, "/", 200, "GET"), "");
  assert.equal(rawDropReason(browser, "/", 404, "GET"), "404");
  assert.equal(rawDropReason(browser, "/robots.txt", 200, "GET"), "asset");
  assert.equal(rawDropReason({ ...browser, method: "POST" }, "/", 200, "POST"), "method");
  assert.equal(
    rawDropReason({ headers: { "user-agent": "python-requests/2.28" } }, "/", 200, "GET"),
    "bot_ua",
  );
});

test("classifyNetwork tags major cloud CIDRs as datacenter", () => {
  const aws = classifyNetwork("18.236.1.1");
  assert.equal(aws.net, "datacenter");
  assert.equal(aws.provider, "aws");
  const docean = classifyNetwork("167.99.1.1");
  assert.equal(docean.net, "datacenter");
  assert.equal(docean.provider, "digitalocean");
});

test("clientIp prefers first public X-Forwarded-For hop", () => {
  assert.equal(
    clientIp({
      headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.1" },
      socket: { remoteAddress: "127.0.0.1" },
    }),
    "203.0.113.10",
  );
});

test("lookupGeo returns country for public IP and never echoes IP", () => {
  const geo = lookupGeo("8.8.8.8");
  assert.equal(geo.cc, "US");
  assert.ok(geo.lat == null || Number.isFinite(geo.lat));
  assert.ok(geo.lon == null || Number.isFinite(geo.lon));
  assert.equal(JSON.stringify(geo).includes("8.8.8.8"), false);
  const local = lookupGeo("127.0.0.1");
  assert.equal(local.cc, "");
});

test("beacons drive visitors; raw bots and probes do not", async () => {
  _resetHitsForTests();
  delete process.env.AMEM_HITS_S3_BUCKET;
  const prev = process.env.AMEM_SHOP_STARTED_AT;
  process.env.AMEM_SHOP_STARTED_AT = "2026-01-01T00:00:00.000Z";

  const human = {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh) Chrome/120.0",
      referer: "https://news.ycombinator.com/item?id=1",
      "x-forwarded-for": "203.0.113.50",
    },
    method: "GET",
  };
  const bot = {
    headers: {
      "user-agent": "curl/8.4.0",
      "x-forwarded-for": "18.236.1.1",
    },
    method: "GET",
  };

  recordBeacon(human, { path: "/", ref: "https://news.ycombinator.com/", sid: "sess_human_1" });
  recordBeacon(human, { path: "/pricing", ref: "", sid: "sess_human_1" });
  recordBeacon(bot, { path: "/", sid: "sess_bot" });

  recordRawRequest(bot, "/wp-admin/install.php", 404, "GET");
  recordRawRequest(human, "/favicon.ico", 200, "GET");
  recordRawRequest(bot, "/", 200, "GET");

  const stats = await getHitStats({ days: 7 });
  assert.equal(stats.visitors.today, 1);
  assert.equal(stats.pageviews.today, 2);
  assert.ok(stats.bots.window >= 1);
  assert.ok(stats.security.topProbed404.some((p) => p.path.includes("wp-admin")));
  assert.ok(stats.topPaths.some((p) => p.path === "/" && p.count >= 1));
  assert.ok(stats.recent.every((r) => r.kind === "beacon" || r.path));
  assert.ok(!JSON.stringify(stats).includes("203.0.113.50"));
  assert.ok(!JSON.stringify(stats).includes("18.236.1.1"));

  if (prev == null) delete process.env.AMEM_SHOP_STARTED_AT;
  else process.env.AMEM_SHOP_STARTED_AT = prev;
  _resetHitsForTests();
});

test("datacenter beacons excluded from visitors but appear on heat", async () => {
  _resetHitsForTests();
  delete process.env.AMEM_HITS_S3_BUCKET;

  const dcReq = {
    headers: {
      "user-agent": "Mozilla/5.0 Chrome/120",
      "x-forwarded-for": "18.236.1.1",
    },
  };
  recordBeacon(dcReq, { path: "/", sid: "dc_sess" });
  const stats = await getHitStats({ days: 7 });
  assert.equal(stats.visitors.window, 0);
  assert.ok(stats.datacenterPageviews >= 1);
  _resetHitsForTests();
});

test("npm install beacons roll up with bot/dc filter and session dedupe", async () => {
  _resetHitsForTests();
  delete process.env.AMEM_HITS_S3_BUCKET;

  const human = {
    headers: {
      "user-agent": "amem-postinstall/@iamem/amem@0.1.1",
      "x-forwarded-for": "203.0.113.88",
    },
  };
  const dc = {
    headers: {
      "user-agent": "amem-postinstall/@iamem/amem@0.1.1",
      "x-forwarded-for": "18.236.1.1",
    },
  };
  const body = {
    event: "npm_install",
    package: "@iamem/amem",
    version: "0.1.1",
    node: "v22.0.0",
    platform: "darwin",
    arch: "arm64",
    ts: Date.now(),
  };
  recordNpmInstall(human, body);
  recordNpmInstall(human, body);
  recordNpmInstall(dc, body);
  const stats = await getHitStats({ days: 7 });
  assert.equal(stats.npmInstalls.window, 1);
  assert.ok(!JSON.stringify(stats).includes("203.0.113.88"));
  _resetHitsForTests();
});
