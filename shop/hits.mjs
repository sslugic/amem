/**
 * First-party shop analytics (not local amem CLI/UI).
 * - Beacons (JS) → human_candidate traffic for visitor stats
 * - Raw HTTP logs → security / bot monitoring (separate store)
 * No raw IPs stored — hashed with a daily-rotating salt when needed for session keys.
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import geoip from "geoip-lite";
import { classifyNetwork } from "./net-class.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOCAL_BEACONS = join(ROOT, ".data", "beacons.jsonl");
const LOCAL_RAW = join(ROOT, ".data", "raw-requests.jsonl");
const LOCAL_NPM = join(ROOT, ".data", "npm-beacons.jsonl");
const RING_MAX = 400;

const BOT_UA_RE =
  /\b(bot|crawler|spider|crawl|curl|wget|python-requests|go-http-client|headless|scrapy|axios|java\/|libwww|httpclient|okhttp|scanner|nikto|sqlmap|masscan|zgrab|bytespider|semrush|ahrefs|petalbot|gptbot|claudebot|bingpreview)\b/i;

const ASSET_EXACT = new Set([
  "/favicon.ico",
  "/robots.txt",
  "/llms.txt",
  "/sitemap.xml",
  "/apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png",
]);

/**
 * @typedef {{
 *   ts: string,
 *   kind: "beacon" | "raw",
 *   path: string,
 *   status: number,
 *   method?: string,
 *   ref: string,
 *   ua: string,
 *   sid: string,
 *   cc?: string,
 *   city?: string,
 *   lat?: number | null,
 *   lon?: number | null,
 *   net?: "datacenter" | "residential" | "unknown",
 *   provider?: string,
 *   bot?: boolean,
 *   drop?: boolean,
 *   dropReason?: string,
 * }} Hit
 */

/**
 * @typedef {{
 *   ts: string,
 *   kind: "npm_install",
 *   path: string,
 *   event: string,
 *   package: string,
 *   version: string,
 *   node: string,
 *   platform: string,
 *   arch: string,
 *   ua: string,
 *   sid: string,
 *   bot: boolean,
 *   net?: "datacenter" | "residential" | "unknown",
 *   provider?: string,
 *   drop?: boolean,
 * }} NpmBeacon
 */

/** @type {Hit[]} */
const beaconRing = [];
/** @type {Hit[]} */
const rawRing = [];
/** @type {NpmBeacon[]} */
const npmRing = [];

let s3Client = null;
let s3Warned = false;

export function dayKey(iso = new Date().toISOString()) {
  return iso.slice(0, 10);
}

function uaHash(ua) {
  const raw = String(ua || "").slice(0, 512);
  if (!raw) return "";
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

function refererHost(ref) {
  const raw = String(ref || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).host.slice(0, 120);
  } catch {
    return raw.slice(0, 80);
  }
}

