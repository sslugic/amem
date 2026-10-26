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

function siteChrome(active, body, title = "amem — get started") {
  const tab = (id, href, label) =>
    `<a class="nav-tab${active === id ? " active" : ""}" href="${href}">${label}</a>`;
  return htmlPage(
    title,
    `<div class="shell">
  <header class="top">
    <a class="brand" href="/">amem</a>
    <nav class="nav" aria-label="Site">
      ${tab("start", "/", "Start")}
      ${tab("features", "/features", "Features")}
      ${tab("why", "/why", "Why amem")}
      ${tab("what", "/what", "How it works")}
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
<p class="cmd-hint">Node 20+. Then run <code>amem ui</code>. Source on <a href="https://github.com/sslugic/amem">GitHub</a>.</p>`;
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
      "Search that finds the right thing", "Keyword search, on-device embeddings, pins and freshness ranked together. A small, focused packet, not a dump of everything.", "Capped packet, no prompt stuffing"],
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

  return { features, why };
}

function featuresPage() {
  return siteChrome("features", `<main>${siteSections().features}</main>`, "amem — features");
}

function whyPage() {
  return siteChrome("why", `<main>${siteSections().why}</main>`, "amem — why it pays off");
}

function landing() {
  const jump = (href, title, line) =>
    `<a class="hero-jump" href="${href}"><strong>${title}</strong><span>${line}</span></a>`;
  return siteChrome(
    "start",
    `<main>
  <section class="hero hero-full">
    <div class="hero-art" aria-hidden="true">
      <img src="/public/amem-ui.png" alt="" width="1600" height="1000"/>
    </div>
    <div class="hero-panel">
      <p class="hero-kicker">Local agent memory</p>
      <p class="hero-brand">amem</p>
      <h1>Everything is free</h1>
      <p class="hero-lead">Agents forget. amem does not. Memory, skills, tasks and the desktop app give every coding agent what it learned last time. Facts stay in <code>~/.amem</code> on your machine. One command, then open the UI.</p>
      ${installCommands()}
      <nav class="hero-jumps" aria-label="Learn more">
        ${jump("/features", "Features", "Everything in the box")}
        ${jump("/why", "Why amem", "Time, speed and money")}
        ${jump("/what", "How it works", "A day with amem, privacy")}
      </nav>
    </div>
  </section>
</main>`,
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
