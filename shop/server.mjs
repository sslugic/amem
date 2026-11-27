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
import { getNpmDownloads, getUsageStats, recordUsage } from "./usage.mjs";
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

function siteChrome(active, body, title = "amem — get started") {
  const tab = (id, href, label) =>
    `<a class="nav-tab${active === id ? " active" : ""}" href="${href}">${label}</a>`;
  return htmlPage(
    title,
    `<div class="shell">
  <header class="top">
    <a class="brand" href="/"><img class="brand-icon" src="/public/icon-64.png" alt="" width="28" height="28"/>amem<span class="brand-tag"> · agent memory, anchored to your code</span></a>
    <nav class="nav" aria-label="Site">
      ${tab("start", "/", "Start")}
      ${tab("features", "/features", "Features")}
      ${tab("why", "/why", "Why amem")}
      ${tab("what", "/what", "How it works")}
      ${tab("facts", "/fact-sheet", "Fact sheet")}
    </nav>
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
<meta name="description" content="amem — agent memory, anchored to your code. Local facts, skills and tasks for Claude Code, Cursor, Codex and any MCP client, in one SQLite file on your machine."/>
<link rel="icon" type="image/png" sizes="32x32" href="/public/favicon-32.png"/>
<link rel="icon" type="image/png" sizes="64x64" href="/public/icon-64.png"/>
<link rel="apple-touch-icon" href="/public/apple-touch-icon.png"/>
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
.brand{color:var(--ink);text-decoration:none;font-weight:700;font-size:1.15rem;letter-spacing:-.03em;display:inline-flex;align-items:center;gap:.5rem}
.brand-tag{color:var(--muted);font-weight:500;font-size:.82rem;letter-spacing:0}
@media(max-width:760px){.brand-tag{display:none}}
.brand-icon{width:28px;height:28px;border-radius:7px;display:block;flex:none}
.nav{display:flex;align-items:center;gap:.35rem}
.nav-tab{color:var(--muted);text-decoration:none;font-size:.88rem;font-weight:500;
  padding:.4rem .85rem;border-radius:999px;border:1px solid transparent}
.nav-tab:hover{color:var(--ink)}
.nav-tab.active{color:var(--ink);border-color:rgba(126,184,255,.55);background:rgba(126,184,255,.08)}
.nav-tab{white-space:nowrap}
@media(max-width:620px){
  .top{padding:.7rem 1rem;gap:.5rem}
  .nav{gap:.1rem;overflow-x:auto;scrollbar-width:none}
  .nav-tab{font-size:.8rem;padding:.35rem .55rem}
}
.hero{position:relative;flex:0 0 auto;display:grid;align-items:center;min-height:min(68vh, 38rem);
  padding:2rem 1.25rem 2.5rem;overflow:hidden}
.hero.hero-full{min-height:calc(100vh - 3.3rem);min-height:calc(100svh - 3.3rem);padding:2.5rem 1.25rem}
.hero-full .hero-panel{width:min(720px,100%);padding:2.4rem 2.2rem 2rem}
.hero-full .hero-brand{font-size:clamp(3rem,9vw,4.6rem)}
.hero-full h1{font-size:clamp(1.5rem,4vw,2.1rem)}
.hero-full .hero-lead{font-size:1.05rem;max-width:36rem;margin-bottom:1.4rem}
.hero-jumps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.6rem;margin:1.4rem 0 0}
.hero-jump{display:flex;flex-direction:column;gap:.15rem;padding:.75rem .85rem;border:1px solid var(--line);border-radius:12px;
  background:rgba(11,15,18,.55);color:var(--ink);text-decoration:none;transition:border-color .15s,background .15s}
.hero-jump:hover{border-color:rgba(46,196,182,.5);background:rgba(46,196,182,.08)}
.hero-jump strong{font-size:.92rem}
.hero-jump span{color:var(--muted);font-size:.8rem}
.sec-first{padding-top:2.2rem}
@media(max-width:620px){
  .hero-jumps{grid-template-columns:1fr}
  .hero-full .hero-panel{padding:1.6rem 1.2rem 1.4rem}
}
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
.show{position:relative;z-index:1;padding:0 1.25rem 3.25rem;max-width:720px;margin:-1.25rem auto 0;width:100%}
.show-card{border:1px solid var(--line);border-radius:18px;background:rgba(20,27,33,.88);
  backdrop-filter:blur(14px);box-shadow:0 18px 50px rgba(0,0,0,.35);padding:1.25rem 1.3rem 1.15rem}
.show-kicker{margin:0 0 .45rem;color:var(--accent);font-size:.72rem;font-weight:600;
  letter-spacing:.08em;text-transform:uppercase}
.show-frame{position:relative;min-height:8.5rem}
.show-slide{display:none}
.show-slide.active{display:block}
.show-slide h3{margin:0 0 .4rem;font-size:1.15rem;letter-spacing:-.02em}
.show-slide p{margin:0;color:var(--muted);font-size:.92rem;max-width:36rem}
.show-nav{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin:.95rem 0 0}
.show-dots{display:flex;flex-wrap:wrap;gap:.4rem}
.show-dot{appearance:none;width:.65rem;height:.65rem;padding:0;border-radius:999px;cursor:pointer;
  border:1px solid var(--line);background:transparent}
.show-dot.active{background:var(--accent);border-color:var(--accent)}
.show-arrows{display:flex;gap:.4rem}
.show-arrows button{appearance:none;border:1px solid var(--line);background:transparent;color:var(--ink);
  font:inherit;font-size:.85rem;padding:.3rem .7rem;border-radius:999px;cursor:pointer}
.show-arrows button:hover,.show-dot:hover{border-color:rgba(232,238,242,.35)}
.show-more{margin:.85rem 0 0;font-size:.88rem}
.show-more a{color:var(--accent);text-decoration:none;font-weight:500}
.show-more a:hover{text-decoration:underline}
.show[data-paused="true"] .show-kicker::after{content:" · paused"}
.sec{max-width:1080px;margin:0 auto;padding:3rem 1.25rem 0;width:100%;scroll-margin-top:3.5rem}
html{scroll-behavior:smooth}
.sec-head{max-width:44rem;margin:0 0 1.4rem}
.sec-kicker{margin:0 0 .4rem;color:var(--accent);font-size:.74rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.sec h2{margin:0 0 .5rem;font-size:clamp(1.45rem,3.4vw,1.95rem);letter-spacing:-.03em;line-height:1.15}
.sec-lead{margin:0;color:var(--muted);font-size:1rem}
.feat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.85rem}
.feat{padding:1.1rem 1.1rem 1.15rem;border:1px solid var(--line);border-radius:16px;background:rgba(20,27,33,.85);
  display:flex;flex-direction:column;gap:.45rem;transition:border-color .15s,transform .15s}
.feat:hover{border-color:rgba(46,196,182,.4);transform:translateY(-2px)}
.feat-ico{width:2.2rem;height:2.2rem;border-radius:.7rem;display:grid;place-items:center;
  background:rgba(46,196,182,.12);color:var(--accent)}
.feat-ico svg{width:1.15rem;height:1.15rem;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.feat h3{margin:.2rem 0 0;font-size:1rem;letter-spacing:-.01em}
.feat p{margin:0;color:var(--muted);font-size:.88rem}
.feat .tagline{margin-top:auto;padding-top:.35rem;color:var(--claim);font-size:.78rem}
.dev-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.85rem}
.dev{display:grid;grid-template-columns:auto 1fr;gap:.25rem .85rem;padding:1.05rem 1.1rem;border:1px solid var(--line);
  border-radius:16px;background:rgba(20,27,33,.6)}
.dev-n{grid-row:span 2;width:1.9rem;height:1.9rem;border-radius:999px;display:grid;place-items:center;
  border:1px solid rgba(46,196,182,.45);color:var(--accent);font-weight:600;font-size:.85rem}
.dev h3{margin:0;font-size:.98rem}
.dev p{margin:0;color:var(--muted);font-size:.88rem}
.value-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.85rem}
.value{padding:1.25rem 1.2rem;border:1px solid var(--line);border-radius:18px;
  background:linear-gradient(180deg,rgba(46,196,182,.08),rgba(20,27,33,.85) 55%)}
.value-k{margin:0;color:var(--accent);font-size:.74rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.value h3{margin:.35rem 0 .45rem;font-size:1.2rem;letter-spacing:-.02em}
.value ul{margin:0;padding:0 0 0 1.05rem;color:var(--muted);font-size:.88rem}
.value li+li{margin-top:.35rem}
.calc{margin:1rem 0 0;padding:1.25rem;border:1px solid var(--line);border-radius:18px;background:rgba(20,27,33,.85);
  display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:1.25rem;align-items:start}
.calc h3{margin:0 0 .25rem;font-size:1.05rem}
.calc-in{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.7rem;margin:.85rem 0 0}
.calc-in label{display:flex;flex-direction:column;gap:.3rem;color:var(--muted);font-size:.8rem}
.calc-in input{width:100%;padding:.55rem .65rem;border-radius:10px;border:1px solid var(--line);
  background:rgba(11,15,18,.8);color:var(--ink);font:inherit;font-variant-numeric:tabular-nums}
.calc-in input:focus{outline:2px solid rgba(46,196,182,.5);outline-offset:1px}
.calc-out{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.6rem}
.calc-stat{padding:.85rem .9rem;border:1px solid var(--line);border-radius:14px;background:rgba(11,15,18,.55)}
.calc-stat .k{margin:0;color:var(--muted);font-size:.76rem}
.calc-stat .v{margin:.2rem 0 0;font-size:1.45rem;font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.calc-stat.big{grid-column:1/-1;border-color:rgba(46,196,182,.45)}
.calc-stat.big .v{color:var(--accent);font-size:1.9rem}
.calc-note{grid-column:1/-1;margin:0;color:var(--muted);font-size:.78rem}
.closer{max-width:640px;margin:3rem auto 3.5rem;padding:0 1.25rem;width:100%;text-align:center}
.closer h2{margin:0 0 .45rem;font-size:1.5rem;letter-spacing:-.03em}
.closer p{margin:0 0 1rem;color:var(--muted)}
.closer .cmd-box{text-align:left}
@media(max-width:900px){
  .feat-grid,.value-grid{grid-template-columns:1fr 1fr}
  .calc{grid-template-columns:1fr}
}
@media(max-width:620px){
  .feat-grid,.value-grid,.dev-grid,.calc-in{grid-template-columns:1fr}
}
.what{max-width:860px;margin:0 auto;padding:2rem 1.25rem 3.5rem;width:100%}
.what h1{margin:0 0 .4rem;font-size:clamp(1.6rem,4vw,2.1rem);letter-spacing:-.03em}
.what-lead{margin:0 0 1.75rem;color:var(--muted);max-width:40rem;font-size:1.02rem}
.what h2{margin:2rem 0 .65rem;font-size:1.15rem;letter-spacing:-.02em}
.what-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem}
.what-card{padding:1rem 1.05rem;border:1px solid var(--line);border-radius:14px;background:rgba(20,27,33,.85)}
.what-card h3{margin:0 0 .35rem;font-size:.98rem}
.what-card p{margin:0;color:var(--muted);font-size:.88rem}
.what-table{width:100%;border-collapse:collapse;font-size:.9rem}
.what-table th,.what-table td{text-align:left;padding:.55rem .45rem;border-bottom:1px solid var(--line);vertical-align:top}
.what-table th{color:var(--muted);font-weight:500;width:42%}
.what-list{margin:0;padding:0 0 0 1.15rem;color:var(--muted)}
.what-list li+li{margin-top:.4rem}
.what-cta{margin:2rem 0 0;padding:1.15rem 1.2rem;border:1px solid var(--line);border-radius:16px;
  background:rgba(20,27,33,.85)}
.what-cta p{margin:0 0 .85rem;color:var(--muted)}
@media(max-width:800px){
  .what-grid{grid-template-columns:1fr}
}
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
.admin-grid.four{grid-template-columns:repeat(4,minmax(0,1fr))}
.admin-stat .sub{margin:.2rem 0 0;color:var(--muted);font-size:.75rem}
.admin-h2{font-size:1.05rem;margin:1.75rem 0 .35rem}
.admin-cols{display:flex;align-items:flex-end;gap:2px;height:120px;padding:.5rem;border:1px solid var(--line);border-radius:14px;background:rgba(20,27,33,.55)}
.admin-cols .col{flex:1;display:flex;flex-direction:column-reverse;min-width:0;height:100%}
.admin-cols .col i{display:block;border-radius:2px 2px 0 0}
.admin-cols .col i.a{background:var(--accent)}
.admin-cols .col i.n{background:#f0b429}
.admin-cols .col i.d{background:rgba(143,163,176,.55)}
.admin-legend{display:flex;gap:1rem;margin:.4rem 0 0;color:var(--muted);font-size:.78rem}
.admin-legend b{display:inline-block;width:.6rem;height:.6rem;border-radius:2px;margin-right:.3rem;vertical-align:middle}
.admin-split.three{grid-template-columns:repeat(3,1fr)}
.admin-split.three .admin-bars li{grid-template-columns:minmax(5rem,9.5rem) 1fr 2rem}
.admin-toggle a{color:var(--accent)}
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
  .admin-grid,.admin-grid.four{grid-template-columns:1fr 1fr}
  .admin-split,.admin-split.three{grid-template-columns:1fr}
}

/* ---- landing v0.9 ---- */
.oc{max-width:760px;margin:0 0 1rem;padding:1rem 1.1rem;border:1px solid var(--line);border-radius:16px;background:rgba(20,27,33,.85)}
.oc h3{margin:.1rem 0 .65rem;font-size:.82rem;color:var(--muted);font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.oc h3+.oc-cmds{margin-top:0}
.oc-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.55rem;margin:0 0 1rem}
.oc-btn{display:flex;flex-direction:column;gap:.15rem;padding:.7rem .8rem;border:1px solid rgba(46,196,182,.4);border-radius:12px;
  background:rgba(46,196,182,.08);color:var(--ink);text-decoration:none;transition:background .15s,border-color .15s}
.oc-btn:hover{background:rgba(46,196,182,.16);border-color:var(--accent)}
.oc-btn strong{font-size:.9rem}
.oc-btn span{color:var(--muted);font-size:.74rem}
.oc-cmds{display:grid;gap:.45rem}
.oc-cmd>span{display:block;color:var(--muted);font-size:.76rem;margin:0 0 .2rem}
.oc-cmd .cmd-row{padding:.45rem .6rem;border:1px solid var(--line);border-radius:10px;background:rgba(11,15,18,.6)}
.oc .setup-note{margin:.8rem 0 0}
@media(max-width:760px){.oc-grid{grid-template-columns:1fr 1fr}}

.lp-hero{position:relative;overflow:hidden;padding:3.2rem 1.25rem 3rem}
.lp-hero .hero-art img{opacity:.22}
.lp-hero-in{position:relative;z-index:1;max-width:1120px;margin:0 auto;display:grid;
  grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);gap:2.4rem;align-items:center}
.lp-eyebrow{display:inline-flex;gap:.5rem;align-items:center;margin:0 0 1rem;padding:.3rem .75rem;border:1px solid rgba(46,196,182,.35);
  border-radius:999px;background:rgba(46,196,182,.08);color:var(--accent);font-size:.74rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.lp-h1{margin:0 0 .9rem;font-size:clamp(2rem,4.6vw,3.1rem);line-height:1.06;letter-spacing:-.04em;font-weight:700}
.lp-sub{margin:0 0 1.4rem;color:var(--muted);font-size:1.04rem;max-width:34rem}
.lp-sub code{color:var(--ink)}
.lp-cta2{display:flex;align-items:center;gap:.6rem;margin:.8rem 0 0;color:var(--muted);font-size:.86rem}
.lp-cta2 code{color:var(--ink);padding:.25rem .55rem;border:1px solid var(--line);border-radius:8px;background:rgba(11,15,18,.6)}
.lp-facts{display:flex;flex-wrap:wrap;gap:.4rem 1.1rem;margin:1.3rem 0 0;padding:0;list-style:none;color:var(--muted);font-size:.8rem}
.lp-facts li::before{content:"✓ ";color:var(--accent)}
.mock{border:1px solid var(--line);border-radius:14px;background:rgba(11,15,18,.92);box-shadow:0 30px 90px rgba(0,0,0,.55);overflow:hidden;font-size:.8rem}
.mock-bar{display:flex;align-items:center;gap:.4rem;padding:.55rem .75rem;border-bottom:1px solid var(--line);background:rgba(20,27,33,.9)}
.mock-bar i{width:.6rem;height:.6rem;border-radius:999px;background:#3a454e}
.mock-bar span{margin-left:.5rem;color:var(--muted);font-family:"IBM Plex Mono",monospace;font-size:.72rem}
.mock-tabs{display:flex;gap:.25rem;padding:.5rem .6rem;border-bottom:1px solid var(--line)}
.mock-tab{appearance:none;border:1px solid transparent;background:transparent;color:var(--muted);font:inherit;font-size:.76rem;
  padding:.28rem .65rem;border-radius:999px;cursor:pointer}
.mock-tab.active{color:var(--ink);border-color:var(--line);background:var(--bg2)}
.mock-pane{display:none;padding:.8rem;min-height:15.5rem}
.mock-pane.active{display:block}
.mf{display:grid;grid-template-columns:auto 1fr;gap:.15rem .6rem;padding:.55rem .6rem;border:1px solid var(--line);border-radius:10px;background:rgba(20,27,33,.7)}
.mf+.mf{margin-top:.45rem}
.mf b{font-weight:500}
.mf small{grid-column:2;color:var(--muted);font-family:"IBM Plex Mono",monospace;font-size:.68rem}
.pill{align-self:start;padding:.08rem .45rem;border-radius:999px;font-size:.66rem;font-weight:600;letter-spacing:.03em;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.pill.ok{color:var(--accent);border-color:rgba(46,196,182,.45)}
.pill.stale{color:#f0b429;border-color:rgba(240,180,41,.5)}
.pill.pin{color:var(--claim);border-color:rgba(126,184,255,.5)}
.mr{display:flex;justify-content:space-between;align-items:center;gap:.6rem;padding:.55rem .6rem;border:1px solid var(--line);border-radius:10px;background:rgba(20,27,33,.7)}
.mr+.mr{margin-top:.45rem}
.mr-act{display:flex;gap:.3rem}
.mr-act span{padding:.15rem .5rem;border-radius:999px;border:1px solid var(--line);font-size:.68rem;color:var(--muted)}
.mr-act span.y{color:#062925;background:var(--accent);border-color:transparent}
.board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.45rem}
.col h4{margin:0 0 .4rem;color:var(--muted);font-size:.68rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.card{padding:.45rem .5rem;border:1px solid var(--line);border-radius:8px;background:rgba(20,27,33,.75);font-size:.72rem;line-height:1.3}
.card+.card{margin-top:.35rem}
.card em{display:block;margin-top:.2rem;color:var(--muted);font-style:normal;font-size:.64rem}
.col.doing .card{border-color:rgba(46,196,182,.45)}
.col.done .card{opacity:.6;text-decoration:line-through;text-decoration-color:rgba(232,238,242,.3)}
.prim-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.85rem}
.prim{padding:1.3rem 1.25rem;border:1px solid var(--line);border-radius:18px;background:linear-gradient(180deg,rgba(46,196,182,.07),rgba(20,27,33,.88) 50%)}
.prim-n{margin:0 0 .6rem;color:var(--accent);font-family:"IBM Plex Mono",monospace;font-size:.78rem}
.prim h3{margin:0 0 .5rem;font-size:1.12rem;letter-spacing:-.02em}
.prim p{margin:0;color:var(--muted);font-size:.9rem}
.prim .eg{margin:.8rem 0 0;padding:.55rem .7rem;border-left:2px solid var(--accent);background:rgba(11,15,18,.55);border-radius:0 8px 8px 0;font-size:.8rem;color:var(--ink)}
.cmp-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:16px;background:rgba(20,27,33,.85)}
.cmp{width:100%;min-width:760px;border-collapse:collapse;font-size:.86rem}
.cmp th,.cmp td{padding:.8rem .9rem;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
.cmp tr:last-child td{border-bottom:0}
.cmp thead th{color:var(--muted);font-weight:500;font-size:.78rem;background:rgba(11,15,18,.5)}
.cmp thead th small{display:block;color:var(--muted);opacity:.8;font-weight:400}
.cmp thead th.us{color:var(--accent);font-size:.9rem;font-weight:700}
.cmp tbody th{color:var(--ink);font-weight:600;white-space:nowrap}
.cmp td.us{background:rgba(46,196,182,.07);color:var(--ink)}
.cmp td{color:var(--muted)}
.y{color:var(--accent);font-weight:600}
.n{color:#e5737a;font-weight:600}
.m{color:#f0b429;font-weight:600}
.cmp-note{margin:.9rem 0 0;padding:1rem 1.1rem;border:1px solid rgba(46,196,182,.35);border-radius:14px;background:rgba(46,196,182,.06);font-size:.95rem}
.cmp-src{margin:.6rem 0 0;color:var(--muted);font-size:.74rem}
.cmp-src a{color:var(--muted)}
.setup-box{max-width:760px}
.setup-box pre{margin:0;border:0;border-radius:0;background:transparent;padding:.85rem .95rem;font-size:.82rem;white-space:pre;overflow:auto}
.setup-box .cmd-tabs{flex-wrap:wrap}
.setup-note{margin:.5rem .95rem .85rem;color:var(--muted);font-size:.8rem}
.faq{max-width:760px}
.faq details{border:1px solid var(--line);border-radius:14px;background:rgba(20,27,33,.85);padding:.2rem 1.1rem}
.faq details+details{margin-top:.55rem}
.faq summary{cursor:pointer;padding:.85rem 0;font-weight:600;list-style:none}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";float:right;color:var(--muted)}
.faq details[open] summary::after{content:"–"}
.faq details p{margin:0 0 1rem;color:var(--muted)}
.foot{margin:3.5rem 0 0;padding:1.6rem 1.25rem;border-top:1px solid var(--line);color:var(--muted);font-size:.84rem}
.foot-in{max-width:1080px;margin:0 auto;display:flex;flex-wrap:wrap;gap:.6rem 1.4rem;justify-content:space-between}
.foot a{color:var(--muted);text-decoration:none}
.foot a:hover{color:var(--ink)}
.foot nav{display:flex;flex-wrap:wrap;gap:1.1rem}
@media(max-width:900px){
  .lp-hero-in{grid-template-columns:1fr}
  .prim-grid{grid-template-columns:1fr}
}
@media(max-width:620px){
  .lp-hero{padding:2rem 1rem 2.2rem}
  .board{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(prefers-reduced-motion:reduce){.feat,.hero-jump{transition:none}}
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
  <p class="hero-kicker">Admin only</p>
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
  <h1>amem analytics</h1>
  <p class="admin-meta" id="meta">Loading…</p>
  <p class="admin-toggle">Window: <a href="/admin?days=7">7 days</a> · <a href="/admin?days=30">30 days</a></p>

  <h2 class="admin-h2">Usage</h2>
  <p class="admin-meta">Anonymous CLI pings (first run + at most one a day per install). Install = random id, so one machine counts once.</p>
  <div class="admin-grid">
    <div class="admin-stat"><p class="k">Active today</p><p class="v" id="u-today">—</p></div>
    <div class="admin-stat"><p class="k">Active 7d</p><p class="v" id="u-7">—</p></div>
    <div class="admin-stat"><p class="k">Active 30d</p><p class="v" id="u-30">—</p></div>
    <div class="admin-stat"><p class="k" id="u-new-k">New installs</p><p class="v" id="u-new">—</p><p class="sub" id="u-new-today"></p></div>
    <div class="admin-stat"><p class="k">Returning</p><p class="v" id="u-ret">—</p><p class="sub">first seen before window</p></div>
  </div>
  <div class="admin-cols" id="usage-cols" aria-label="Daily active and new installs"></div>
  <p class="admin-legend"><span><b style="background:var(--accent)"></b>active</span><span><b style="background:#f0b429"></b>new</span><span id="u-dc"></span></p>
  <div class="admin-split three">
    <div><h2 class="admin-h2">How it's used</h2><p class="admin-meta">Share of active installs that ran each part</p><ul class="admin-bars" id="u-features"></ul></div>
    <div><h2 class="admin-h2">Versions</h2><p class="admin-meta">Latest per active install</p><ul class="admin-bars" id="u-versions"></ul></div>
    <div><h2 class="admin-h2">Platforms</h2><p class="admin-meta">OS / CPU</p><ul class="admin-bars" id="u-platforms"></ul></div>
  </div>
  <div class="admin-split">
    <div><h2 class="admin-h2">Countries</h2><ul class="admin-bars" id="u-countries"></ul></div>
    <div><h2 class="admin-h2">Node.js</h2><ul class="admin-bars" id="u-nodes"></ul></div>
  </div>

  <h2 class="admin-h2">npm</h2>
  <p class="admin-meta" id="npm-meta">Registry downloads (includes CI and mirrors) · install-script pings are often skipped by npm</p>
  <div class="admin-grid four">
    <div class="admin-stat"><p class="k">Downloads 7d</p><p class="v" id="npm-7">—</p></div>
    <div class="admin-stat"><p class="k">Downloads 30d</p><p class="v" id="npm-30">—</p></div>
    <div class="admin-stat"><p class="k">Avg / day (30d)</p><p class="v" id="npm-avg">—</p></div>
    <div class="admin-stat muted"><p class="k" id="npm-win-k">Install-script pings</p><p class="v" id="npm-win">—</p></div>
  </div>
  <div class="admin-cols" id="npm-cols" aria-label="Daily npm downloads"></div>

  <h2 class="admin-h2">Website</h2>
  <label class="admin-toggle"><input type="checkbox" id="show-raw"/> Show unfiltered (includes bots / scanners / datacenter)</label>
  <div class="admin-grid four">
    <div class="admin-stat"><p class="k">Visitors today</p><p class="v" id="vis-today">—</p></div>
    <div class="admin-stat"><p class="k" id="vis-win-k">Visitors</p><p class="v" id="vis-win">—</p></div>
    <div class="admin-stat"><p class="k" id="pv-win-k">Pageviews</p><p class="v" id="pv-win">—</p></div>
    <div class="admin-stat muted"><p class="k" id="bots-win-k">Bot / scanner</p><p class="v" id="bots-win">—</p></div>
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
  <h2 style="font-size:1.05rem;margin:0 0 .5rem">Campaigns <span style="color:var(--muted);font-weight:400;font-size:.85rem">utm source · campaign · content (pageviews)</span></h2>
  <ul class="admin-bars" id="campaigns"></ul>
  <h2 style="font-size:1.05rem;margin:1rem 0 .5rem">Top paths</h2>
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
  const days = new URLSearchParams(location.search).get("days") === "30" ? 30 : 7;
  const res = await fetch("/admin/api/stats?days=" + days, { credentials: "same-origin" });
  if (!res.ok) {
    document.getElementById("meta").textContent = "Unauthorized or stats unavailable (" + res.status + ").";
    return;
  }
  const data = await res.json();
  const set = (id, v) => { document.getElementById(id).textContent = String(v ?? "—"); };
  const win = days + "d";
  document.getElementById("meta").textContent = "Window: " + days + " days · storage: " + (data.storage || "?");

  const u = data.usage || {};
  set("u-today", u.active?.today);
  set("u-7", u.active?.d7);
  set("u-30", u.active?.d30);
  set("u-new-k", "New installs " + win);
  set("u-new", u.newInstalls?.window);
  set("u-new-today", (u.newInstalls?.today ?? 0) + " today");
  set("u-ret", u.returning);
  set("u-dc", u.datacenter ? u.datacenter + " active installs on cloud/datacenter networks" : "");

  function columns(id, rows, parts, title) {
    const el = document.getElementById(id);
    el.innerHTML = "";
    const max = Math.max(1, ...rows.map((r) => parts.reduce((n, p) => n + (r[p.key] || 0), 0)));
    for (const r of rows) {
      const col = document.createElement("div");
      col.className = "col";
      col.title = title(r);
      for (const p of parts) {
        const i = document.createElement("i");
        i.className = p.cls;
        i.style.height = ((r[p.key] || 0) / max) * 100 + "%";
        col.appendChild(i);
      }
      el.appendChild(col);
    }
  }
  // Stacked: "active" already includes new installs, so draw new on top of the rest.
  columns(
    "usage-cols",
    (u.daily || []).map((d) => ({ ...d, rest: Math.max(0, d.active - d.new) })),
    [{ key: "rest", cls: "a" }, { key: "new", cls: "n" }],
    (d) => d.day + ": " + d.active + " active, " + d.new + " new",
  );

  const npm = data.npm || {};
  if (npm.error) set("npm-meta", "npm registry unavailable: " + npm.error);
  set("npm-7", npm.d7);
  set("npm-30", npm.d30);
  set("npm-avg", npm.d30 != null ? Math.round(npm.d30 / Math.max(1, (npm.daily || []).length || 30)) : "—");
  set("npm-win-k", "Install-script pings " + win);
  set("npm-win", data.npmInstalls?.window ?? 0);
  columns("npm-cols", npm.daily || [], [{ key: "downloads", cls: "d" }], (d) => d.day + ": " + d.downloads + " downloads");

  set("vis-today", data.visitors?.today ?? data.today?.visitors ?? 0);
  set("vis-win-k", "Visitors " + win);
  set("vis-win", data.visitors?.window ?? data.window?.visitors ?? 0);
  set("pv-win-k", "Pageviews " + win);
  set("pv-win", data.pageviews?.window ?? data.window?.pageviews ?? 0);
  set("bots-win-k", "Bot / scanner " + win);
  set("bots-win", data.bots?.window ?? 0);
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
  const featureNames = { mcp: "MCP server", hook: "Agent hooks", ui: "Dashboard", cli: "CLI commands", setup: "Setup / init" };
  const active = Math.max(1, u.active?.window || 0);
  fillBars(
    "u-features",
    (u.features || [])
      .map((f) => ({
        label: (featureNames[f.feature] || f.feature) + " · " + Math.round((f.installs / active) * 100) + "%",
        count: f.installs,
      }))
      .sort((a, b) => b.count - a.count),
    "label",
  );
  fillBars("u-versions", u.versions || [], "version");
  fillBars("u-platforms", u.platforms || [], "platform");
  fillBars("u-countries", u.countries || [], "country");
  fillBars("u-nodes", u.nodes || [], "node");
  fillBars("countries", data.topCountries || [], "country");
  fillBars("cities", data.topCities || [], "city");
  fillBars("campaigns", data.topCampaigns || [], "campaign");

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
  // Each tab group switches only its own panels (hero install box, setup box, UI preview).
  const wire = (tabSel, panelSel, key, panelKey, boxSel) => {
    document.querySelectorAll(boxSel).forEach((box) => {
      const tabs = [...box.querySelectorAll(tabSel)];
      const panels = [...box.querySelectorAll(panelSel)];
      tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          tabs.forEach((t) => {
            const on = t === tab;
            t.classList.toggle("active", on);
            t.setAttribute("aria-selected", on ? "true" : "false");
          });
          panels.forEach((p) => p.classList.toggle("active", p.dataset[panelKey] === tab.dataset[key]));
        });
      });
    });
  };
  wire(".cmd-tab", ".cmd-panel", "cmd", "panel", ".cmd-box");
  wire(".mock-tab", ".mock-pane", "mock", "pane", ".mock");
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

  const show = document.querySelector("[data-show]");
  if (show) {
    const slides = [...show.querySelectorAll("[data-slide]")];
    const dots = [...show.querySelectorAll("[data-dot]")];
    let i = 0;
    let timer = null;
    let locked = false;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const go = (n, fromUser) => {
      if (fromUser) locked = true;
      i = (n + slides.length) % slides.length;
      slides.forEach((s, k) => {
        const on = k === i;
        s.classList.toggle("active", on);
        s.hidden = !on;
      });
      dots.forEach((d, k) => {
        const on = k === i;
        d.classList.toggle("active", on);
        d.setAttribute("aria-current", on ? "true" : "false");
      });
      if (fromUser) stop();
    };
    const stop = () => {
      locked = true;
      if (timer) clearInterval(timer);
      timer = null;
      show.dataset.paused = "true";
    };
    show.querySelector("[data-prev]")?.addEventListener("click", () => go(i - 1, true));
    show.querySelector("[data-next]")?.addEventListener("click", () => go(i + 1, true));
    dots.forEach((d, k) => d.addEventListener("click", () => go(k, true)));
    show.addEventListener("click", (ev) => {
      if (ev.target.closest("a")) return;
      if (!locked) stop();
    });
    show.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowLeft") go(i - 1, true);
      if (ev.key === "ArrowRight") go(i + 1, true);
    });
    go(0, false);
    if (!reduce) timer = setInterval(() => { if (!locked) go(i + 1, false); }, 6500);
  }

  const calc = document.querySelector("[data-calc]");
  if (calc) {
    const num = (name) => Math.max(0, Number(calc.querySelector('[name="' + name + '"]')?.value) || 0);
    const out = (name, text) => {
      const el = calc.querySelector('[data-out="' + name + '"]');
      if (el) el.textContent = text;
    };
    const money = (v) => "$" + Math.round(v).toLocaleString("en-US");
    const paint = () => {
      const days = 21;
      const sessions = num("sessions") * days;
      const hours = (sessions * num("minutes")) / 60;
      const timeCost = hours * num("rate");
      const tokens = sessions * num("tokens") * 1000;
      const tokenCost = (tokens / 1e6) * num("price");
      out("hours", hours.toFixed(1) + " h");
      out("tokens", (tokens / 1e6).toFixed(1) + "M");
      out("total", money(timeCost + tokenCost));
    };
    calc.addEventListener("input", paint);
    paint();
  }
})();
</script>`;
}

function installCommands(withHint = true) {
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
</div>${withHint ? `
<p class="cmd-hint">Node 20+. Then run <code>amem ui</code>. Source on <a href="https://github.com/sslugic/amem">GitHub</a>.</p>` : ""}`;
}

function dollars(cents) {
  return `$${(Number(cents) / 100).toFixed(0)}`;
}

function siteSections() {
  const ico = (d) => `<span class="feat-ico" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="${d}"/></svg></span>`;
  const featureList = [
    ["M10 3c3.9 0 7 1.3 7 3s-3.1 3-7 3-7-1.3-7-3 3.1-3 7-3zM3 6v8c0 1.7 3.1 3 7 3s7-1.3 7-3V6M3 10c0 1.7 3.1 3 7 3s7-1.3 7-3",
      "Memory that sticks", "Decisions, constraints, gotchas and owners saved as short facts tied to the files they describe. Your next session starts with them.", "amem_remember · amem_context"],
    ["M3 10h3l2-5 4 10 2-5h3",
      "Context on autopilot", "Hooks inject the right facts when a session starts and when you ask a question. No copy-pasting a project brief into every chat.", "Session start + every prompt"],
    ["M8.5 14a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11zm3.9-1.6L17 17",
      "Search that finds the right thing", "BM25 full-text search across facts, skills and tasks, plus on-device embeddings, pins, recency and usage. “auth flow” finds the JWT login middleware.", "amem_search · SQLite FTS5"],
    ["M4 4h12M4 8h9M4 12h12M4 16h6",
      "Token budgets", "Pass max_tokens and amem packs the highest-ranked items into the budget, never cutting one in half, and tells the agent what it left out.", "max_tokens on context + search"],
    ["M10 3l6 3v4c0 3.5-2.6 6.4-6 7-3.4-.6-6-3.5-6-7V6z",
      "One-call session start", "amem_bootstrap returns about 350 tokens: global rules, this project's key facts, active tasks and skill hints. The agent is oriented before its first tool call.", "amem_bootstrap · amem bootstrap"],
    ["M10 4v6l4 2M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14z",
      "Facts that expire", "Debugging notes and incident context get a TTL and drop out of recall on time. Decisions that change retire the old fact and keep the history.", "ttl_days · supersedes"],
    ["M4 10h9M10 6l4 4-4 4M16 4v12",
      "Import and export", "Bring CLAUDE.md, AGENTS.md, .cursorrules and .mdc rules in without duplicates. Export everything to JSON or Markdown for backup or review.", "amem import · amem export"],
    ["M3 10h14M10 3v14",
      "Global and project scope", "Rules you follow everywhere live in global memory and reach every repo. Project facts stay with their project. Private notes never leak into work.", "global · project:<path>"],
    ["M5 3h8l2 2v12H5zM8 8h4M8 11h4M8 14h2",
      "Skills: how you do it here", "Repeatable procedures (release steps, deploy dance, test setup) saved once. Agents see the name and load the steps only when needed.", "SKILL.md, reviewed before saving"],
    ["M4 5h2v2H4zm4 .5h8M4 9h2v2H4zm4 .5h8M4 13h2v2H4zm4 .5h8",
      "Tasks that outlive the chat", "A Backlog → Next → Doing → Done board agents can update. “Do this later” stops disappearing when the tab closes.", "Open tasks ride along in context"],
    ["M4 4h12v9H4zM8 16h4M10 13v3",
      "A dashboard you can read", "See what your agents remember, what needs review, open tasks and what they asked. Retire or delete a fact in one click, with undo.", "amem ui · localhost only"],
    ["M10 3v3M10 14v3M3 10h3M14 10h3M5.5 5.5l2 2M12.5 12.5l2 2M14.5 5.5l-2 2M7.5 12.5l-2 2",
      "Keeps itself tidy", "Facts tied to edited files are flagged stale. Newer facts retire older ones. Duplicates and chat noise are filtered before they land.", "Stale flags · retire · review queue"],
    ["M6 9V7a4 4 0 0 1 8 0v2M5 9h10v8H5z",
      "Private by design", "One SQLite file in ~/.amem. Binds to 127.0.0.1. Optional AES-256-GCM lock and encrypted daily backups. Secrets are blocked from being saved.", "No cloud, no org wiki"],
    ["M7 7h6v6H7zM3 10h4M13 10h4M10 3v4M10 13v4",
      "Works with your agents", "Claude Code, Cursor, Claude Desktop, Copilot, Codex, Gemini CLI, Windsurf, Continue, Aider and Zed share one memory over MCP.", "One memory, every tool"],
  ];
  const featureCards = featureList
    .map(([d, h, p, t]) => `<article class="feat">${ico(d)}<h3>${h}</h3><p>${p}</p><p class="tagline">${t}</p></article>`)
    .join("");

  const dev = [
    ["Stop re-explaining your project", "The constraints you explained on Monday are already there on Tuesday, in Cursor or in Claude, without a pasted brief."],
    ["Start on the right files", "Facts point at the files they came from, so agents read three files instead of grepping three hundred."],
    ["Keep decisions with their reasons", "The “why” behind a choice survives the chat it was made in, so nobody undoes it by accident next week."],
    ["Hand off between tools and days", "Switch from the editor to the terminal, or pick work up after a weekend. Open tasks and recent work are waiting."],
    ["Standups and status in a minute", "Work logged as you go means “what did I do yesterday?” is a lookup, not an archaeology session."],
    ["Fewer repeated mistakes", "A gotcha learned once (a flaky test, a deploy order, a quota) is a fact the next agent sees before it trips on it."],
  ];
  const devCards = dev
    .map(([h, p], i) => `<article class="dev"><span class="dev-n">${i + 1}</span><h3>${h}</h3><p>${p}</p></article>`)
    .join("");

  const closer = (title, line) => `
  <section class="closer">
    <h2>${title}</h2>
    <p>${line}</p>
    ${installCommands()}
  </section>`;

  const features = `
  <section class="sec sec-first" id="features">
    <div class="sec-head">
      <p class="sec-kicker">Everything in the box</p>
      <h2>One local memory for every coding agent you use</h2>
      <p class="sec-lead">amem sits next to your agents and gives them what they learned last time: facts, procedures and open work. Free, open source, and it never leaves your machine.</p>
    </div>
    <div class="feat-grid">${featureCards}</div>
  </section>
  ${closer("Give your agents a memory", "Free. One command. Everything stays on your machine.")}`;

  const why = `
  <section class="sec sec-first" id="developers">
    <div class="sec-head">
      <p class="sec-kicker">For developers</p>
      <h2>Your agent remembers the project, so you don't have to repeat it</h2>
      <p class="sec-lead">Every new session today starts cold. amem turns the context you already paid for into something the next session can use.</p>
    </div>
    <div class="dev-grid">${devCards}</div>
  </section>

  <section class="sec" id="value">
    <div class="sec-head">
      <p class="sec-kicker">Time, speed, money</p>
      <h2>Less warm-up, fewer tokens, faster answers</h2>
      <p class="sec-lead">Most of an agent's first minutes go to finding its bearings. amem replaces that with a small, ranked packet of what it needs.</p>
    </div>
    <div class="value-grid">
      <article class="value">
        <p class="value-k">Time</p>
        <h3>Skip the re-briefing</h3>
        <ul>
          <li>No retyping project context at the start of each chat</li>
          <li>Procedures run from a saved skill, not trial and error</li>
          <li>Follow-ups are on the board, not lost in scrollback</li>
        </ul>
      </article>
      <article class="value">
        <p class="value-k">Speed</p>
        <h3>Answers start from the right place</h3>
        <ul>
          <li>Context is a local lookup in milliseconds, no network call</li>
          <li>File anchors send agents straight to the right code</li>
          <li>Fewer exploration turns before real work begins</li>
        </ul>
      </article>
      <article class="value">
        <p class="value-k">Money</p>
        <h3>Spend tokens on work, not discovery</h3>
        <ul>
          <li>A capped context packet instead of broad tree searches</li>
          <li>Embeddings run on-device: no embedding API bill</li>
          <li>Free and local: no seat fees, no hosted vector database</li>
        </ul>
      </article>
    </div>

    <form class="calc" data-calc onsubmit="return false">
      <div>
        <h3>What does re-orienting cost you?</h3>
        <p class="note">Put in your own numbers. The estimate assumes 21 working days a month.</p>
        <div class="calc-in">
          <label>Agent sessions per day<input name="sessions" type="number" min="0" step="1" value="8" inputmode="numeric"/></label>
          <label>Minutes spent re-orienting each<input name="minutes" type="number" min="0" step="1" value="4" inputmode="numeric"/></label>
          <label>Your hourly cost ($)<input name="rate" type="number" min="0" step="5" value="75" inputmode="numeric"/></label>
          <label>Exploration tokens per session (thousands)<input name="tokens" type="number" min="0" step="5" value="30" inputmode="numeric"/></label>
          <label>Model input price ($ per million tokens)<input name="price" type="number" min="0" step="0.5" value="3" inputmode="decimal"/></label>
        </div>
      </div>
      <div class="calc-out" aria-live="polite">
        <div class="calc-stat"><p class="k">Time spent re-orienting / month</p><p class="v" data-out="hours">–</p></div>
        <div class="calc-stat"><p class="k">Exploration tokens / month</p><p class="v" data-out="tokens">–</p></div>
        <div class="calc-stat big"><p class="k">Monthly cost of starting cold</p><p class="v" data-out="total">–</p></div>
        <p class="calc-note">This is what starting every session from zero costs at your numbers. amem's job is to cut it down. Your dashboard tracks how often agents used memory and estimates the time saved.</p>
      </div>
    </form>
  </section>
  ${closer("Stop paying for cold starts", "Free. One command. Everything stays on your machine.")}`;

  return { features, why, featureCards };
}

function featureCardsHtml() {
  return siteSections().featureCards;
}

function closerHtml(title, line) {
  return `
  <section class="closer">
    <h2>${title}</h2>
    <p>${line}</p>
    ${installCommands()}
  </section>`;
}

function featuresPage() {
  return siteChrome("features", `<main>${siteSections().features}</main>`, "amem — features");
}

function whyPage() {
  return siteChrome("why", `<main>${siteSections().why}</main>`, "amem — why it pays off");
}


/** One-click installs. Each app takes a single server entry; Cursor and LM Studio base64 it. */
function oneClickInstalls() {
  const entry = { command: "npx", args: ["-y", "@iamem/amem@latest", "mcp"] };
  const b64 = Buffer.from(JSON.stringify(entry)).toString("base64");
  const cursor = `cursor://anysphere.cursor-deeplink/mcp/install?name=amem&config=${b64}`;
  const vscode = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "amem", ...entry }))}`;
  const lmstudio = `lmstudio://add_mcp?name=amem&config=${encodeURIComponent(b64)}`;
  const mcpb = "https://github.com/sslugic/amem/releases/latest/download/amem.mcpb";
  const btn = (href, label, sub) =>
    `<a class="oc-btn" href="${href}"><strong>${label}</strong><span>${sub}</span></a>`;
  const cmd = (id, label, text) =>
    `<div class="oc-cmd"><span>${label}</span><div class="cmd-row"><code id="oc-${id}">${text}</code><button type="button" class="btn compact" data-copy="oc-${id}">Copy</button></div></div>`;
  return `<div class="oc">
      <h3>One-click install</h3>
      <div class="oc-grid">
        ${btn(cursor, "Add to Cursor", "MCP server, one click")}
        ${btn(vscode, "Add to VS Code", "Copilot agent mode")}
        ${btn(lmstudio, "Add to LM Studio", "local models")}
        ${btn(mcpb, "Claude Desktop", "download amem.mcpb, double-click")}
      </div>
      <h3>Plugins</h3>
      <div class="oc-cmds">
        ${cmd("cc", "Claude Code: then /plugin install amem@amem (MCP, hooks, skills)", "/plugin marketplace add sslugic/amem")}
        ${cmd("codex", "Codex: then /plugins → amem", "codex plugin marketplace add sslugic/amem")}
        ${cmd("gemini", "Gemini CLI", "gemini extensions install https://github.com/sslugic/amem")}
      </div>
      <p class="setup-note">All of them run amem locally with <code>npx</code> (Node 20+); memory stays in <code>~/.amem</code>. Other apps: <a href="https://github.com/sslugic/amem/blob/main/docs/CLIENTS.md" style="color:var(--accent)">setup guide</a>.</p>
    </div>`;
}

