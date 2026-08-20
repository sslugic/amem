#!/usr/bin/env node
/**
 * Seller webhook + Checkout. Not part of the published `amem` CLI.
 * Memory never leaves the buyer’s machine — this process only emails a signed JSON file.
 */
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
import { sendLicenseMail } from "./mail.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, "..");
const DATA = join(ROOT, ".data");
const FULFILLED = join(DATA, "fulfilled.json");
const LICENSES = join(DATA, "licenses");
const PRIV_FILE = join(DATA, "license.priv");
const SHOP_DOTENV = join(ROOT, ".env");

hydrateEnv();

const PORT = Number(process.env.AMEM_SHOP_PORT || 8788);
/** Loopback for local seller process; App Runner / containers use 0.0.0.0 */
const HOST = process.env.AMEM_SHOP_HOST || "127.0.0.1";
const PUBLIC_URL = (process.env.AMEM_SHOP_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const CANONICAL_HOST = (process.env.AMEM_SHOP_CANONICAL_HOST || "").toLowerCase().replace(/:\d+$/, "");

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

function siteChrome(_active, body) {
  return htmlPage(
    "amem — get started",
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
</style></head><body>${body}</body></html>`;
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
      <code id="cmd-npx">npx amem setup</code>
      <button type="button" class="btn compact" data-copy="cmd-npx">Copy</button>
    </div>
  </div>
  <div class="cmd-panel" data-panel="global">
    <div class="cmd-row">
      <code id="cmd-global">npm i -g amem &amp;&amp; amem setup</code>
      <button type="button" class="btn compact" data-copy="cmd-global">Copy</button>
    </div>
  </div>
</div>
<p class="cmd-hint">Node 20+. Then <code>amem ui</code> — upgrade to Pro there when you want it. Until npm is live, clone from <a href="https://github.com/sslugic/amem">GitHub</a>.</p>`;
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
    <h1>Get started for free</h1>
    <p class="hero-lead">Facts stay in <code>~/.amem</code> on your machine. One command — then open the UI. Upgrade to Pro later inside the app if you want richer retrieval and hygiene.</p>
    ${installCommands()}
  </div>
</main>`,
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
<p>Keep this tab and retry, or open the Mailtrap inbox. Do not pay again.</p>
<p class="actions"><a class="btn secondary" href="/">Get started</a></p></div>`,
    );
  }
  const mailNote = result.emailed
    ? result.mode === "testing"
      ? `<p>A copy is in the <strong>Mailtrap sandbox inbox</strong> (testing mode), not a real mailbox.</p>`
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
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      html(res, 200, landing());
      return;
    }
    if (req.method === "GET" && url.pathname === "/plans") {
      res.writeHead(302, { Location: "/" });
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
});
