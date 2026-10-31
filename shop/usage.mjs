/**
 * Product usage analytics for the admin page:
 * - CLI usage pings (src/telemetry.ts): random install id, version, OS, features run.
 *   No IPs stored — only country and network class derived at receive time.
 * - npm registry download counts (public api.npmjs.org, cached for an hour).
 */
import { appendRecord, clientIp, dayKey, isBotUa, localRecordFile, lookupGeo, readRecords } from "./hits.mjs";
import { classifyNetwork } from "./net-class.mjs";
import { existsSync, unlinkSync } from "node:fs";

const PREFIX = "usage-beacons";
const RING_MAX = 2000;
const FEATURES = ["mcp", "hook", "ui", "cli", "setup"];
const ID_RE = /^[a-zA-Z0-9-]{16,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {{
 *   ts: string,
 *   kind: "usage",
 *   event: "first_run" | "active",
 *   id: string,
 *   version: string,
 *   node: string,
 *   platform: string,
 *   arch: string,
 *   firstSeen: string,
 *   features: Record<string, number>,
 *   cc: string,
 *   net: string,
 *   bot: boolean,
 * }} UsageRow
 */

/** @type {UsageRow[]} */
const ring = [];

function clip(v, n) {
  return String(v ?? "").slice(0, n);
}

function cleanFeatures(raw) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of FEATURES) {
    const n = Math.floor(Number(raw[key]));
    if (Number.isFinite(n) && n > 0) out[key] = Math.min(n, 100000);
  }
  return out;
}

/** @returns {UsageRow | null} */
function normalize(row) {
  if (!row || typeof row !== "object") return null;
  const event = row.event === "first_run" || row.event === "active" ? row.event : null;
  const id = String(row.id || "");
  if (!event || !ID_RE.test(id) || typeof row.ts !== "string") return null;
  return {
    ts: row.ts,
    kind: "usage",
    event,
    id,
    version: clip(row.version, 40),
    node: clip(row.node, 32),
    platform: clip(row.platform, 32),
    arch: clip(row.arch, 32),
    firstSeen: DAY_RE.test(String(row.firstSeen || "")) ? String(row.firstSeen) : dayKey(row.ts),
    features: cleanFeatures(row.features),
    cc: clip(row.cc, 2).toUpperCase(),
    net: row.net === "datacenter" || row.net === "residential" ? row.net : "unknown",
    bot: Boolean(row.bot),
  };
}

/**
 * Record one CLI usage ping. Returns null (and stores nothing) for malformed bodies.
 * @param {import("node:http").IncomingMessage} req
 */
export function recordUsage(req, body = {}) {
  const ip = clientIp(req);
  const row = normalize({
    ...body,
    ts: new Date().toISOString(),
    cc: lookupGeo(ip).cc,
    net: classifyNetwork(ip).net,
    bot: isBotUa(String(req.headers?.["user-agent"] || "")),
  });
  if (!row) return null;
  ring.push(row);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  appendRecord(PREFIX, row);
  return row;
}

function count(map, key, by = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + by);
}

function top(map, limit = 12) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, n]) => ({ key, count: n }));
}

function daysBack(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  return out;
}

/**
 * Rollup of usage pings. Installs are counted by install id, so one machine is one install.
 * @param {UsageRow[]} rows
 * @param {number} days
 */
