import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyShopEnv, parseDotEnv, pickShopEnv, SHOP_ENV_KEYS } from "../shop/env.mjs";
import {
  buyerEmail,
  licenseEmailCopy,
  licensePayload,
  normalizeTier,
  rememberFulfilled,
  sessionIdOk,
  sessionPaid,
  writeIssuedLicense,
} from "../shop/fulfill.mjs";
import { mailFromAddress, mailFromName, mailtrapClientOptions, mailtrapTesting } from "../shop/mail.mjs";

describe("shop status API helper", () => {
  it("defaults to public getamem.com shop URLs", async () => {
    const prev = process.env.AMEM_SHOP_URL;
    const prevLocal = process.env.AMEM_SHOP_LOCAL;
    delete process.env.AMEM_SHOP_URL;
    delete process.env.AMEM_SHOP_LOCAL;
    const { shopStatus } = await import("../dist/shop.js");
    const status = shopStatus();
    assert.equal(status.url, "https://getamem.com");
    assert.equal(status.enabled, true);
    assert.equal(status.proUrl, "https://getamem.com/buy/pro");
    assert.equal(status.proPrice, "$12");
    assert.equal(status.itPrice, "$49");
    if (prev === undefined) delete process.env.AMEM_SHOP_URL;
    else process.env.AMEM_SHOP_URL = prev;
    if (prevLocal === undefined) delete process.env.AMEM_SHOP_LOCAL;
    else process.env.AMEM_SHOP_LOCAL = prevLocal;
  });
});

describe("shop env whitelist", () => {
  it("parses dotenv and drops non-shop secrets", () => {
    const parsed = parseDotEnv(`
# comment
MAILTRAP_TOKEN=mt_test
STRIPE_SECRET_KEY=sk_test_x
AWS_SECRET_ACCESS_KEY=should-never-load
OPENAI_API_KEY=sk-openai
GITHUB_CLIENT_SECRET=gh
INVITE_FROM_EMAIL=notifications@testera.io
EMPTY=
`);
    const picked = pickShopEnv(parsed);
    assert.equal(picked.MAILTRAP_TOKEN, "mt_test");
    assert.equal(picked.STRIPE_SECRET_KEY, "sk_test_x");
    assert.equal(picked.INVITE_FROM_EMAIL, "notifications@testera.io");
    assert.equal(picked.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(picked.OPENAI_API_KEY, undefined);
    assert.equal(picked.GITHUB_CLIENT_SECRET, undefined);
    assert.ok(SHOP_ENV_KEYS.includes("MAILTRAP_TOKEN"));
  });

  it("does not overwrite existing process env unless asked", () => {
    const env = { MAILTRAP_TOKEN: "keep-me", STRIPE_SECRET_KEY: "" };
    applyShopEnv({ MAILTRAP_TOKEN: "new", STRIPE_SECRET_KEY: "sk_from_file" }, env, { overwrite: false });
    assert.equal(env.MAILTRAP_TOKEN, "keep-me");
    assert.equal(env.STRIPE_SECRET_KEY, "sk_from_file");
  });
});

describe("shop fulfill + mail copy", () => {
  it("normalizes tiers and buyer email", () => {
    assert.equal(normalizeTier("PRO"), "pro");
    assert.equal(normalizeTier("free"), null);
    assert.equal(buyerEmail({ customer_details: { email: "A@B.com" } }), "a@b.com");
    assert.equal(buyerEmail({ customer_email: "nope" }), "");
  });

  it("builds a signed-file payload and apply instructions", () => {
    const payload = licensePayload({
      tier: "pro",
      email: "buyer@example.com",
      now: new Date("2026-08-20T12:00:00.000Z"),
      features: ["hygiene"],
    });
    assert.equal(payload.tier, "pro");
    assert.equal(payload.subject, "buyer@example.com");
    const copy = licenseEmailCopy({ tier: "pro", jsonText: '{"kind":"signed"}' });
    assert.match(copy.subject, /amem Pro/);
    assert.match(copy.text, /amem license apply --file/);
    assert.match(copy.html, /amem-license.json/);
  });

  it("stores issued license files under safe session ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "amem-lic-"));
    assert.equal(sessionIdOk("cs_live_abc123"), true);
    assert.equal(sessionIdOk("../etc/passwd"), false);
    assert.equal(sessionPaid({ payment_status: "paid" }), true);
    assert.equal(sessionPaid({ payment_status: "unpaid" }), false);
    const path = writeIssuedLicense(dir, "cs_live_abc123", '{"kind":"signed"}');
    assert.match(path, /cs_live_abc123\.json$/);
    assert.match(readFileSync(path, "utf8"), /signed/);
  });

  it("records Stripe session ids so webhooks are idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "amem-shop-"));
    const path = join(dir, "fulfilled.json");
    const first = rememberFulfilled(path, "cs_1", { email: "a@b.com", tier: "pro" });
    const second = rememberFulfilled(path, "cs_1", { email: "a@b.com", tier: "pro" });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
  });

  it("prefers amem From name over Testera invite branding", () => {
    const env = {
      INVITE_FROM_EMAIL: "notifications@testera.io",
      INVITE_FROM_NAME: "Testera",
      AMEM_FROM_NAME: "amem",
      MAILTRAP_TOKEN: "mt",
      MAILTRAP_USE_TESTING: "true",
      MAILTRAP_TEST_INBOX_ID: "12",
    };
    assert.equal(mailFromAddress(env), "notifications@testera.io");
    assert.equal(mailFromName(env), "amem");
    assert.equal(mailtrapTesting(env), true);
    assert.deepEqual(mailtrapClientOptions(env), { token: "mt", testInboxId: 12 });
  });
});