function isPrivateIp(ip) {
  const s = String(ip || "");
  if (!s || s === "::1" || s === "127.0.0.1") return true;
  if (s.startsWith("10.") || s.startsWith("192.168.") || s.startsWith("169.254.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(s)) return true;
  if (s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80:")) return true;
  return false;
}

export function clientIp(req) {
  const candidates = [
    ...String(req.headers?.["x-forwarded-for"] || "")
      .split(",")
      .map((p) => p.trim()),
    String(req.headers?.["x-real-ip"] || "").trim(),
    String(req.socket?.remoteAddress || "").trim(),
  ].filter(Boolean);
  for (const raw of candidates) {
    const ip = raw.replace(/^::ffff:/i, "");
    if (!isPrivateIp(ip)) return ip;
  }
  const fallback = String(candidates[0] || "").replace(/^::ffff:/i, "");
  return fallback || "";
}

export function lookupGeo(ip) {
  if (!ip || isPrivateIp(ip)) {
    return { cc: "", city: "", lat: null, lon: null };
  }
  try {
    const geo = geoip.lookup(ip);
    if (!geo) return { cc: "", city: "", lat: null, lon: null };
    const ll = Array.isArray(geo.ll) ? geo.ll : null;
    const lat = ll && Number.isFinite(ll[0]) ? Math.round(ll[0] * 10) / 10 : null;
    const lon = ll && Number.isFinite(ll[1]) ? Math.round(ll[1] * 10) / 10 : null;
    return {
      cc: String(geo.country || "")
        .toUpperCase()
        .slice(0, 2),
      city: String(geo.city || "").slice(0, 80),
      lat,
      lon,
    };
  } catch {
    return { cc: "", city: "", lat: null, lon: null };
  }
}

function dailySalt() {
  const secret =
    process.env.AMEM_HITS_SALT || process.env.AMEM_ADMIN_TOKEN || "amem-shop-hits-local";
  return createHash("sha256").update(`${secret}:${dayKey()}`).digest("hex").slice(0, 24);
}

/** Hashed session key — never stores raw IP. */
export function sessionKey(req, cookieOrBodySid = "") {
  const fromClient = String(cookieOrBodySid || "").trim();
  if (/^[a-zA-Z0-9_-]{8,80}$/.test(fromClient)) return fromClient.slice(0, 64);
  const ip = clientIp(req);
  const ua = String(req.headers?.["user-agent"] || "");
  return createHash("sha256")
    .update(`${dailySalt()}|${ip}|${ua}`)
    .digest("hex")
    .slice(0, 16);
}

export function isBotUa(ua) {
  const s = String(ua || "").trim();
  if (!s) return true;
  return BOT_UA_RE.test(s);
}

export function isAssetOrProbePath(pathname) {
  const p = String(pathname || "/");
  if (ASSET_EXACT.has(p)) return true;
  if (p.startsWith("/.well-known/")) return true;
  if (/\.(php|xml|env|git|asp|aspx|jsp|cgi|bak|sql|yml|yaml|ini|cfg|config)$/i.test(p)) {
    return true;
  }
  if (/\/(wp-admin|wp-login|wlwmanifest|xmlrpc|phpmyadmin|vendor\/phpunit)/i.test(p)) {
    return true;
  }
  return false;
}

/** Paths we never log even as raw (health noise / our own admin). */
export function shouldSkipLogging(pathname) {
  const p = String(pathname || "/");
  if (p === "/health" || p === "/webhook") return true;
  if (p === "/api/beacon" || p.startsWith("/api/beacon/")) return true;
  if (p === "/admin" || p.startsWith("/admin/") || p.startsWith("/public/")) return true;
  return false;
}

/**
 * Why a raw request should not count toward visitor metrics.
 * @returns {string} empty if it could count (still usually excluded unless beacon)
 */
export function rawDropReason(req, pathname, status, method) {
  const m = String(method || req.method || "GET").toUpperCase();
  if (m !== "GET" && m !== "HEAD") return "method";
  if (Number(status) === 404) return "404";
  if (isAssetOrProbePath(pathname)) return "asset";
  const ua = String(req.headers?.["user-agent"] || "");
  if (isBotUa(ua)) return "bot_ua";
  return "";
}

export function shouldRecordPath(pathname) {
  return !shouldSkipLogging(pathname);
}

function bumpRing(ring, hit) {
  ring.push(hit);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

function appendLocal(file, line) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, line, "utf8");
  } catch (err) {
    console.warn("[shop/hits] local append failed:", err instanceof Error ? err.message : err);
  }
}

async function getS3() {
  const bucket = String(process.env.AMEM_HITS_S3_BUCKET || "").trim();
  if (!bucket) return null;
  if (s3Client) return { client: s3Client, bucket };
  try {
    const { S3Client } = await import("@aws-sdk/client-s3");
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
    s3Client = new S3Client({ region });
    return { client: s3Client, bucket };
  } catch (err) {
    if (!s3Warned) {
      s3Warned = true;
      console.warn(
        "[shop/hits] AMEM_HITS_S3_BUCKET set but @aws-sdk/client-s3 unavailable:",
        err instanceof Error ? err.message : err,
      );
    }
    return null;
  }
}

async function appendS3(prefix, hit, line) {
  const s3 = await getS3();
  if (!s3) return;
  try {
    const { GetObjectCommand, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const key = `${prefix}/${dayKey(hit.ts)}.jsonl`;
    let existing = "";
    try {
      const got = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: key }));
      existing = await got.Body.transformToString();
    } catch (err) {
      const code = err && (err.name || err.Code || err.$metadata?.httpStatusCode);
      if (code !== "NoSuchKey" && code !== 404) throw err;
    }
    await s3.client.send(
      new PutObjectCommand({
        Bucket: s3.bucket,
        Key: key,
        Body: existing + line,
        ContentType: "application/x-ndjson",
      }),
    );
  } catch (err) {
    console.warn("[shop/hits] S3 append failed:", err instanceof Error ? err.message : err);
  }
}