function landing() {
  const prim = (n, title, body, eg) =>
    `<article class="prim"><p class="prim-n">${n}</p><h3>${title}</h3><p>${body}</p><p class="eg">${eg}</p></article>`;
  const setupTab = (id, label, active) =>
    `<button type="button" class="cmd-tab${active ? " active" : ""}" data-cmd="${id}" role="tab" aria-selected="${active ? "true" : "false"}">${label}</button>`;
  const setupPanel = (id, cmd, note, active) => `<div class="cmd-panel${active ? " active" : ""}" data-panel="${id}">
      <div class="cmd-row"><code id="setup-${id}">${cmd}</code><button type="button" class="btn compact" data-copy="setup-${id}">Copy</button></div>
      <p class="setup-note">${note}</p>
    </div>`;
  const mcpJson = `{
  "mcpServers": {
    "amem": { "command": "npx", "args": ["-y", "@iamem/amem", "mcp"] }
  }
}`;
  const row = (label, us, saas, logs, local) =>
    `<tr><th scope="row">${label}</th><td class="us">${us}</td><td>${saas}</td><td>${logs}</td><td>${local}</td></tr>`;
  const Y = (t) => `<span class="y">✓</span> ${t}`;
  const N = (t) => `<span class="n">✕</span> ${t}`;
  const M = (t) => `<span class="m">~</span> ${t}`;
  const faq = (q, a) => `<details><summary>${q}</summary><p>${a}</p></details>`;

  return siteChrome(
    "start",
    `<main>
  <section class="lp-hero">
    <div class="hero-art" aria-hidden="true"><img src="/public/amem-ui.png" alt="" width="1600" height="1000"/></div>
    <div class="lp-hero-in">
      <div>
        <p class="lp-eyebrow">100% Local • Zero Cloud • Single SQLite File</p>
        <h1 class="lp-h1">Stop paying your AI agent to re-learn your codebase every session.</h1>
        <p class="lp-sub">amem gives Claude Code, Cursor, Codex, and Windsurf persistent file-anchored facts, on-demand skills, and a shared task board, stored locally in <code>~/.amem</code> with zero API keys, zero embedding daemons, and zero SaaS fees.</p>
        ${installCommands(false)}
        <p class="lp-cta2">Then open the local UI: <code>amem ui</code> <span>→ 127.0.0.1:7843</span></p>
        <ul class="lp-facts"><li>Free &amp; open source</li><li>Any MCP client</li><li>Node 20+</li><li><a href="https://github.com/sslugic/amem" style="color:inherit">Source on GitHub</a></li></ul>
      </div>
      <div class="mock" role="group" aria-label="Preview of the amem ui dashboard">
        <div class="mock-bar"><i></i><i></i><i></i><span>127.0.0.1:7843 · amem ui</span></div>
        <div class="mock-tabs" role="tablist">
          <button type="button" class="mock-tab active" data-mock="facts" role="tab" aria-selected="true">Facts</button>
          <button type="button" class="mock-tab" data-mock="review" role="tab" aria-selected="false">Review queue</button>
          <button type="button" class="mock-tab" data-mock="tasks" role="tab" aria-selected="false">Tasks</button>
        </div>
        <div class="mock-pane active" data-pane="facts">
          <div class="mf"><span class="pill pin">pinned</span><b>Webhooks require the raw body for signature checks.</b><small>gotcha · src/webhooks/stripe.ts</small></div>
          <div class="mf"><span class="pill stale">stale</span><b>Migrations run with <code>pnpm db:migrate</code> before tests.</b><small>howto · package.json changed after this fact</small></div>
          <div class="mf"><span class="pill ok">fresh</span><b>JWT login middleware validates the session on every API call.</b><small>constraint · src/auth/middleware.ts</small></div>
          <div class="mf"><span class="pill">expires 2d</span><b>Staging queue consumer paused during the incident.</b><small>session · ttl 2 days</small></div>
        </div>
        <div class="mock-pane" data-pane="review">
          <div class="mr"><span>Release steps for the iOS app <em class="pill">new skill</em></span><span class="mr-act"><span class="y">Keep</span><span>Dismiss</span></span></div>
          <div class="mr"><span>“Retry webhooks 5× not 3×” replaces an older fact</span><span class="mr-act"><span class="y">Retire old</span><span>Keep both</span></span></div>
          <div class="mr"><span>3 facts point at files that changed</span><span class="mr-act"><span class="y">Review</span></span></div>
        </div>
        <div class="mock-pane" data-pane="tasks">
          <div class="board">
            <div class="col"><h4>Backlog</h4><div class="card">Coverage for refund webhooks<em>from Cursor</em></div><div class="card">Rotate signing secret</div></div>
            <div class="col"><h4>Next</h4><div class="card">Drop legacy login page</div></div>
            <div class="col doing"><h4>Doing</h4><div class="card">Fix OAuth redirect loop<em>Claude Code · now</em></div></div>
            <div class="col done"><h4>Done</h4><div class="card">Pin Node 20 in CI</div></div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="sec" id="how">
    <div class="sec-head">
      <p class="sec-kicker">How it works</p>
      <h2>Three primitives. One local file.</h2>
      <p class="sec-lead">Hooks hand your agent a small, ranked packet at session start and on each prompt. It reads facts first and opens files second.</p>
    </div>
    <div class="prim-grid">
      ${prim("01 / facts", "File-anchored facts, with automatic staleness detection", "Memories bind directly to the source files they describe. When those files change, amem flags every dependent fact as stale for review, so outdated rules never poison future prompts.", "“Webhooks require the raw body for signature checks.” → <code>src/webhooks/stripe.ts</code>")}
      ${prim("02 / skills", "On-demand skills", "Store repeatable workflows like release, deploy or migration procedures. Agents see a one-line index and load the full steps only when relevant, instead of bloating every system prompt.", "<code>files: [\"*.swift\"]</code> → hint: <b>ios-release</b> applies here")}
      ${prim("03 / tasks", "Cross-agent task board", "A persistent Backlog → Next → Doing → Done board that every agent reads and updates. Start a task in Cursor and pick up the exact state in Claude Code.", "<code>amem_task_update { status: \"doing\" }</code>")}
    </div>
  </section>

  <section class="sec" id="features">
    <div class="sec-head">
      <p class="sec-kicker">Everything in the box</p>
      <h2>What else amem does for your agents</h2>
    </div>
    <div class="feat-grid">${featureCardsHtml()}</div>
  </section>

  <section class="sec" id="compare">
    <div class="sec-head">
      <p class="sec-kicker">Why developers switch</p>
      <h2>amem vs. the alternatives</h2>
      <p class="sec-lead">Different tools solve different problems. Here is where amem sits.</p>
    </div>
    <div class="cmp-wrap">
      <table class="cmp">
        <thead><tr>
          <th scope="col"></th>
          <th scope="col" class="us">amem</th>
          <th scope="col">Cloud memory SaaS<small>Mem0, Supermemory</small></th>
          <th scope="col">Session-capture plugins<small>claude-mem</small></th>
          <th scope="col">Local Markdown knowledge bases<small>Basic Memory</small></th>
        </tr></thead>
        <tbody>
          ${row("Price", Y("Free, open source"), M("Free tier, then paid plans"), Y("Free; summaries spend your Claude tokens"), M("Free locally; paid cloud sync"))}
          ${row("Data privacy", Y("One SQLite file in ~/.amem; UI binds to 127.0.0.1"), N("Stored on the vendor's servers (self-host options vary)"), M("Local files; sessions are summarized by an LLM call"), Y("Local Markdown files"))}
          ${row("Stale-fact detection", Y("Facts anchored to files, flagged when those files change"), N("Not tied to your source files"), N("Not tied to your source files"), N("Notes are edited by hand"))}
          ${row("Cross-IDE support", Y("Claude Code, Cursor, Codex, Windsurf, Copilot, Zed + any MCP client"), M("Through their API or MCP server"), M("Built for Claude Code"), Y("Any MCP client"))}
          ${row("Setup overhead", Y("<code>npx @iamem/amem setup</code>. No keys, no daemons"), M("Account + API key"), M("Plugin + background worker + vector DB"), M("Python install + MCP config"))}
          ${row("Visual UI", Y("Local dashboard: facts, review queue, tasks, activity"), Y("Hosted web dashboard"), Y("Local web viewer"), M("Your editor or Obsidian"))}
        </tbody>
      </table>
    </div>
    <p class="cmp-note"><b>Fewer wasted input tokens:</b> amem injects a small, ranked, file-anchored packet, capped with <code>max_tokens</code>, instead of replaying raw transcripts or making the agent grep the tree to rebuild context every session.</p>
    <p class="cmp-src"><a href="/fact-sheet" style="color:var(--accent)">Read the technical fact sheet →</a> architecture, budgets and the full cost comparison.</p>
    <p class="cmp-src">Comparison based on each project's public docs as of November 2026: <a href="https://mem0.ai/pricing">Mem0</a>, <a href="https://supermemory.ai/pricing">Supermemory</a>, <a href="https://github.com/thedotmack/claude-mem">claude-mem</a>, <a href="https://github.com/basicmachines-co/basic-memory">Basic Memory</a>. Spot something out of date? <a href="https://github.com/sslugic/amem/issues">Tell us</a>.</p>
  </section>

  <section class="sec" id="setup">
    <div class="sec-head">
      <p class="sec-kicker">One-command setup</p>
      <h2>Works with every client you already use</h2>
      <p class="sec-lead">Setup installs the CLI, wires the hooks, registers the MCP server and seeds the repo with build, test and CI facts from its manifests. Using Claude Desktop, Gemini CLI, Antigravity, Perplexity, Warp, JetBrains or LM Studio? <a href="https://github.com/sslugic/amem/blob/main/docs/CLIENTS.md" style="color:var(--accent)">Step-by-step setup for every app →</a></p>
    </div>
    ${oneClickInstalls()}
    <p class="setup-note" style="margin:1.2rem 0 .6rem">Or run setup from your terminal; it also seeds the repo with build and test facts:</p>
    <div class="cmd-box setup-box">
      <div class="cmd-tabs" role="tablist">
        ${setupTab("claude", "Claude Code", true)}
        ${setupTab("cursor", "Cursor")}
        ${setupTab("codex", "Codex")}
        ${setupTab("copilot", "Copilot")}
        ${setupTab("windsurf", "Windsurf")}
        ${setupTab("json", "Manual MCP JSON")}
      </div>
      ${setupPanel("claude", "npx @iamem/amem setup --platform claude", "Adds SessionStart + prompt hooks and the MCP server. Restart Claude Code once.", true)}
      ${setupPanel("cursor", "npx @iamem/amem setup --platform cursor", "Registers the MCP server and writes .cursor/rules/amem.mdc. Reload the window once.")}
      ${setupPanel("codex", "npx @iamem/amem setup --platform codex", "Writes AGENTS.md so Codex checks amem first. Add the MCP entry from the Manual MCP JSON tab to Codex's config.")}
      ${setupPanel("copilot", "npx @iamem/amem setup --platform copilot", "Writes .github/copilot-instructions.md. Add the MCP entry from the Manual MCP JSON tab in VS Code.")}
      ${setupPanel("windsurf", "npx @iamem/amem setup --platform windsurf", "Writes the Windsurf MCP config.")}
      <div class="cmd-panel" data-panel="json">
        <div class="cmd-row" style="align-items:flex-start"><pre id="setup-json">${mcpJson}</pre><button type="button" class="btn compact" data-copy="setup-json">Copy</button></div>
        <p class="setup-note">Paste into any MCP client's config (Zed, Gemini CLI, Continue, JetBrains…). <code>amem platforms</code> lists 30+ clients.</p>
      </div>
    </div>
  </section>

  <section class="sec" id="faq">
    <div class="sec-head"><p class="sec-kicker">FAQ</p><h2>Questions developers ask first</h2></div>
    <div class="faq">
      ${faq("Does anything leave my machine?", "No. Everything stays in <code>~/.amem</code>: one SQLite file, skills as Markdown, a dashboard bound to 127.0.0.1. Optional AES-256-GCM encryption at rest and scheduled local backups. Secrets are redacted before anything is saved. The anonymous usage ping is opt-in and off by default.")}
      ${faq("Do I need Ollama or OpenAI keys?", "No. Search is SQLite FTS5 (BM25) plus small on-device embeddings that run in-process: no model downloads, no embedding daemon, no API keys.")}
      ${faq("How do I uninstall cleanly?", "Run <code>amem uninstall</code> to see exactly what it added, then <code>amem uninstall --yes</code>. Your memory stays unless you add <code>--purge</code>. <code>amem export --format md</code> first if you want a copy.")}
      ${faq("Can I bring my existing CLAUDE.md or .cursorrules?", "Yes. <code>amem import .</code> turns CLAUDE.md, AGENTS.md, .cursorrules and .cursor/rules/*.mdc into facts and tasks. Running it twice adds nothing new.")}
    </div>
  </section>
  ${closerHtml("Give your agents a memory", "Free. One command. Everything stays on your machine.")}
</main>
<footer class="foot"><div class="foot-in">
  <span>amem · agent memory, anchored to your code · MIT</span>
  <nav aria-label="Footer"><a href="/fact-sheet">Fact sheet</a><a href="/features">Features</a><a href="/why">Why amem</a><a href="/what">How it works</a><a href="https://github.com/sslugic/amem/blob/main/docs/CLIENTS.md">Connect your AI tools</a><a href="https://github.com/sslugic/amem">GitHub</a><a href="https://www.npmjs.com/package/@iamem/amem">npm</a></nav>
</div></footer>`,
    "amem — agent memory, anchored to your code",
  );
}