export function rollupUsage(rows, days) {
  const today = dayKey();
  const series = daysBack(days);
  const windowStart = series[0];
  const d7 = daysBack(7)[0];
  const d30 = daysBack(30)[0];
  const sorted = rows.filter((r) => !r.bot).sort((a, b) => a.ts.localeCompare(b.ts));

  const activeToday = new Set();
  const active7 = new Set();
  const active30 = new Set();
  const activeWindow = new Set();
  const newWindow = new Set();
  const newToday = new Set();
  /** @type {Map<string, Set<string>>} */
  const activeByDay = new Map(series.map((d) => [d, new Set()]));
  /** @type {Map<string, Set<string>>} */
  const newByDay = new Map(series.map((d) => [d, new Set()]));
  /** @type {Map<string, UsageRow>} latest row per id in window */
  const latest = new Map();
  /** @type {Map<string, Set<string>>} feature -> ids */
  const featureUsers = new Map(FEATURES.map((f) => [f, new Set()]));
  const featureRuns = new Map();

  for (const r of sorted) {
    const day = dayKey(r.ts);
    if (day >= d30) active30.add(r.id);
    if (day >= d7) active7.add(r.id);
    if (day === today) activeToday.add(r.id);
    if (day < windowStart) continue;
    activeWindow.add(r.id);
    activeByDay.get(day)?.add(r.id);
    latest.set(r.id, r);
    if (r.event === "first_run") {
      newWindow.add(r.id);
      newByDay.get(day)?.add(r.id);
      if (day === today) newToday.add(r.id);
    }
    for (const [f, n] of Object.entries(r.features)) {
      featureUsers.get(f)?.add(r.id);
      count(featureRuns, f, n);
    }
  }

  const versions = new Map();
  const platforms = new Map();
  const nodes = new Map();
  const countries = new Map();
  let returning = 0;
  let datacenter = 0;
  for (const r of latest.values()) {
    count(versions, r.version || "?");
    count(platforms, [r.platform, r.arch].filter(Boolean).join("/") || "?");
    const major = r.node.match(/^v?(\d+)/)?.[1];
    count(nodes, major ? `Node ${major}` : "?");
    count(countries, r.cc || "??");
    if (r.firstSeen < windowStart) returning += 1;
    if (r.net === "datacenter") datacenter += 1;
  }

  return {
    windowDays: days,
    active: { today: activeToday.size, d7: active7.size, d30: active30.size, window: activeWindow.size },
    newInstalls: { today: newToday.size, window: newWindow.size },
    returning,
    datacenter,
    daily: series.map((d) => ({ day: d, active: activeByDay.get(d).size, new: newByDay.get(d).size })),
    features: FEATURES.map((f) => ({
      feature: f,
      installs: featureUsers.get(f).size,
      runs: featureRuns.get(f) || 0,
    })),
    versions: top(versions).map(({ key, count: n }) => ({ version: key, count: n })),
    platforms: top(platforms).map(({ key, count: n }) => ({ platform: key, count: n })),
    nodes: top(nodes).map(({ key, count: n }) => ({ node: key, count: n })),
    countries: top(countries, 15).map(({ key, count: n }) => ({ country: key, count: n })),
  };
}

/** @param {{ days?: number }} [opts] */
export async function getUsageStats(opts = {}) {
  const days = Math.min(30, Math.max(1, Number(opts.days) || 7));
  const durable = (await readRecords(PREFIX, 30)).map(normalize).filter(Boolean);
  const byKey = new Map();
  for (const r of [...durable, ...ring]) byKey.set(`${r.ts}|${r.id}|${r.event}`, r);
  return rollupUsage([...byKey.values()], days);
}

const NPM_TTL_MS = 60 * 60 * 1000;
/** @type {{ at: number, value: unknown } | null} */
let npmCache = null;

/**
 * Daily downloads for the last 30 days from the public npm API (includes CI and mirrors).
 * @param {{ fetchImpl?: typeof fetch, pkg?: string }} [opts]
 */
export async function getNpmDownloads(opts = {}) {
  if (npmCache && Date.now() - npmCache.at < NPM_TTL_MS && !opts.fetchImpl) return npmCache.value;
  const pkg = opts.pkg || process.env.AMEM_NPM_PACKAGE || "@iamem/amem";
  const fetchImpl = opts.fetchImpl || fetch;
  try {
    const res = await fetchImpl(`https://api.npmjs.org/downloads/range/last-month/${pkg}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`npm API ${res.status}`);
    const data = await res.json();
    const daily = (Array.isArray(data.downloads) ? data.downloads : []).map((d) => ({
      day: String(d.day),
      downloads: Number(d.downloads) || 0,
    }));
    const sum = (rows) => rows.reduce((n, d) => n + d.downloads, 0);
    const value = { package: pkg, d7: sum(daily.slice(-7)), d30: sum(daily), daily };
    npmCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    return { package: pkg, error: err instanceof Error ? err.message : String(err) };
  }
}

/** @internal */
export function _resetUsageForTests() {
  ring.length = 0;
  npmCache = null;
  const file = localRecordFile(PREFIX);
  if (existsSync(file)) unlinkSync(file);
}
