/**
 * Load seller-shop secrets from a dotenv file without pulling the rest of
 * another project's env (AWS, GitHub, Slack, OpenAI, …) into this process.
 */
export const SHOP_ENV_KEYS = Object.freeze([
  "AMEM_FROM_EMAIL",
  "AMEM_FROM_NAME",
  "AMEM_LICENSE_PRIVKEY",
  "AMEM_LICENSE_PUBKEY",
  "AMEM_SHOP_ENV",
  "AMEM_SHOP_PORT",
  "AMEM_SHOP_URL",
  "INVITE_FROM_EMAIL",
  "INVITE_FROM_NAME",
  "MAILTRAP_PROJECT_ID",
  "MAILTRAP_TEST_INBOX_ID",
  "MAILTRAP_TOKEN",
  "MAILTRAP_USE_TESTING",
  "STRIPE_AMOUNT_IT_CENTS",
  "STRIPE_AMOUNT_PRO_CENTS",
  "STRIPE_PRICE_IT",
  "STRIPE_PRICE_PRO",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
]);

const KEY_SET = new Set(SHOP_ENV_KEYS);

export function parseDotEnv(text) {
  const out = {};
  if (!text) return out;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function pickShopEnv(all) {
  const picked = {};
  if (!all || typeof all !== "object") return picked;
  for (const key of SHOP_ENV_KEYS) {
    const value = all[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (!text) continue;
    picked[key] = text;
  }
  return picked;
}

export function applyShopEnv(picked, env = process.env, { overwrite = false } = {}) {
  if (!picked) return env;
  for (const [key, value] of Object.entries(picked)) {
    if (!KEY_SET.has(key)) continue;
    if (!overwrite && env[key] && String(env[key]).trim()) continue;
    env[key] = value;
  }
  return env;
}

export function loadShopEnvFromText(text, env = process.env, opts) {
  return applyShopEnv(pickShopEnv(parseDotEnv(text)), env, opts);
}