function factSheetPage() {
  const kv = (k, v) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`;
  const mech = (title, items) => `<article class="what-card"><h3>${title}</h3><ul class="what-list">${items.map((i) => `<li>${i}</li>`).join("")}</ul></article>`;
  const row = (label, a, b, c, d) => `<tr><th scope="row">${label}</th><td class="us">${a}</td><td>${b}</td><td>${c}</td><td>${d}</td></tr>`;
  return siteChrome(
    "facts",
    `<main class="what">
  <p class="sec-kicker">Technical fact sheet</p>
  <h1>amem: architecture and token savings</h1>
  <p class="what-lead">A local-first SQLite + MCP memory layer for AI coding agents. Every number here is reproducible: run <code>npm run bench</code>, <code>amem bootstrap --json</code> or the MCP <code>tools/list</code> call yourself.</p>
  <table class="what-table">
    ${kv("Product", '<code>amem</code> · npm <a href="https://www.npmjs.com/package/@iamem/amem" style="color:var(--accent)">@iamem/amem</a> · <a href="https://github.com/sslugic/amem" style="color:var(--accent)">sslugic/amem</a>')}
    ${kv("Category", "Local-first SQLite + Model Context Protocol (MCP) memory layer for AI coding agents")}
    ${kv("Storage", "One SQLite file, <code>~/.amem/graph.db</code> (skills as Markdown in <code>~/.amem/skills</code>). No daemons, no cloud, no API keys.")}
    ${kv("Runtime", "Node 20+, one dependency (<code>better-sqlite3</code>). MCP over stdio (<code>amem mcp</code>) or HTTP on <code>127.0.0.1:7843</code>.")}
    ${kv("License", "MIT")}
  </table>

  <h2>1. What amem does</h2>
  <div class="what-grid">
    <article class="what-card"><h3>File-anchored facts</h3><p>Rules and decisions tied to the files they describe, such as <em>“Stripe webhooks must be verified with the raw body”</em> → <code>src/webhooks/stripe.ts</code>. Each fact stores a content hash of its files; when a file changes, the fact is flagged <code>stale</code> until re-confirmed.</p></article>
    <article class="what-card"><h3>On-demand skills</h3><p>Multi-step procedures (release, deploy, migration) live outside the system prompt as <code>SKILL.md</code>. Agents see a one-line index entry and load the body with <code>amem_skill_view</code> only when it applies.</p></article>
    <article class="what-card"><h3>Cross-agent task board</h3><p>A persistent <code>backlog → next → doing → blocked → done</code> board per project. A task started in Cursor shows its state to Claude Code or Codex next session.</p></article>
    <article class="what-card"><h3>Every client</h3><p>Claude Code, Cursor, Codex, Windsurf, Copilot, Gemini CLI, Zed and any MCP client (<code>amem platforms</code> lists 30+). Hooks inject a ranked packet automatically; agents can also call the tools.</p></article>
  </div>

  <h2>2. How it works</h2>
  <div class="what-grid">
    ${mech("SQLite FTS5 + BM25", ["Facts in <code>claims_fts</code>, skills and tasks in <code>amem_fts</code> (porter tokenizer), synced on every write.", "<code>amem_search</code> ranks by <code>bm25()</code> plus recency, usage, pins and status; filters: types, scope, status, tags.", "Small synonym groups: “auth flow” finds “JWT login middleware”.", "<code>amem_context</code> adds a 256-dimension in-process n-gram encoder: no download, no Ollama, no Python.", "No FTS5 in the SQLite build? Falls back to keyword scoring."])}
    ${mech("Scope and <code>amem_bootstrap</code>", ["<code>global</code> rules reach every project; <code>project:&lt;path&gt;</code> facts stay with their repo; private facts never reach work.", "One startup call returns global rules, key facts, active tasks (doing first) and skill hints.", "Capped at <code>max_tokens</code>: default 350, measured 313 on a 3,400-fact memory."])}
    ${mech("Token budgets (<code>max_tokens</code>)", ["On <code>amem_context</code> and <code>amem_search</code>; about 4 characters per token, deterministic.", "Packed in rank order, never cut mid-item; the best fact always stays.", "Reports <code>truncated</code> and <code>omitted</code> so the agent knows what it left out."])}
    ${mech("Skill trigger hints", ["Frontmatter <code>files: [\"*.swift\", \"Package.swift\"]</code> and <code>keywords: [deploy, migration]</code>.", "Matching files or text return a one-line hint (name, what matched, summary).", "The body loads only through <code>amem_skill_view</code>."])}
    ${mech("Supersession and TTL", ["<code>supersedes: [ids]</code> or <code>amem_supersede</code> marks old facts <code>superseded</code> with <code>superseded_by</code>; they stay as history.", "<code>ttl_days</code> or <code>expires_at</code>: expired facts leave recall at once and are kept as <code>expired</code>."])}
    ${mech("UI, import, export", ["<code>amem ui</code>: a localhost dashboard to search, edit, pin, retire and delete facts, review drafts, run the task board and watch live activity.", "<code>amem import</code>: CLAUDE.md, AGENTS.md, .cursorrules, .mdc, Markdown, JSON; content ids mean no duplicates.", "<code>amem export --format json|md</code> keeps lineage, TTL and pins; both formats re-import."])}
  </div>
  <table class="what-table" style="margin-top:1rem">
    <thead><tr><th>Retrieval benchmark (<code>npm run bench</code>, enforced in CI)</th><td>Right first</td><td>Top 3</td><td>Vague prompts given memory</td></tr></thead>
    <tr><th scope="row">Prompt hook (automatic)</th><td>88%</td><td>97%</td><td>0%</td></tr>
    <tr><th scope="row"><code>amem_context</code> (agent asks)</th><td>81%</td><td>94%</td><td>n/a</td></tr>
  </table>

  <h2>3. Cost and token economics</h2>
  <div class="cmp-wrap">
    <table class="cmp">
      <thead><tr><th scope="col"></th><th scope="col" class="us">amem</th><th scope="col">Cloud memory SaaS<small>Mem0, Supermemory, Zep</small></th><th scope="col">Session-capture plugins<small>claude-mem</small></th><th scope="col">Local note tools<small>Basic Memory</small></th></tr></thead>
      <tbody>
        ${row("Hosting cost", "$0: local SQLite", "Free tiers; paid plans from about $19/mo", "$0: local", "$0 locally; optional paid sync")}
        ${row("Background LLM extraction", "None: no model calls", "Yes: an LLM extracts or updates memories on write", "Yes: sessions summarized with Claude, on your tokens", "None: the agent writes notes")}
        ${row("Tool-schema overhead", "18 MCP tools ≈ 2,800 tokens (fixed, cacheable)", "Varies by server", "Varies", "Varies by server")}
        ${row("Per-call payload", "Ranked packet; <code>max_tokens</code> cap; bootstrap ≤ 350 by default; skills as one-line hints", "Top-K memories from vector search", "Summaries injected at session start", "Whole notes read on request")}
        ${row("Outdated rules", "File-hash staleness, supersession, TTL", "LLM update and merge; not tied to files", "Accumulate; not tied to files", "Edited by hand")}
      </tbody>
    </table>
  </div>
  <div class="what-grid" style="margin-top:1rem">
    <article class="what-card"><h3>1 · Fewer uncached input tokens</h3><p>Tool results are new content on every call, so caching never discounts them. <code>max_tokens</code> caps the packet, and skills arrive as one-line hints, not procedures.</p></article>
    <article class="what-card"><h3>2 · Fewer startup round-trips</h3><p>One ~350-token <code>amem_bootstrap</code> replaces separate lookups for rules, facts, tasks and skills; BM25 plus synonyms raises first-pass recall.</p></article>
    <article class="what-card"><h3>3 · Fewer wasted output tokens</h3><p>Output costs several times more than input and is never cache-discounted. Superseded, expired and stale facts are filtered or marked before they steer a wrong edit.</p></article>
    <article class="what-card"><h3>4 · A stable, cacheable tool prefix</h3><p>The MCP tool list is fixed per version, and <code>amem ui</code>/<code>import</code>/<code>export</code> are CLI-only. Memory arrives after that prefix as hook output or tool results. Fixed cost: the ~2,800-token schema, billed in full once, then at the cache-read rate where providers cache.</p></article>
  </div>
  <p class="cmp-src">Measure it on your own machine: <code>amem stats</code> for hit rate and estimated savings; <code>amem_usage_report</code> to turn the estimate into a measurement from the files the agent did not need to open. Sources, checked November 2026: <a href="https://mem0.ai/pricing">Mem0</a>, <a href="https://supermemory.ai/pricing">Supermemory</a>, <a href="https://www.getzep.com">Zep</a>, <a href="https://github.com/thedotmack/claude-mem">claude-mem</a>, <a href="https://github.com/basicmachines-co/basic-memory">Basic Memory</a>. Markdown version: <a href="https://github.com/sslugic/amem/blob/main/docs/FACT_SHEET.md">docs/FACT_SHEET.md</a>.</p>
  ${closerHtml("Try it in one command", "Free. Everything stays on your machine.")}
</main>`,
    "amem — technical fact sheet",
  );
}

function whatPage() {
  return siteChrome(
    "what",
    `<main class="what">
  <h1>How amem works</h1>
  <p class="what-lead">Coding agents forget between sessions. They re-grep the same tree, re-learn the same constraints, and burn tokens rediscovering decisions you already paid for. amem is a private local sidecar so the next session starts oriented.</p>

  <h2>The problems</h2>
  <table class="what-table">
    <thead><tr><th>Without it</th><th>With it</th></tr></thead>
    <tbody>
      <tr><th>Agent explores broadly every session</th><td>It queries memory first, then verifies the right files</td></tr>
      <tr><th>Decisions die in chat scrollback</th><td>They become claims with file anchors and a Why line</td></tr>
      <tr><th>The same deploy dance is rediscovered</th><td>A skill loads only when that work comes up again</td></tr>
      <tr><th>“Do this later” vanishes when the tab closes</th><td>A Kanban the agent can add, move, and complete</td></tr>
      <tr><th>Pressure to dump context into a shared wiki</th><td>Explicitly personal — prompts and learnings stay on the laptop</td></tr>
      <tr><th>A flat AGENTS.md that goes stale</th><td>A small graph: components → flows → claims, updated as drafts</td></tr>
    </tbody>
  </table>

  <h2>How a day goes</h2>
  <ol class="what-list">
    <li>You (or the hook) run a context lookup. Matching claims, open tasks, and skill names land in the prompt.</li>
    <li>The agent prefers those file anchors over a broad explore, then verifies the current code — memory can be stale.</li>
    <li>When something durable is learned, it remembers a fact or saves a skill. Follow-ups go on the board.</li>
    <li>At session end, amem may queue a compact memory draft, a miss→learn draft, or one skill suggestion. You approve in the UI.</li>
  </ol>

  <h2>Privacy, on purpose</h2>
  <ul class="what-list">
    <li>The tool is public (GitHub / npm). Your database is <code>~/.amem/graph.db</code> and is not shared.</li>
    <li>The Cursor rule you commit is guidance only — no memory contents.</li>
    <li>The UI binds to <code>127.0.0.1</code>. There is no “share with org” mode and no cloud embed API.</li>
    <li>Optional anonymous install ping (package version, Node, OS). Opt out with <code>AMEM_TELEMETRY_DISABLED=1</code>.</li>
  </ul>

  <h2>Security &amp; Architecture FAQ</h2>
  <div class="what-grid">
    <article class="what-card">
      <h3>Anti-poisoning &amp; injection defenses</h3>
      <p>How does amem prevent poisoned chat or malicious prompt injections from corrupting memory? Ingestion runs through syntactic fact filters (<code>isFactLike</code>), secret deny patterns, quality scoring, and a default staged review queue (<code>ProposalDraft</code>) before anything is applied.</p>
    </article>
    <article class="what-card">
      <h3>Scope isolation &amp; anti-bleed</h3>
      <p>Every claim, task, and note is strictly partitioned by repository (<code>repo_id</code>). Context packets are tightly ranked via hybrid BM25 + vector search and hard-capped at 2.4KB to avoid prompt stuffing and cross-project leaks.</p>
    </article>
    <article class="what-card">
      <h3>Staleness &amp; code drift</h3>
      <p>Claims are tied to file anchors. If anchored files are edited or deleted, amem automatically marks claims stale, applies a ranking penalty, and warns the model to verify before trusting.</p>
    </article>
    <article class="what-card">
      <h3>Localhost &amp; zero egress</h3>
      <p>The daemon strictly binds to <code>127.0.0.1</code>, telemetry is forced off, and local databases use <code>0700</code> permissions with optional AES-256-GCM encryption at rest.</p>
    </article>
  </div>

  <h2>Not this</h2>
  <ul class="what-list">
    <li>Not a company wiki or a hosted RAG product.</li>
    <li>Not an agent runtime — Cursor and Claude still do the work. amem is the librarian.</li>
    <li>Not a replacement for reading the code. Trust fresh claims; re-check anything marked stale.</li>
  </ul>

  <div class="what-cta">
    <p>One command. Then the UI.</p>
    ${installCommands()}
  </div>
</main>`,
    "amem — how it works",
  );
}

function pricingPage() {
  return siteChrome(
    "pricing",
    `<main class="plans-wrap">
  <h1>Everything is free</h1>
  <p class="plans-lead">amem has no plans, no tiers, and nothing held back. Every feature — local embeddings, memory hygiene and its schedule, rules sync, the attestation packet — is included for everyone. Memory never leaves the laptop.</p>
  <div class="plan-grid">
    <article class="plan-card featured">
      <h2>amem</h2>
      <p class="plan-price">$0</p>
      <ul>
        <li>Memory UI, MCP, Stats</li>
        <li>Local embeddings and ranking</li>
        <li>Automatic memory hygiene</li>
        <li>Pin facts &rarr; Cursor rules</li>
        <li>Lock + local backup</li>
        <li><code>amem doctor --attest</code> packet</li>
      </ul>
      <a class="btn" href="/">Get started</a>
    </article>
  </div>
  <p class="fine">No license file, no license server, no telemetry beyond the optional anonymous install ping.</p>
</main>`,
    "amem — free",
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

function readRaw(req, maxBytes = Infinity) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
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
      const [hits, usage, npm] = await Promise.all([
        getHitStats({ days }),
        getUsageStats({ days }),
        getNpmDownloads(),
      ]);
      json(res, 200, { ...hits, usage, npm });
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
    if (req.method === "POST" && url.pathname === "/api/beacon/usage") {
      let body = null;
      try {
        const raw = await readRaw(req, 8192);
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        body = null;
      }
      const row = body && typeof body === "object" ? recordUsage(req, body) : null;
      res.writeHead(row ? 204 : 400);
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
    if (req.method === "GET" && (url.pathname === "/fact-sheet" || url.pathname === "/facts")) {
      html(res, 200, factSheetPage());
      return;
    }
    if (req.method === "GET" && url.pathname === "/what") {
      html(res, 200, whatPage());
      return;
    }
    if (req.method === "GET" && url.pathname === "/features") {
      html(res, 200, featuresPage());
      return;
    }
    if (req.method === "GET" && url.pathname === "/why") {
      html(res, 200, whyPage());
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
