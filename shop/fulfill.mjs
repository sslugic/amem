import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TIERS = Object.freeze({
  pro: { label: "amem Pro", amountCents: 1200 },
  it: { label: "amem IT", amountCents: 4900 },
});

export function normalizeTier(raw) {
  const tier = String(raw || "")
    .trim()
    .toLowerCase();
  return tier === "pro" || tier === "it" ? tier : null;
}

export function buyerEmail(session) {
  const email =
    session?.customer_details?.email ||
    session?.customer_email ||
    session?.metadata?.email ||
    "";
  const trimmed = String(email).trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : "";
}

export function licensePayload({ tier, email, now = new Date(), features = [] }) {
  const normalized = normalizeTier(tier);
  if (!normalized) throw new Error("tier must be pro or it");
  if (!email) throw new Error("buyer email is required");
  return {
    tier: normalized,
    subject: String(email).trim().toLowerCase(),
    issued_at: now.toISOString(),
    features: [...features],
  };
}

export function licenseEmailCopy({ tier, jsonText }) {
  const label = TIERS[tier]?.label || `amem ${tier}`;
  const subject = `Your ${label} license`;
  const text = [
    `Thanks for buying ${label}.`,
    "",
    "Memory still never leaves your machine. This file only unlocks local extras.",
    "",
    "Save the attached JSON (or the block below), then on that machine:",
    "",
    "  amem license apply --file ~/Downloads/amem-license.json",
    "  amem license status",
    "",
    jsonText,
    "",
    "Keep the file. There is no license server — amem verifies the signature offline.",
  ].join("\n");
  const escaped = escapeHtml(jsonText);
  const html = `<p>Thanks for buying <strong>${escapeHtml(label)}</strong>.</p>
<p>Memory still never leaves your machine. This file only unlocks local extras.</p>
<p>Save the attached JSON, then:</p>
<pre>amem license apply --file ~/Downloads/amem-license.json
amem license status</pre>
<pre>${escaped}</pre>
<p>Keep the file. There is no license server — amem verifies the signature offline.</p>`;
  return { subject, text, html };
}

export function loadFulfilled(path) {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function rememberFulfilled(path, sessionId, record) {
  const id = String(sessionId || "").trim();
  if (!id) return { duplicate: false, store: loadFulfilled(path) };
  const store = loadFulfilled(path);
  if (store[id]) return { duplicate: true, store, record: store[id] };
  store[id] = record;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  return { duplicate: false, store, record };
}

export function sessionIdOk(sessionId) {
  return /^cs_[A-Za-z0-9_]+$/.test(String(sessionId || ""));
}

export function issuedLicensePath(dir, sessionId) {
  if (!sessionIdOk(sessionId)) throw new Error("invalid checkout session id");
  return join(dir, `${sessionId}.json`);
}

export function readIssuedLicense(dir, sessionId) {
  const path = issuedLicensePath(dir, sessionId);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export function writeIssuedLicense(dir, sessionId, jsonText) {
  const path = issuedLicensePath(dir, sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, jsonText.endsWith("\n") ? jsonText : `${jsonText}\n`, { mode: 0o600 });
  return path;
}

export function sessionPaid(session) {
  return session?.payment_status === "paid" || session?.status === "complete";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