function persist(hit, localFile, s3Prefix) {
  const line = `${JSON.stringify(hit)}\n`;
  if (!String(process.env.AMEM_HITS_S3_BUCKET || "").trim()) {
    appendLocal(localFile, line);
  } else {
    void appendS3(s3Prefix, hit, line);
  }
}

function normalizeHit(row) {
  return {
    ts: String(row.ts),
    kind: row.kind === "beacon" ? "beacon" : "raw",
    path: String(row.path || "/").slice(0, 200),
    status: Number(row.status) || 0,
    method: String(row.method || "").slice(0, 12),
    ref: String(row.ref || ""),
    ua: String(row.ua || ""),
    sid: String(row.sid || "").slice(0, 64),
    cc: String(row.cc || "")
      .toUpperCase()
      .slice(0, 2),
    city: String(row.city || "").slice(0, 80),
    lat: row.lat == null || row.lat === "" ? null : Number(row.lat),
    lon: row.lon == null || row.lon === "" ? null : Number(row.lon),
    net:
      row.net === "datacenter" || row.net === "residential" || row.net === "unknown"
        ? row.net
        : "unknown",
    provider: String(row.provider || "").slice(0, 40),
    bot: Boolean(row.bot),
    drop: Boolean(row.drop),
    dropReason: String(row.dropReason || ""),
  };
}

function enrichFromReq(req) {
  const ip = clientIp(req);
  const geo = lookupGeo(ip);
  const net = classifyNetwork(ip);
  return { ...geo, net: net.net, provider: net.provider };
}

/**
 * Server-side request log (security). Not used for headline visitor counts.
 * @param {import("node:http").IncomingMessage} req
 */
export function recordRawRequest(req, pathname, status, method) {
  if (shouldSkipLogging(pathname)) return;
  const uaRaw = String(req.headers?.["user-agent"] || "");
  const dropReason = rawDropReason(req, pathname, status, method);
  const enrich = enrichFromReq(req);
  const hit = normalizeHit({
    ts: new Date().toISOString(),
    kind: "raw",
    path: pathname,
    status,
    method: String(method || req.method || "GET").toUpperCase(),
    ref: refererHost(req.headers.referer || req.headers.referrer),
    ua: uaHash(uaRaw),
    sid: sessionKey(req),
    bot: Boolean(dropReason) || isBotUa(uaRaw),
    drop: Boolean(dropReason),
    dropReason,
    ...enrich,
  });
  bumpRing(rawRing, hit);
  persist(hit, LOCAL_RAW, "raw");
}

/** @deprecated use recordRawRequest — kept for older call sites */
export function recordHit(req, pathname, status) {
  recordRawRequest(req, pathname, status, req.method || "GET");
}

/**
 * Client beacon after DOM ready — primary human_candidate signal.
 * @param {import("node:http").IncomingMessage} req
 * @param {{ path?: string, ref?: string, sid?: string }} body
 */
