#!/usr/bin/env node
/**
 * Seller webhook + Checkout. Not part of the published `amem` CLI.
 * Memory never leaves the buyer’s machine — this process only emails a signed JSON file.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { applyShopEnv, loadShopEnvFromText, parseDotEnv, pickShopEnv } from "./env.mjs";
import {
  buyerEmail,
  issuedLicensePath,
  licenseEmailCopy,
  licensePayload,
  normalizeTier,
  readIssuedLicense,
  rememberFulfilled,
  sessionIdOk,
  sessionPaid,
  TIERS,
  writeIssuedLicense,
} from "./fulfill.mjs";
import { getHitStats, recordBeacon, recordNpmInstall, recordRawRequest, beaconScript } from "./hits.mjs";
import { getSalesStats } from "./sales.mjs";
import { sendLicenseMail } from "./mail.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, "..");
const DATA = join(ROOT, ".data");
const FULFILLED = join(DATA, "fulfilled.json");
const LICENSES = join(DATA, "licenses");
const PRIV_FILE = join(DATA, "license.priv");
const SHOP_DOTENV = join(ROOT, ".env");

hydrateEnv();
process.env.AMEM_SHOP_STARTED_AT ||= new Date().toISOString();

const PORT = Number(process.env.AMEM_SHOP_PORT || 8788);
/** Loopback for local seller process; App Runner / containers use 0.0.0.0 */
const HOST = process.env.AMEM_SHOP_HOST || "127.0.0.1";
const PUBLIC_URL = (process.env.AMEM_SHOP_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const CANONICAL_HOST = (process.env.AMEM_SHOP_CANONICAL_HOST || "").toLowerCase().replace(/:\d+$/, "");
const ADMIN_COOKIE = "amem_admin";

function hydrateEnv() {
  if (existsSync(SHOP_DOTENV)) {
    loadShopEnvFromText(readFileSync(SHOP_DOTENV, "utf8"), process.env, { overwrite: false });
  }
  const external = process.env.AMEM_SHOP_ENV;
  if (external && existsSync(external)) {
    applyShopEnv(pickShopEnv(parseDotEnv(readFileSync(external, "utf8"))), process.env, {
      overwrite: false,
    });
  }
}

function decodeMaybeB64Pem(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.includes("BEGIN")) return s;
  // App Runner rejects multiline env values — store PEM as base64 in Secrets Manager.
  try {
    const decoded = Buffer.from(s.replace(/\s+/g, ""), "base64").toString("utf8").trim();
    if (decoded.includes("BEGIN")) return decoded;
  } catch {
    /* keep raw */
  }
  return s;
}

function licensePrivKey() {
  if (process.env.AMEM_LICENSE_PRIVKEY) return decodeMaybeB64Pem(process.env.AMEM_LICENSE_PRIVKEY);
  if (existsSync(PRIV_FILE)) return readFileSync(PRIV_FILE, "utf8").trim();
  return "";
}

async function licenseFns() {
  return import(join(REPO, "dist", "license.js"));
}

function siteChrome(_active, body, title = "amem — get started") {
  return htmlPage(
    title,
    `<div class="shell">
  <header class="top">
    <a class="brand" href="/">amem</a>
  </header>
  ${body}
</div>
${cmdScript()}`,
  );
}

