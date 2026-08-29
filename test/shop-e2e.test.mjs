import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGitRepo, root } from "./helpers.mjs";

const cli = join(root, "dist", "cli.js");

/** Reproduce the shop's fulfillment chain exactly as server.mjs runs it. */
async function fulfill({ session, privateKeyHex, licenseDir }) {
  const shop = await import("../shop/fulfill.mjs");
  const { signLicense, featuresForTier } = await import("../dist/license.js");

  if (!shop.sessionPaid(session)) return { ok: false, reason: "unpaid" };
  const tier = shop.normalizeTier(session.metadata?.tier);
  if (!tier) return { ok: false, reason: "bad_tier" };
  const email = shop.buyerEmail(session);
  if (!email) return { ok: false, reason: "no_email" };

  const payload = shop.licensePayload({ tier, email, features: featuresForTier(tier) });
  const file = signLicense(privateKeyHex, payload);
  const jsonText = `${JSON.stringify(file, null, 2)}\n`;
  const path = shop.writeIssuedLicense(licenseDir, session.id, jsonText);
  return { ok: true, tier, email, path, jsonText, file };
}

const paidSession = (tier, email = "buyer@example.com", id = "cs_test_abc123") => ({
  id,
  payment_status: "paid",
  customer_details: { email },
  metadata: { tier },
});