export function recordBeacon(req, body = {}) {
  const pathname = String(body.path || "/").slice(0, 200);
  if (shouldSkipLogging(pathname) || pathname.startsWith("/admin")) return null;
  const uaRaw = String(req.headers?.["user-agent"] || "");
  // Beacons from obvious bots still get tagged, but browsers that run JS are rare for scanners.
  const enrich = enrichFromReq(req);
  const hit = normalizeHit({
    ts: new Date().toISOString(),
    kind: "beacon",
    path: pathname,
    status: 200,
    method: "BEACON",
    ref: refererHost(body.ref || req.headers.referer || ""),
    ua: uaHash(uaRaw),
    sid: sessionKey(req, body.sid),
    bot: isBotUa(uaRaw),
    drop: false,
    dropReason: "",
    ...enrich,
  });
  bumpRing(beaconRing, hit);
  persist(hit, LOCAL_BEACONS, "beacons");
  return hit;
}

/**
 * Anonymous npm install ping — no PII; IP used only for session hash + net class, never stored.
 * @param {import("node:http").IncomingMessage} req
 * @param {{ event?: string, package?: string, version?: string, node?: string, platform?: string, arch?: string, ts?: number }} body
 */
export function recordNpmInstall(req, body = {}) {
  const uaRaw = String(req.headers?.["user-agent"] || "");
  const enrich = enrichFromReq(req);
  const bot = isBotUa(uaRaw);
  const drop = bot || enrich.net === "datacenter";
  const clientTs = Number(body.ts);
  const ts =
    Number.isFinite(clientTs) && clientTs > 1e12
      ? new Date(clientTs).toISOString()
      : new Date().toISOString();
  /** @type {NpmBeacon} */
  const hit = {
    ts,
    kind: "npm_install",
    path: "/npm-install",
    event: "npm_install",
    package: String(body.package || "").slice(0, 120),
    version: String(body.version || "").slice(0, 40),
    node: String(body.node || "").slice(0, 32),
    platform: String(body.platform || "").slice(0, 32),
    arch: String(body.arch || "").slice(0, 32),
    ua: uaHash(uaRaw),
    sid: sessionKey(req),
    bot,
    net: enrich.net,
    provider: enrich.provider,
    drop,
  };
  bumpRing(npmRing, hit);
  persist(hit, LOCAL_NPM, "npm-beacons");
  return hit;
}