function htmlPage(title, body) {
  const track = !String(title || "").toLowerCase().includes("admin");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
:root{
  --bg0:#0b0f12;--bg1:#141b21;--bg2:#1a232b;--ink:#e8eef2;--muted:#8fa3b0;
  --accent:#2ec4b6;--accent-dim:#1a7a72;--line:rgba(232,238,242,.1);--claim:#7eb8ff;
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;color:var(--ink);
  font:15px/1.45 "IBM Plex Sans",system-ui,sans-serif;
  background:var(--bg0)}
body{
  background:
    radial-gradient(900px 480px at 12% -8%,rgba(46,196,182,.14),transparent 55%),
    radial-gradient(700px 420px at 88% 0%,rgba(126,184,255,.08),transparent 50%),
    var(--bg0)}
.shell{min-height:100vh;display:flex;flex-direction:column}
.top{display:flex;align-items:center;justify-content:space-between;gap:1rem;
  padding:.85rem 1.5rem;border-bottom:1px solid var(--line);
  background:rgba(11,15,18,.88);backdrop-filter:blur(10px);position:sticky;top:0;z-index:5}
.brand{color:var(--ink);text-decoration:none;font-weight:700;font-size:1.15rem;letter-spacing:-.03em}
.nav{display:flex;align-items:center;gap:.35rem}
.nav-tab{color:var(--muted);text-decoration:none;font-size:.88rem;font-weight:500;
  padding:.4rem .85rem;border-radius:999px;border:1px solid transparent}
.nav-tab:hover{color:var(--ink)}
.nav-tab.active{color:var(--ink);border-color:rgba(126,184,255,.55);background:rgba(126,184,255,.08)}
.hero{position:relative;flex:1;display:grid;align-items:center;min-height:calc(100vh - 3.4rem);
  padding:2rem 1.25rem 2.5rem;overflow:hidden}
.hero-art{position:absolute;inset:0;pointer-events:none}
.hero-art img{width:100%;height:100%;object-fit:cover;object-position:center 28%;
  opacity:.42;filter:saturate(1.05) contrast(1.05)}
.hero-art::after{content:"";position:absolute;inset:0;
  background:
    linear-gradient(180deg,rgba(11,15,18,.55) 0%,rgba(11,15,18,.78) 42%,rgba(11,15,18,.94) 100%),
    radial-gradient(ellipse 70% 55% at 50% 40%,transparent 20%,rgba(11,15,18,.75) 100%)}
.hero-panel{position:relative;z-index:1;width:min(560px,100%);margin:0 auto;
  padding:1.6rem 1.45rem 1.5rem;border:1px solid var(--line);border-radius:18px;
  background:rgba(20,27,33,.78);backdrop-filter:blur(14px);
  box-shadow:0 24px 80px rgba(0,0,0,.45)}
.hero-kicker{margin:0 0 .35rem;color:var(--accent);font-size:.78rem;font-weight:600;
  letter-spacing:.08em;text-transform:uppercase}
.hero-brand{margin:0 0 .55rem;font-size:clamp(2.4rem,7vw,3.4rem);font-weight:700;
  letter-spacing:-.05em;line-height:1}
.hero h1{margin:0 0 .45rem;font-size:clamp(1.35rem,3.5vw,1.7rem);font-weight:600;letter-spacing:-.02em}
.hero-lead{margin:0 0 1.15rem;color:var(--muted);font-size:.95rem;max-width:28rem}
.cmd-box{border:1px solid var(--line);border-radius:14px;background:rgba(11,15,18,.72);overflow:hidden}
.cmd-tabs{display:flex;gap:.3rem;padding:.5rem .55rem;border-bottom:1px solid var(--line)}
.cmd-tab{appearance:none;border:1px solid transparent;background:transparent;color:var(--muted);
  font:inherit;font-size:.8rem;font-weight:500;padding:.35rem .7rem;border-radius:999px;cursor:pointer}
.cmd-tab.active{color:var(--ink);border-color:var(--line);background:var(--bg2)}
.cmd-row{display:flex;align-items:center;gap:.75rem;padding:.8rem .95rem}
.cmd-row code{flex:1;min-width:0;font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;
  font-size:.9rem;letter-spacing:.01em;overflow:auto;white-space:nowrap}
.cmd-panel{display:none}
.cmd-panel.active{display:block}
.cmd-hint{margin:.75rem 0 0;color:var(--muted);font-size:.8rem}
.cmd-hint a{color:var(--accent)}
a.btn,button.btn{appearance:none;display:block;width:100%;text-align:center;text-decoration:none;border:0;cursor:pointer;
  background:var(--accent);color:#062925;font:inherit;font-weight:600;padding:.85rem 1.2rem;border-radius:999px}
a.btn.secondary,button.btn.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
button.btn.compact{width:auto;padding:.5rem .9rem;font-size:.82rem;flex-shrink:0}
.copied{color:#062925 !important;background:var(--accent) !important;border-color:transparent !important}
.plans-wrap{max-width:920px;margin:0 auto;padding:2rem 1.25rem 3rem;width:100%}
.plans-wrap h1{margin:0 0 .4rem;font-size:1.65rem;letter-spacing:-.02em}
.plans-lead{margin:0 0 1.25rem;color:var(--muted);max-width:36rem}
.plan-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.85rem;margin:0 0 1rem}
.plan-card{display:flex;flex-direction:column;gap:.65rem;padding:1.15rem;
  border:1px solid var(--line);border-radius:16px;background:rgba(20,27,33,.85);min-width:0}
.plan-card.featured{border-color:rgba(46,196,182,.45)}
.plan-card h2{margin:0;font-size:1.05rem}
.plan-price{margin:0;font-size:1.85rem;font-weight:700;letter-spacing:-.03em}
.plan-price span{font-size:.8rem;color:var(--muted);font-weight:500}
.plan-card ul{margin:0 0 .4rem;padding:0 0 0 1.1rem;color:var(--muted);font-size:.88rem;line-height:1.45;flex:1}
.plan-card li+li{margin-top:.35rem}
.fine{margin:0;color:var(--muted);font-size:.82rem}
.note{margin:0;color:var(--muted);font-size:.88rem}
code,pre{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:.86em}
code{background:transparent;padding:0}
pre{background:rgba(232,238,242,.06);border:1px solid var(--line);border-radius:12px;padding:1rem 1.1rem;overflow:auto}
.page{max-width:640px;margin:0 auto;padding:2.5rem 1.25rem}
.page h1{margin:0 0 .75rem}
.page p{color:var(--muted);max-width:36rem}
.page .actions{display:flex;flex-wrap:wrap;gap:.6rem;margin:1.25rem 0}
.page a.btn{width:auto;display:inline-block}
.page .brand-row{display:flex;align-items:center;gap:.75rem;margin:0 0 .75rem}
.page .brand-row .mark{width:2.5rem;height:2.5rem;border-radius:.75rem;display:grid;place-items:center;
  background:linear-gradient(160deg,var(--accent),var(--accent-dim));color:#062925;font-weight:700}
@media(max-width:800px){
  .plan-grid{grid-template-columns:1fr}
  .cmd-row{flex-wrap:wrap}
  .hero{padding:1.5rem 1rem 2rem;align-items:end}
  .hero-art img{object-position:center 18%;opacity:.35}
}
.admin-wrap{max-width:960px;margin:0 auto;padding:2rem 1.25rem 3rem;width:100%}
.admin-wrap h1{margin:0 0 .35rem;font-size:1.5rem;letter-spacing:-.02em}
.admin-meta{margin:0 0 1.25rem;color:var(--muted);font-size:.85rem}
.admin-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:.75rem;margin:0 0 1.25rem}
.admin-grid.sales{grid-template-columns:repeat(4,minmax(0,1fr));margin-top:0}
.admin-stat{padding:1rem;border:1px solid var(--line);border-radius:14px;background:rgba(20,27,33,.85)}
.admin-stat.muted{opacity:.72}
.admin-stat .k{margin:0;color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.06em}
.admin-stat .v{margin:.25rem 0 0;font-size:1.6rem;font-weight:700;letter-spacing:-.03em}
.admin-table{width:100%;border-collapse:collapse;font-size:.85rem}
.admin-table th,.admin-table td{text-align:left;padding:.45rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
.admin-table th{color:var(--muted);font-weight:500}
.admin-login{max-width:360px;margin:4rem auto;padding:1.5rem;border:1px solid var(--line);border-radius:16px;background:rgba(20,27,33,.85)}
.admin-login label{display:block;margin:0 0 .35rem;color:var(--muted);font-size:.85rem}
.admin-login input{width:100%;margin:0 0 1rem;padding:.65rem .75rem;border-radius:10px;border:1px solid var(--line);
  background:rgba(11,15,18,.8);color:var(--ink);font:inherit}
.admin-split{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin:0 0 1.5rem}
.admin-heat{border:1px solid var(--line);border-radius:16px;background:#0b0f12 url("/public/world-land.svg") center / 100% 100% no-repeat;padding:0;overflow:hidden;min-height:220px}
.admin-heat svg{display:block;width:100%;height:auto}
.admin-bars{margin:0;padding:0;list-style:none}
.admin-bars li{display:grid;grid-template-columns:minmax(4.5rem,9rem) 1fr 2.5rem;gap:.5rem;align-items:center;margin:0 0 .4rem;font-size:.82rem}
.admin-bars .bar{height:.55rem;border-radius:999px;background:rgba(46,196,182,.15);overflow:hidden}
.admin-bars .bar > i{display:block;height:100%;background:var(--accent);border-radius:999px}
.admin-bars .n{color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
.admin-toggle{display:flex;align-items:center;gap:.55rem;margin:0 0 1rem;color:var(--muted);font-size:.85rem}
.admin-toggle input{accent-color:var(--accent)}
.admin-sec{margin:1.5rem 0 0;padding:1rem 1.1rem;border:1px solid var(--line);border-radius:14px;background:rgba(20,27,33,.55)}
.admin-sec h2{margin:0 0 .35rem;font-size:1.05rem}
.admin-sec .warn{color:#f0b429;font-size:.82rem;margin:0 0 .75rem}
@media(max-width:800px){
  .admin-grid,.admin-grid.sales{grid-template-columns:1fr 1fr}
  .admin-split{grid-template-columns:1fr}
}
</style></head><body>${body}${track ? beaconScript() : ""}</body></html>`;
}

function adminTokenConfigured() {
  return Boolean(String(process.env.AMEM_ADMIN_TOKEN || "").trim());
}

function tokensEqual(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (!left.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parseCookies(req) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function adminAuthorized(req, url) {
  const want = String(process.env.AMEM_ADMIN_TOKEN || "").trim();
  if (!want) return false;
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ") && tokensEqual(auth.slice(7).trim(), want)) {
    return true;
  }
  const q = url.searchParams.get("token");
  if (q && tokensEqual(q, want)) return true;
  const cookie = parseCookies(req)[ADMIN_COOKIE];
  if (cookie && tokensEqual(cookie, want)) return true;
  return false;
}

function setAdminCookie(res, token) {
  const secure = PUBLIC_URL.startsWith("https") ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/admin; HttpOnly; SameSite=Strict${secure}; Max-Age=2592000`,
  );
}

function adminLoginPage(message = "") {
  return htmlPage(
    "amem admin",
    `<div class="admin-login">
  <p class="hero-kicker">Seller only</p>
  <h1 style="margin:0 0 .75rem;font-size:1.35rem">Admin</h1>
  ${message ? `<p class="note" style="margin:0 0 .75rem">${message}</p>` : ""}
  <form method="get" action="/admin">
    <label for="token">Access token</label>
    <input id="token" name="token" type="password" autocomplete="current-password" required/>
    <button class="btn" type="submit">Open dashboard</button>
  </form>
</div>`,
  );
}

function adminDashboardPage() {
  return htmlPage(
    "amem admin",
    `<div class="admin-wrap">
  <h1>Shop analytics</h1>
  <p class="admin-meta" id="meta">Loading…</p>
  <label class="admin-toggle"><input type="checkbox" id="show-raw"/> Show unfiltered (includes bots / scanners / datacenter)</label>
  <div class="admin-grid">
    <div class="admin-stat"><p class="k">Visitors today</p><p class="v" id="vis-today">—</p></div>
    <div class="admin-stat"><p class="k">Visitors 7-day</p><p class="v" id="vis-win">—</p></div>
    <div class="admin-stat"><p class="k">Pageviews 7-day</p><p class="v" id="pv-win">—</p></div>
    <div class="admin-stat"><p class="k">NPM installs 7-day</p><p class="v" id="npm-win">—</p></div>
    <div class="admin-stat muted"><p class="k">Bot / scanner (7d)</p><p class="v" id="bots-win">—</p></div>
  </div>
  <h2 style="font-size:1.05rem;margin:0 0 .5rem">Sales (Stripe)</h2>
  <p class="admin-meta" id="sales-meta" style="margin-top:-.35rem">Paid Checkout · Pro / IT</p>
  <div class="admin-grid sales">
    <div class="admin-stat"><p class="k">Pro (all-time)</p><p class="v" id="pro-all">—</p></div>
    <div class="admin-stat"><p class="k">IT (all-time)</p><p class="v" id="it-all">—</p></div>
    <div class="admin-stat"><p class="k">Pro (7-day)</p><p class="v" id="pro-win">—</p></div>
    <div class="admin-stat"><p class="k">IT (7-day)</p><p class="v" id="it-win">—</p></div>
  </div>
  <p class="admin-meta" id="raw-line" style="display:none"></p>
  <h2 style="font-size:1.05rem;margin:0 0 .5rem">Where visitors are</h2>
  <p class="admin-meta" style="margin-top:-.35rem">JS beacons only · datacenter muted · no raw IPs stored</p>
  <div class="admin-heat" aria-label="Visitor heat map">
    <svg id="heat-map" viewBox="0 0 720 360" role="img">
      <title>Visitor locations</title>
      <g id="heat-dots"></g>
      <g id="heat-labels" font-family="IBM Plex Sans, system-ui, sans-serif" font-size="11" fill="#e8eef2"></g>
    </svg>
  </div>
  <div class="admin-split">
    <div>
      <h2 style="font-size:1.05rem;margin:1rem 0 .5rem">Top countries</h2>
      <ul class="admin-bars" id="countries"></ul>
    </div>
    <div>
      <h2 style="font-size:1.05rem;margin:1rem 0 .5rem">Top cities</h2>
      <ul class="admin-bars" id="cities"></ul>
    </div>
  </div>
  <h2 style="font-size:1.05rem;margin:0 0 .5rem">Top paths</h2>
  <table class="admin-table" id="paths"><thead><tr><th>Path</th><th>Hits</th></tr></thead><tbody></tbody></table>
  <h2 style="font-size:1.05rem;margin:1.5rem 0 .5rem">Recent humans</h2>
  <table class="admin-table" id="recent"><thead><tr><th>Time</th><th>Path</th><th>Where</th><th>Net</th><th>Ref</th></tr></thead><tbody></tbody></table>
  <div class="admin-sec">
    <h2>Security — top 404 probes</h2>
    <p class="warn" id="probe-200-warn" style="display:none"></p>
    <p class="warn">If any of these ever return 200, investigate immediately.</p>
    <table class="admin-table" id="probes"><thead><tr><th>Path</th><th>Count</th></tr></thead><tbody></tbody></table>
  </div>
</div>
<script>
(async () => {
  const esc = (s) => String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const res = await fetch("/admin/api/stats", { credentials: "same-origin" });
  if (!res.ok) {
    document.getElementById("meta").textContent = "Unauthorized or stats unavailable (" + res.status + ").";
    return;
  }
  const data = await res.json();
  document.getElementById("meta").textContent =
    "Storage: " + (data.storage || "?") + " · " + (data.note || "");
  document.getElementById("vis-today").textContent = String(data.visitors?.today ?? data.today?.visitors ?? 0);
  document.getElementById("vis-win").textContent = String(data.visitors?.window ?? data.window?.visitors ?? 0);
  document.getElementById("pv-win").textContent = String(data.pageviews?.window ?? data.window?.pageviews ?? 0);
  document.getElementById("npm-win").textContent = String(data.npmInstalls?.window ?? 0);
  document.getElementById("bots-win").textContent = String(data.bots?.window ?? 0);
  const sales = data.sales || {};
  document.getElementById("pro-all").textContent = String(sales.pro?.all ?? "—");
  document.getElementById("it-all").textContent = String(sales.it?.all ?? "—");
  document.getElementById("pro-win").textContent = String(sales.pro?.window ?? "—");
  document.getElementById("it-win").textContent = String(sales.it?.window ?? "—");
  document.getElementById("sales-meta").textContent =
    (sales.note || "Paid Checkout · Pro / IT") +
    (sales.source ? " · source: " + sales.source : "");
  const rawLine = document.getElementById("raw-line");
  const uf = data.unfiltered;
  if (uf) {
    rawLine.textContent =
      "Unfiltered raw: today " + (uf.today?.views ?? 0) + " hits / " + (uf.today?.uniques ?? 0) +
      " uniques · 7d " + (uf.window?.views ?? 0) + " / " + (uf.window?.uniques ?? 0);
  }

  function fillBars(id, rows, labelKey) {
    const el = document.getElementById(id);
    el.innerHTML = "";
    const max = Math.max(1, ...rows.map((r) => r.count || 0));
    if (!rows.length) {
      el.innerHTML = '<li><span style="color:var(--muted)">None yet</span></li>';
      return;
    }
    for (const row of rows) {
      const li = document.createElement("li");
      const pct = Math.round((row.count / max) * 100);
      li.innerHTML =
        "<span>" + esc(row[labelKey]) + '</span><span class="bar"><i style="width:' + pct + '%"></i></span><span class="n">' + row.count + "</span>";
      el.appendChild(li);
    }
  }
  fillBars("countries", data.topCountries || [], "country");
  fillBars("cities", data.topCities || [], "city");

  const dots = document.getElementById("heat-dots");
  const labels = document.getElementById("heat-labels");
  function renderHeat(showDc) {
    dots.innerHTML = "";
    labels.innerHTML = "";
    const heat = (data.heat || []).filter((p) => showDc || p.net !== "datacenter");
    const maxH = Math.max(1, ...heat.map((h) => h.count));
    for (const p of heat) {
      const x = ((Number(p.lon) + 180) / 360) * 720;
      const y = ((90 - Number(p.lat)) / 180) * 360;
      const r = 5 + Math.sqrt(p.count / maxH) * 16;
      const dc = p.net === "datacenter";
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", String(x));
      c.setAttribute("cy", String(y));
      c.setAttribute("r", String(r));
      c.setAttribute("fill", dc ? "rgba(143,163,176," + (0.2 + 0.35 * (p.count / maxH)).toFixed(2) + ")" : "rgba(46,196,182," + (0.35 + 0.5 * (p.count / maxH)).toFixed(2) + ")");
      c.setAttribute("stroke", dc ? "#8fa3b0" : "#2ec4b6");
      c.setAttribute("stroke-width", "1.25");
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = (p.label || "") + " · " + p.count + (dc ? " · datacenter" : "");
      c.appendChild(title);
      dots.appendChild(c);
    }
    for (const p of heat.filter((h) => h.net !== "datacenter").slice(0, 12)) {
      const x = ((Number(p.lon) + 180) / 360) * 720;
      const y = ((90 - Number(p.lat)) / 180) * 360;
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(x + 8));
      text.setAttribute("y", String(y - 8));
      text.setAttribute("paint-order", "stroke");
      text.setAttribute("stroke", "rgba(11,15,18,.85)");
      text.setAttribute("stroke-width", "3");
      text.textContent = (p.label || "") + " (" + p.count + ")";
      labels.appendChild(text);
    }
    if (!heat.length) {
      const empty = document.createElementNS("http://www.w3.org/2000/svg", "text");
      empty.setAttribute("x", "360");
      empty.setAttribute("y", "180");
      empty.setAttribute("text-anchor", "middle");
      empty.setAttribute("fill", "#8fa3b0");
      empty.setAttribute("font-size", "14");
      empty.textContent = "No beacon locations yet — open the public site in a browser";
      labels.appendChild(empty);
    }
  }
  const toggle = document.getElementById("show-raw");
  renderHeat(false);
  toggle.addEventListener("change", () => {
    rawLine.style.display = toggle.checked ? "block" : "none";
    renderHeat(toggle.checked);
  });

  const paths = document.querySelector("#paths tbody");
  for (const row of data.topPaths || []) {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td><code>" + esc(row.path) + "</code></td><td>" + row.count + "</td>";
    paths.appendChild(tr);
  }
  const recent = document.querySelector("#recent tbody");
  for (const row of data.recent || []) {
    const where = row.city && row.cc ? row.city + ", " + row.cc : row.cc || row.city || "—";
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + esc(row.ts) + "</td><td><code>" + esc(row.path) + "</code></td><td>" + esc(where) +
      "</td><td>" + esc(row.net || "—") + "</td><td>" + esc(row.ref || "—") + "</td>";
    recent.appendChild(tr);
  }
  const probes = document.querySelector("#probes tbody");
  const probeRows = data.security?.topProbed404 || [];
  if (!probeRows.length) {
    probes.innerHTML = '<tr><td colspan="2" style="color:var(--muted)">No 404 probes in window</td></tr>';
  } else {
    for (const row of probeRows) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td><code>" + esc(row.path) + "</code></td><td>" + row.count + "</td>";
      probes.appendChild(tr);
    }
  }
  const hit200 = data.security?.probeHits200 || [];
  if (hit200.length) {
    const warn = document.getElementById("probe-200-warn");
    warn.style.display = "block";
    warn.textContent =
      "ALERT: probe-shaped paths returned 200: " +
      hit200.map((r) => r.path + " (" + r.count + ")").join(", ");
  }
})();
</script>`,
  );
}


function cmdScript() {
  return `<script>
(() => {
  const tabs = [...document.querySelectorAll(".cmd-tab")];
  const panels = [...document.querySelectorAll(".cmd-panel")];
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const id = tab.dataset.cmd;
      tabs.forEach((t) => {
        const on = t === tab;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      panels.forEach((p) => p.classList.toggle("active", p.dataset.panel === id));
    });
  });
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const el = document.getElementById(btn.dataset.copy);
      const text = (el?.textContent || "").trim();
      try {
        await navigator.clipboard.writeText(text);
        const prev = btn.textContent;
        btn.textContent = "Copied";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = prev;
          btn.classList.remove("copied");
        }, 1400);
      } catch {
        btn.textContent = "Select & copy";
      }
    });
  });
})();
</script>`;
}

function installCommands() {
  return `<div class="cmd-box">
  <div class="cmd-tabs" role="tablist">
    <button type="button" class="cmd-tab active" data-cmd="npx" role="tab" aria-selected="true">Quick (npx)</button>
    <button type="button" class="cmd-tab" data-cmd="global" role="tab" aria-selected="false">Global CLI</button>
  </div>
  <div class="cmd-panel active" data-panel="npx">
    <div class="cmd-row">
      <code id="cmd-npx">npx @iamem/amem setup</code>
      <button type="button" class="btn compact" data-copy="cmd-npx">Copy</button>
    </div>
  </div>
  <div class="cmd-panel" data-panel="global">
    <div class="cmd-row">
      <code id="cmd-global">npm i -g @iamem/amem &amp;&amp; amem setup</code>
      <button type="button" class="btn compact" data-copy="cmd-global">Copy</button>
    </div>
  </div>
</div>
<p class="cmd-hint">Node 20+. Then run <code>amem ui</code> — upgrade to Pro there when you want it. Source on <a href="https://github.com/sslugic/amem">GitHub</a>.</p>`;
}

function dollars(cents) {
  return `$${(Number(cents) / 100).toFixed(0)}`;
}

function landing() {
  return siteChrome(
    "start",
    `<main class="hero">
  <div class="hero-art" aria-hidden="true">
    <img src="/public/amem-ui.png" alt="" width="1600" height="1000"/>
  </div>
  <div class="hero-panel">
    <p class="hero-kicker">Local agent memory</p>
    <p class="hero-brand">amem</p>
    <h1>Everything is free</h1>
    <p class="hero-lead">Memory, skills, tasks, and the desktop app — all of it. Facts stay in <code>~/.amem</code> on your machine. One command, then open the UI.</p>
    ${installCommands()}
  </div>
</main>`,
  );
}

function pricingPage() {
  const pro = dollars(amountFor("pro"));
  const it = dollars(amountFor("it"));
  return siteChrome(
    "pricing",
    `<main class="plans-wrap">
  <h1>Free · Pro · IT</h1>
  <p class="plans-lead">Free already remembers. Pro is the agent upgrade (better local ranking + cleanup + rules sync). IT is paperwork for security/DevEx — not “more IQ.” Memory never leaves the laptop.</p>
  <div class="plan-grid">
    <article class="plan-card">
      <h2>Free</h2>
      <p class="plan-price">$0</p>
      <ul>
        <li>Memory UI, MCP, Stats</li>
        <li>Lock + local backup</li>
        <li>Hash embedder (no download)</li>
        <li>IT pack folder (unsigned templates)</li>
      </ul>
      <a class="btn secondary" href="/">Get started</a>
    </article>
    <article class="plan-card featured">
      <h2>Pro</h2>
      <p class="plan-price">${pro} <span>once</span></p>
      <ul>
        <li>Everything in Free</li>
        <li>Local n-gram / external embedder</li>
        <li>Hygiene apply + weekly schedule</li>
        <li>Pin facts → Cursor rules</li>
      </ul>
      <a class="btn" href="/buy/pro">Buy Pro</a>
    </article>
    <article class="plan-card">
      <h2>IT</h2>
      <p class="plan-price">${it} <span>once</span></p>
      <ul>
        <li>Everything in Pro</li>
        <li>Richer <code>amem doctor --attest</code> packet</li>
        <li>Solo agents usually stop at Pro</li>
        <li>Buy when someone asks for host attestation</li>
      </ul>
      <a class="btn secondary" href="/buy/it">Buy IT</a>
    </article>
  </div>
  <p class="fine">After pay, download <code>amem-license.json</code> on the thank-you page and apply it in <code>amem ui</code>. Offline signed file — no license server, no telemetry.</p>
</main>`,
    "amem — pricing",
  );
}

function successPage(result) {
  if (!result) {
    return htmlPage(
      "amem · thanks",
      `<div class="page"><h1>Payment received</h1>
<p>If the license did not appear, reopen this page from Stripe’s success redirect (it includes a session id).</p>
<p class="actions"><a class="btn secondary" href="/">Get started</a></p></div>`,
    );
  }
  if (result.pending) {
    return htmlPage(
      "amem · pending",
      `<div class="page"><h1>Payment not finished</h1><p>${escapeHtml(result.reason || "Not paid yet.")}</p>
<p class="actions"><a class="btn secondary" href="/">Get started</a></p></div>`,
    );
  }
  if (!result.ok) {
    return htmlPage(
      "amem · issue",
      `<div class="page"><h1>Paid, license not issued</h1>
<p>${escapeHtml(result.reason || "unknown")}</p>
<p>Keep this tab and retry the success URL from Stripe. Do not pay again. Download will appear once the license is ready.</p>
<p class="actions"><a class="btn secondary" href="/">Get started</a></p></div>`,
    );
  }
  const mailNote = result.emailed
    ? result.mode === "testing"
      ? `<p class="note">Seller testing: email went to the configured sandbox, not a customer mailbox. Prefer the download above.</p>`
      : `<p>A copy was emailed to <code>${escapeHtml(result.email)}</code>.</p>`
    : `<p>Email did not send (${escapeHtml(result.mailReason || "skipped")}). Use the download.</p>`;
  return htmlPage(
    "amem · thanks",
    `<div class="page"><div class="brand-row"><div class="mark" aria-hidden="true">a</div><h1>Your ${escapeHtml(result.tier === "it" ? "amem IT" : "amem Pro")} license</h1></div>
<p>Download the file, then open <code>amem ui</code> → Plans/Setup → <strong>Apply license</strong> (paste or choose file). Or from a terminal:</p>
<p class="actions"><a class="btn" href="/license/${encodeURIComponent(result.sessionId)}" download="amem-license.json">Download amem-license.json</a></p>
<pre>amem license apply --file ~/Downloads/amem-license.json
amem license status</pre>
<p class="note">Then use <strong>Turn on Pro retrieval</strong> in the UI to enable n-gram + reindex.</p>
${mailNote}
<p class="actions"><a class="btn secondary" href="/">Get started</a></p></div>`,
  );
}

function cancelPage() {
  return htmlPage(
    "amem · cancelled",
    `<div class="page"><h1>Checkout cancelled</h1><p>No charge. You can upgrade anytime from <code>amem ui</code>.</p>
<p class="actions"><a class="btn" href="/">Get started</a></p></div>`,
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is missing (whitelist it from AMEM_SHOP_ENV or shop/.env)");
  const { default: Stripe } = await import("stripe");
  return new Stripe(key);
}

function amountFor(tier) {
  if (tier === "it") return Number(process.env.STRIPE_AMOUNT_IT_CENTS || TIERS.it.amountCents);
  return Number(process.env.STRIPE_AMOUNT_PRO_CENTS || TIERS.pro.amountCents);
}

async function createCheckout(tier) {
  const stripe = await stripeClient();
  const priceId = tier === "it" ? process.env.STRIPE_PRICE_IT : process.env.STRIPE_PRICE_PRO;
  const lineItems = priceId
    ? [{ price: priceId, quantity: 1 }]
    : [
        {
          price_data: {
            currency: "usd",
            unit_amount: amountFor(tier),
            product_data: { name: TIERS[tier].label, description: "Signed local-only amem license file" },
          },
          quantity: 1,
        },
      ];
  return stripe.checkout.sessions.create({
    mode: "payment",
    line_items: lineItems,
    success_url: `${PUBLIC_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${PUBLIC_URL}/cancel`,
    allow_promotion_codes: true,
    customer_creation: "if_required",
    metadata: { product: "amem", tier },
  });
}

async function fulfillSession(session) {
  if (!sessionPaid(session)) return { ok: false, pending: true, reason: "not_paid" };
  const tier = normalizeTier(session.metadata?.tier);
  const email = buyerEmail(session);
  const sessionId = session.id;
  if (!tier) return { ok: false, reason: "missing_tier" };
  if (!email) return { ok: false, reason: "missing_email" };
  if (!sessionIdOk(sessionId)) return { ok: false, reason: "invalid_session" };

  const existing = readIssuedLicense(LICENSES, sessionId);
  if (existing) {
    return { ok: true, duplicate: true, email, tier, sessionId, path: issuedLicensePath(LICENSES, sessionId) };
  }

  const priv = licensePrivKey();
  if (!priv) return { ok: false, reason: "missing_privkey" };
  const { signLicense, featuresForTier } = await licenseFns();
  const payload = licensePayload({ tier, email, features: featuresForTier(tier) });
  const file = signLicense(priv, payload);
  const jsonText = `${JSON.stringify(file, null, 2)}\n`;
  const path = writeIssuedLicense(LICENSES, sessionId, jsonText);
  rememberFulfilled(FULFILLED, sessionId, { email, tier, at: new Date().toISOString(), path });

  const copy = licenseEmailCopy({ tier, jsonText });
  const mailed = await sendLicenseMail({ to: email, ...copy, jsonText });
  return {
    ok: true,
    email,
    tier,
    sessionId,
    path,
    emailed: Boolean(mailed.ok),
    mode: mailed.mode,
    mailReason: mailed.ok ? undefined : mailed.reason || mailed.error || "mail_failed",
  };
}

async function handleWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    json(res, 503, {
      error: "STRIPE_WEBHOOK_SECRET missing — run stripe listen --live --forward-to localhost:8788/webhook",
    });
    return;
  }
  const raw = await readRaw(req);
  const stripe = await stripeClient();
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, req.headers["stripe-signature"], secret);
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const result = await fulfillSession(event.data.object);
    if (!result.ok && !result.pending) {
      console.error("[shop] fulfill failed", result);
      json(res, 500, result);
      return;
    }
    console.log("[shop] fulfilled", { id: event.data.object.id, emailed: result.emailed, tier: result.tier });
    json(res, 200, { ok: true, emailed: result.emailed, duplicate: result.duplicate });
    return;
  }
  json(res, 200, { ignored: event.type });
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function servePublic(res, rel) {
  const PUBLIC = join(ROOT, "public");
  const cleaned = normalize(String(rel || "").replace(/^[/\\]+/, ""));
  if (!cleaned || cleaned === "." || cleaned.includes("..") || cleaned.includes(sep + "..")) {
    json(res, 404, { error: "not found" });
    return;
  }
  const file = join(PUBLIC, cleaned);
  if (!file.startsWith(PUBLIC + sep) && file !== PUBLIC) {
    json(res, 404, { error: "not found" });
    return;
  }
  if (!existsSync(file)) {
    json(res, 404, { error: "not found" });
    return;
  }
  const ext = extname(file).toLowerCase();
  const types = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  res.writeHead(200, {
    "Content-Type": types[ext] || "application/octet-stream",
    "Cache-Control": "public, max-age=86400",
  });
  res.end(readFileSync(file));
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function onRequest(req, res) {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  try {
    if (CANONICAL_HOST) {
      const host = String(req.headers.host || "")
        .toLowerCase()
        .replace(/:\d+$/, "");
      const alias =
        host === "tryamem.com" ||
        host === "www.tryamem.com" ||
        host === `www.${CANONICAL_HOST}`;
      // Never redirect App Runner health checks (Host is the *.awsapprunner.com name).
      if (alias && url.pathname !== "/health") {
        const loc = `https://${CANONICAL_HOST}${url.pathname}${url.search}`;
        res.writeHead(301, { Location: loc });
        res.end();
        return;
      }
    }
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, {
        ok: true,
        stripe: Boolean(process.env.STRIPE_SECRET_KEY),
        mail: Boolean(process.env.MAILTRAP_TOKEN),
        webhook: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
        license: Boolean(licensePrivKey()),
        testing: String(process.env.MAILTRAP_USE_TESTING || "").toLowerCase() === "true",
        prices: { pro: dollars(amountFor("pro")), it: dollars(amountFor("it")) },
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin") {
      if (!adminTokenConfigured()) {
        html(res, 503, adminLoginPage("AMEM_ADMIN_TOKEN is not configured on this shop."));
        return;
      }
      const qToken = url.searchParams.get("token");
      if (qToken && tokensEqual(qToken, process.env.AMEM_ADMIN_TOKEN)) {
        setAdminCookie(res, qToken);
        res.writeHead(302, { Location: "/admin" });
        res.end();
        return;
      }
      if (!adminAuthorized(req, url)) {
        html(res, 401, adminLoginPage("Enter the admin token to continue."));
        return;
      }
      html(res, 200, adminDashboardPage());
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/api/stats") {
      if (!adminTokenConfigured() || !adminAuthorized(req, url)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      const days = Number(url.searchParams.get("days") || 7);
      const [hits, sales] = await Promise.all([getHitStats({ days }), getSalesStats({ days })]);
      json(res, 200, { ...hits, sales });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/beacon") {
      let body = {};
      try {
        const raw = await readRaw(req);
        if (raw.length) body = JSON.parse(raw.toString("utf8"));
      } catch {
        body = {};
      }
      recordBeacon(req, body && typeof body === "object" ? body : {});
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/beacon/npm-install") {
      let body = {};
      try {
        const raw = await readRaw(req);
        if (raw.length) body = JSON.parse(raw.toString("utf8"));
      } catch {
        body = {};
      }
      recordNpmInstall(req, body && typeof body === "object" ? body : {});
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      html(res, 200, landing());
      return;
    }
    if (req.method === "GET" && url.pathname === "/pricing") {
      html(res, 200, pricingPage());
      return;
    }
    if (req.method === "GET" && (url.pathname === "/plans" || url.pathname === "/shop")) {
      res.writeHead(302, { Location: "/pricing" });
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/public/")) {
      servePublic(res, url.pathname.slice("/public/".length));
      return;
    }
    if (req.method === "GET" && url.pathname === "/success") {
      const sessionId = url.searchParams.get("session_id") || "";
      if (!sessionIdOk(sessionId)) {
        html(res, 200, successPage(null));
        return;
      }
      const stripe = await stripeClient();
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const result = await fulfillSession(session);
      html(res, result.ok ? 200 : result.pending ? 202 : 500, successPage(result));
      return;
    }
    if (req.method === "GET" && url.pathname === "/cancel") {
      html(res, 200, cancelPage());
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/license/")) {
      const sessionId = decodeURIComponent(url.pathname.slice("/license/".length));
      const body = sessionIdOk(sessionId) ? readIssuedLicense(LICENSES, sessionId) : null;
      if (!body) {
        json(res, 404, { error: "license not issued yet" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="amem-license.json"',
      });
      res.end(body);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/buy/")) {
      const tier = normalizeTier(url.pathname.slice("/buy/".length));
      if (!tier) {
        html(res, 404, htmlPage("amem", "<p>Unknown tier.</p>"));
        return;
      }
      const session = await createCheckout(tier);
      res.writeHead(303, { Location: session.url });
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/webhook") {
      await handleWebhook(req, res);
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    console.error("[shop]", error);
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

if (!licensePrivKey()) {
  console.warn("[shop] No AMEM_LICENSE_PRIVKEY or shop/.data/license.priv — run: amem license keys --out-dir shop/.data");
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  res.on("finish", () => {
    try {
      recordRawRequest(req, url.pathname, res.statusCode || 0, req.method || "GET");
    } catch (err) {
      console.warn("[shop/hits]", err instanceof Error ? err.message : err);
    }
  });
  onRequest(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`[shop] listening ${HOST}:${PORT} → ${PUBLIC_URL}`);
  if (HOST === "127.0.0.1") {
    console.log("[shop] webhook: stripe listen --live --forward-to localhost:8788/webhook");
  }
  if (!process.env.STRIPE_SECRET_KEY) console.warn("[shop] STRIPE_SECRET_KEY missing");
  if (!process.env.MAILTRAP_TOKEN) console.warn("[shop] MAILTRAP_TOKEN missing");
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn("[shop] STRIPE_WEBHOOK_SECRET missing — set a live Stripe webhook for /webhook");
  }
  if (!process.env.AMEM_ADMIN_TOKEN) {
    console.warn("[shop] AMEM_ADMIN_TOKEN missing — /admin disabled until set");
  }
});