describe("shop end-to-end: checkout to a license amem accepts", () => {
  for (const tier of ["pro", "it"]) {
    it(`issues a ${tier} license the CLI applies`, async () => {
      const { generateLicenseKeys } = await import("../dist/license.js");
      const keys = generateLicenseKeys();
      const home = mkdtempSync(join(tmpdir(), `amem-shop-${tier}-`));
      const repoDir = makeGitRepo(`shop-${tier}`);
      try {
        const result = await fulfill({
          session: paidSession(tier),
          privateKeyHex: keys.privateKeyHex,
          licenseDir: join(home, "licenses"),
        });
        assert.equal(result.ok, true);
        assert.equal(result.tier, tier);

        // The buyer's actual next step, verbatim from the email copy.
        const env = {
          ...process.env,
          AMEM_HOME: home,
          HOME: home,
          AMEM_LICENSE_PUBKEY: keys.publicKeyHex,
        };
        const run = (args) =>
          execFileSync(process.execPath, [cli, ...args], {
            encoding: "utf8",
            cwd: repoDir,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });

        assert.match(run(["license", "apply", "--file", result.path]), new RegExp(`tier ${tier}`));
        const status = JSON.parse(run(["license", "status", "--json"]));
        assert.equal(status.tier, tier);
        assert.equal(status.valid, true);
        assert.equal(status.subject, "buyer@example.com");
        assert.deepEqual(status.issues, []);

        const { featuresForTier } = await import("../dist/license.js");
        for (const f of featuresForTier(tier)) {
          assert.ok(status.features.includes(f), `${tier} license missing ${f}`);
        }
        assert.ok(
          status.features.includes("attest_sku"),
          "attest_sku is included in features",
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  }

  it("refuses to fulfill an unpaid or malformed session", async () => {
    const { generateLicenseKeys } = await import("../dist/license.js");
    const keys = generateLicenseKeys();
    const home = mkdtempSync(join(tmpdir(), "amem-shop-bad-"));
    try {
      const licenseDir = join(home, "licenses");
      const cases = [
        [{ ...paidSession("it"), payment_status: "unpaid", status: "open" }, "unpaid"],
        [{ ...paidSession("enterprise") }, "bad_tier"],
        [{ ...paidSession("it"), customer_details: {}, customer_email: "" }, "no_email"],
      ];
      for (const [session, reason] of cases) {
        const res = await fulfill({ session, privateKeyHex: keys.privateKeyHex, licenseDir });
        assert.equal(res.ok, false, `should refuse: ${reason}`);
        assert.equal(res.reason, reason);
      }
      assert.equal(existsSync(licenseDir), false, "nothing should be written for bad sessions");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is idempotent when Stripe retries the same webhook", async () => {
    const shop = await import("../shop/fulfill.mjs");
    const home = mkdtempSync(join(tmpdir(), "amem-shop-idem-"));
    try {
      const ledger = join(home, "fulfilled.json");
      const record = { email: "buyer@example.com", tier: "it", at: new Date().toISOString() };

      const first = shop.rememberFulfilled(ledger, "cs_test_abc123", record);
      assert.equal(first.duplicate, false);

      // Stripe retries webhooks; a second delivery must not mint a second license.
      const second = shop.rememberFulfilled(ledger, "cs_test_abc123", { ...record, tier: "pro" });
      assert.equal(second.duplicate, true);
      assert.equal(second.record.tier, "it", "the original record wins");
      assert.equal(Object.keys(shop.loadFulfilled(ledger)).length, 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects session ids that would escape the license directory", async () => {
    const shop = await import("../shop/fulfill.mjs");
    for (const bad of [
      "../../etc/passwd",
      "cs_test/../../escape",
      "cs test",
      "",
      "evil.json",
      "cs_test\u0000null",
    ]) {
      assert.equal(shop.sessionIdOk(bad), false, `sessionIdOk should reject ${JSON.stringify(bad)}`);
      assert.throws(
        () => shop.issuedLicensePath("/tmp/licenses", bad),
        /invalid checkout session id/,
      );
    }
    assert.ok(shop.issuedLicensePath("/tmp/licenses", "cs_test_abc123").endsWith("cs_test_abc123.json"));
  });

  it("emails copy that matches the command the CLI actually supports", async () => {
    const { generateLicenseKeys } = await import("../dist/license.js");
    const shop = await import("../shop/fulfill.mjs");
    const keys = generateLicenseKeys();
    const home = mkdtempSync(join(tmpdir(), "amem-shop-mail-"));
    try {
      const result = await fulfill({
        session: paidSession("it"),
        privateKeyHex: keys.privateKeyHex,
        licenseDir: join(home, "licenses"),
      });
      const copy = shop.licenseEmailCopy({ tier: "it", jsonText: result.jsonText });

      assert.match(copy.subject, /amem IT/);
      assert.match(copy.text, /amem license apply --file/);
      assert.match(copy.text, /amem license status/);
      // The license itself must be in the body, since there is no license server to re-fetch it.
      assert.ok(copy.text.includes(result.jsonText.trim()), "text body must carry the license");
      assert.match(copy.html, /amem license apply --file/);
      assert.doesNotMatch(copy.html, /<script/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("shop signing key drift", () => {
  it("signs with the key every installed amem verifies against", async () => {
    const pubPath = join(root, "shop", ".data", "license.pub");
    if (!existsSync(pubPath)) return; // not provisioned here (CI); nothing to compare

    const { DEFAULT_LICENSE_PUBKEY_HEX } = await import("../dist/license.js");
    const shopPub = readFileSync(pubPath, "utf8").trim();
    // If these drift, every license the shop sells is dead on arrival for real buyers.
    assert.equal(
      shopPub,
      DEFAULT_LICENSE_PUBKEY_HEX,
      "shop/.data/license.pub must match DEFAULT_LICENSE_PUBKEY_HEX in src/license.ts",
    );
  });

  it("produces a license that verifies under the built-in key when the shop key is used", async () => {
    const privPath = join(root, "shop", ".data", "license.priv");
    if (!existsSync(privPath)) return; // no private key here; covered by the pubkey check above

    const { signLicense, verifySignedLicense, DEFAULT_LICENSE_PUBKEY_HEX } = await import(
      "../dist/license.js"
    );
    const priv = readFileSync(privPath, "utf8").trim();
    const file = signLicense(priv, {
      tier: "it",
      subject: "drift-check@example.com",
      issued_at: new Date().toISOString(),
    });
    assert.deepEqual(
      verifySignedLicense(file, DEFAULT_LICENSE_PUBKEY_HEX),
      [],
      "a shop-signed license must verify against the shipped public key",
    );
  });
});