function parseNpmJsonl(text) {
  /** @type {NpmBeacon[]} */
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row.ts !== "string") continue;
      out.push({
        ts: String(row.ts),
        kind: "npm_install",
        path: "/npm-install",
        event: "npm_install",
        package: String(row.package || "").slice(0, 120),
        version: String(row.version || "").slice(0, 40),
        node: String(row.node || "").slice(0, 32),
        platform: String(row.platform || "").slice(0, 32),
        arch: String(row.arch || "").slice(0, 32),
        ua: String(row.ua || "").slice(0, 32),
        sid: String(row.sid || "").slice(0, 64),
        bot: Boolean(row.bot),
        net:
          row.net === "datacenter" || row.net === "residential" || row.net === "unknown"
            ? row.net
            : "unknown",
        provider: String(row.provider || "").slice(0, 40),
        drop: Boolean(row.drop),
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

function loadLocalNpm(file) {
  if (!existsSync(file)) return [];
  try {
    return parseNpmJsonl(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

async function loadS3NpmPrefix(days) {
  const s3 = await getS3();
  if (!s3) return [];
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  /** @type {NpmBeacon[]} */
  const out = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    const key = `npm-beacons/${d}.jsonl`;
    try {
      const got = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: key }));
      out.push(...parseNpmJsonl(await got.Body.transformToString()));
    } catch (err) {
      const code = err && (err.name || err.Code || err.$metadata?.httpStatusCode);
      if (code !== "NoSuchKey" && code !== 404) {
        console.warn("[shop/hits] S3 npm read failed:", err instanceof Error ? err.message : err);
      }
    }
  }
  return out;
}

function mergeNpm(durable, ring) {
  const byKey = new Map();
  for (const h of [...durable, ...ring]) {
    byKey.set(`${h.ts}|${h.sid}|${h.version}|${h.platform}|${h.arch}`, h);
  }
  return [...byKey.values()];
}

function isCountedNpm(h) {
  if (h.bot || h.drop) return false;
  if (h.net === "datacenter") return false;
  return true;
}

function rollupNpm(rows, days) {
  const cutoff = Date.now() - days * 86400000;
  const today = dayKey();
  const todaySids = new Set();
  const windowSids = new Set();
  let todayCount = 0;
  let windowCount = 0;
  for (const h of rows) {
    const t = Date.parse(h.ts);
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (!isCountedNpm(h)) continue;
    windowCount += 1;
    if (h.sid) windowSids.add(h.sid);
    else windowSids.add(`${h.ts}|${h.version}|${h.platform}`);
    if (dayKey(h.ts) === today) {
      todayCount += 1;
      if (h.sid) todaySids.add(h.sid);
      else todaySids.add(`${h.ts}|${h.version}|${h.platform}`);
    }
  }
  return {
    today: todaySids.size || todayCount,
    window: windowSids.size || windowCount,
    todayEvents: todayCount,
    windowEvents: windowCount,
  };
}

function parseJsonl(text) {
  /** @type {Hit[]} */
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.ts === "string" && typeof row.path === "string") {
        // Legacy rows (no kind) treated as raw page hits.
        if (!row.kind) row.kind = "raw";
        out.push(normalizeHit(row));
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

function loadLocal(file) {
  if (!existsSync(file)) return [];
  try {
    return parseJsonl(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

async function loadS3Prefix(prefix, days) {
  const s3 = await getS3();
  if (!s3) return [];
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  /** @type {Hit[]} */
  const out = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    const key = `${prefix}/${d}.jsonl`;
    try {
      const got = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: key }));
      out.push(...parseJsonl(await got.Body.transformToString()));
    } catch (err) {
      const code = err && (err.name || err.Code || err.$metadata?.httpStatusCode);
      if (code !== "NoSuchKey" && code !== 404) {
        console.warn("[shop/hits] S3 read failed:", err instanceof Error ? err.message : err);
      }
    }
  }
  // Legacy single-prefix hits/ still readable as raw for older days.
  if (prefix === "raw") {
    for (let i = 0; i < days; i++) {
      const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
      const key = `hits/${d}.jsonl`;
      try {
        const got = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: key }));
        out.push(...parseJsonl(await got.Body.transformToString()));
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

function mergeHits(durable, ring) {
  const byKey = new Map();
  for (const h of [...durable, ...ring]) {
    byKey.set(`${h.kind}|${h.ts}|${h.path}|${h.sid}|${h.status}`, h);
  }
  return [...byKey.values()];
}

function topCounted(map, limit) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function isHumanVisitor(h) {
  if (h.kind !== "beacon") return false;
  if (h.bot) return false;
  if (h.net === "datacenter") return false;
  return true;
}

function rollupBeacons(beacons, days) {
  const cutoff = Date.now() - days * 86400000;
  const today = dayKey();
  const todaySids = new Set();
  const windowSids = new Set();
  let todayViews = 0;
  let windowViews = 0;
  let dcViews = 0;
  /** @type {Map<string, number>} */
  const paths = new Map();
  /** @type {Map<string, number>} */
  const countries = new Map();
  /** @type {Map<string, number>} */
  const cities = new Map();
  /** @type {Map<string, { lat: number, lon: number, count: number, label: string, net: string }>} */
  const geoCells = new Map();

  for (const h of beacons) {
    const t = Date.parse(h.ts);
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (h.net === "datacenter") {
      dcViews += 1;
    }
    const human = isHumanVisitor(h);
    if (human) {
      windowViews += 1;
      if (h.sid) windowSids.add(h.sid);
      paths.set(h.path, (paths.get(h.path) || 0) + 1);
      if (h.cc) countries.set(h.cc, (countries.get(h.cc) || 0) + 1);
      if (h.city || h.cc) {
        const label = h.city && h.cc ? `${h.city}, ${h.cc}` : h.city || h.cc;
        cities.set(label, (cities.get(label) || 0) + 1);
      }
      if (dayKey(h.ts) === today) {
        todayViews += 1;
        if (h.sid) todaySids.add(h.sid);
      }
    }
    // Heat: human by default; datacenter included for muted layer
    if (
      (human || h.net === "datacenter") &&
      h.lat != null &&
      h.lon != null &&
      Number.isFinite(h.lat) &&
      Number.isFinite(h.lon)
    ) {
      const cell = `${h.lat},${h.lon},${h.net || "unknown"}`;
      const prev = geoCells.get(cell);
      if (prev) prev.count += 1;
      else {
        geoCells.set(cell, {
          lat: h.lat,
          lon: h.lon,
          count: 1,
          label: h.city && h.cc ? `${h.city}, ${h.cc}` : h.cc || cell,
          net: h.net || "unknown",
        });
      }
    }
  }

  return {
    today: { visitors: todaySids.size, pageviews: todayViews },
    window: { visitors: windowSids.size, pageviews: windowViews },
    windowDays: days,
    datacenterPageviews: dcViews,
    topPaths: topCounted(paths, 20).map(({ key, count }) => ({ path: key, count })),
    topCountries: topCounted(countries, 20).map(({ key, count }) => ({ country: key, count })),
    topCities: topCounted(cities, 20).map(({ key, count }) => ({ city: key, count })),
    heat: [...geoCells.values()].sort((a, b) => b.count - a.count).slice(0, 80),
    recent: [...beacons]
      .filter((h) => {
        const t = Date.parse(h.ts);
        return Number.isFinite(t) && t >= cutoff && isHumanVisitor(h);
      })
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
      .slice(0, 50),
  };
}

function rollupRaw(raw, days) {
  const cutoff = Date.now() - days * 86400000;
  let bots = 0;
  let total = 0;
  let kept = 0;
  /** @type {Map<string, number>} */
  const probed404 = new Map();
  /** @type {Map<string, number>} */
  const probeHits200 = new Map();
  /** @type {Map<string, number>} */
  const dropReasons = new Map();

  for (const h of raw) {
    const t = Date.parse(h.ts);
    if (!Number.isFinite(t) || t < cutoff) continue;
    total += 1;
    if (h.drop || h.bot) {
      bots += 1;
      if (h.dropReason) dropReasons.set(h.dropReason, (dropReasons.get(h.dropReason) || 0) + 1);
    } else {
      kept += 1;
    }
    if (h.status === 404) {
      probed404.set(h.path, (probed404.get(h.path) || 0) + 1);
    } else if (h.status === 200 && isAssetOrProbePath(h.path)) {
      // Probe-shaped path that succeeded — surface immediately on the security panel.
      probeHits200.set(h.path, (probeHits200.get(h.path) || 0) + 1);
    }
  }

  return {
    total,
    bots,
    kept,
    topProbed404: topCounted(probed404, 25).map(({ key, count }) => ({ path: key, count })),
    probeHits200: topCounted(probeHits200, 25).map(({ key, count }) => ({ path: key, count })),
    dropReasons: topCounted(dropReasons, 10).map(({ key, count }) => ({ reason: key, count })),
  };
}

function rollupUnfiltered(all, days) {
  const cutoff = Date.now() - days * 86400000;
  const today = dayKey();
  let todayViews = 0;
  let windowViews = 0;
  const todaySids = new Set();
  const windowSids = new Set();
  for (const h of all) {
    const t = Date.parse(h.ts);
    if (!Number.isFinite(t) || t < cutoff) continue;
    windowViews += 1;
    if (h.sid) windowSids.add(h.sid);
    if (dayKey(h.ts) === today) {
      todayViews += 1;
      if (h.sid) todaySids.add(h.sid);
    }
  }
  return {
    today: { views: todayViews, uniques: todaySids.size },
    window: { views: windowViews, uniques: windowSids.size },
  };
}

/**
 * @param {{ days?: number }} [opts]
 */
export async function getHitStats(opts = {}) {
  const days = Math.min(30, Math.max(1, Number(opts.days) || 7));
  const bucket = String(process.env.AMEM_HITS_S3_BUCKET || "").trim();

  let durableBeacons = [];
  let durableRaw = [];
  let durableNpm = [];
  if (bucket) {
    durableBeacons = await loadS3Prefix("beacons", days);
    durableRaw = await loadS3Prefix("raw", days);
    durableNpm = await loadS3NpmPrefix(days);
  } else {
    durableBeacons = loadLocal(LOCAL_BEACONS);
    durableRaw = [...loadLocal(LOCAL_RAW), ...loadLocal(join(ROOT, ".data", "hits.jsonl"))];
    durableNpm = loadLocalNpm(LOCAL_NPM);
  }

  const beacons = mergeHits(durableBeacons, beaconRing);
  const raw = mergeHits(durableRaw, rawRing);
  const npm = mergeNpm(durableNpm, npmRing);
  const human = rollupBeacons(beacons, days);
  const security = rollupRaw(raw, days);
  const npmStats = rollupNpm(npm, days);
  const unfiltered = rollupUnfiltered([...beacons, ...raw], days);

  return {
    today: human.today,
    window: human.window,
    windowDays: days,
    pageviews: { today: human.today.pageviews, window: human.window.pageviews },
    visitors: { today: human.today.visitors, window: human.window.visitors },
    npmInstalls: { today: npmStats.today, window: npmStats.window },
    bots: { window: security.bots, totalRaw: security.total },
    datacenterPageviews: human.datacenterPageviews,
    topPaths: human.topPaths,
    topCountries: human.topCountries,
    topCities: human.topCities,
    heat: human.heat,
    recent: human.recent,
    security: {
      topProbed404: security.topProbed404,
      probeHits200: security.probeHits200,
      dropReasons: security.dropReasons,
    },
    unfiltered,
    storage: bucket
      ? `s3:${bucket} (beacons/ + raw/ + npm-beacons/)`
      : existsSync(LOCAL_BEACONS) || existsSync(LOCAL_RAW) || existsSync(LOCAL_NPM)
        ? "local:.data/{beacons,raw-requests,npm-beacons}.jsonl"
        : "memory",
    processStartedAt: process.env.AMEM_SHOP_STARTED_AT || null,
    note: "Visitors = JS beacons, deduped by session, excluding datacenter/bots. NPM installs = postinstall pings (filtered). Raw requests kept for security.",
  };
}

/** Tiny browser snippet — fires after DOM ready. */
export function beaconScript() {
  return `<script>
(function(){
  function vid(){
    try{
      var k="amem_vid";
      var v=localStorage.getItem(k);
      if(!v){
        v=(crypto.randomUUID&&crypto.randomUUID())||("v"+Date.now().toString(36)+Math.random().toString(36).slice(2));
        localStorage.setItem(k,v);
      }
      return v;
    }catch(e){return "";}
  }
  function fire(){
    var body=JSON.stringify({path:location.pathname,ref:document.referrer||"",sid:vid()});
    try{
      if(navigator.sendBeacon){
        navigator.sendBeacon("/api/beacon",new Blob([body],{type:"application/json"}));
        return;
      }
    }catch(e){}
    try{
      fetch("/api/beacon",{method:"POST",headers:{"Content-Type":"application/json"},body:body,keepalive:true,credentials:"same-origin"});
    }catch(e){}
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",fire);
  else fire();
})();
</script>`;
}

/** @internal */
export function _resetHitsForTests() {
  beaconRing.length = 0;
  rawRing.length = 0;
  npmRing.length = 0;
  s3Client = null;
  s3Warned = false;
  for (const file of [
    LOCAL_BEACONS,
    LOCAL_RAW,
    LOCAL_NPM,
    join(ROOT, ".data", "hits.jsonl"),
  ]) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

export function newVisitorId() {
  return randomBytes(12).toString("hex");
}
