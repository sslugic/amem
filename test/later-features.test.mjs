import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("license SKU", () => {
  it("defaults to free and honors AMEM_LICENSE_TIER", async () => {
    await withAmemHome(async () => {
      const prev = process.env.AMEM_LICENSE_TIER;
      delete process.env.AMEM_LICENSE_TIER;
      const { licenseStatus, activateDevLicense, hasFeature, FEATURE_LOCAL_EMBED, clearLicense } =
        await import("../dist/license.js");
      assert.equal(licenseStatus().tier, "free");
      assert.equal(hasFeature(FEATURE_LOCAL_EMBED), false);

      const dev = activateDevLicense("pro");
      assert.equal(dev.tier, "pro");
      assert.equal(dev.kind, "dev");
      assert.equal(dev.transferable, false);
      assert.equal(hasFeature(FEATURE_LOCAL_EMBED), true);
      clearLicense();

      process.env.AMEM_LICENSE_TIER = "it";
      const env = licenseStatus();
      assert.equal(env.tier, "it");
      assert.equal(env.kind, "env");
      if (prev === undefined) delete process.env.AMEM_LICENSE_TIER;
      else process.env.AMEM_LICENSE_TIER = prev;
    });
  });

  it("signs and verifies a license file", async () => {
    await withAmemHome(async (home) => {
      const prevPub = process.env.AMEM_LICENSE_PUBKEY;
      const prevTier = process.env.AMEM_LICENSE_TIER;
      delete process.env.AMEM_LICENSE_TIER;
      const {
        generateLicenseKeys,
        signLicense,
        applyLicenseFile,
        verifySignedLicense,
        licenseStatus,
      } = await import("../dist/license.js");
      const keys = generateLicenseKeys();
      process.env.AMEM_LICENSE_PUBKEY = keys.publicKeyHex;
      const issued = signLicense(keys.privateKeyHex, {
        tier: "pro",
        subject: "test",
        issued_at: new Date().toISOString(),
      });
      assert.deepEqual(verifySignedLicense(issued, keys.publicKeyHex), []);
      const path = join(home, "paid.json");
      writeFileSync(path, JSON.stringify(issued));
      const applied = applyLicenseFile(path);
      assert.equal(applied.tier, "pro");
      assert.equal(applied.kind, "signed");
      assert.equal(applied.transferable, true);
      assert.equal(licenseStatus().valid, true);
      if (prevPub === undefined) delete process.env.AMEM_LICENSE_PUBKEY;
      else process.env.AMEM_LICENSE_PUBKEY = prevPub;
      if (prevTier === undefined) delete process.env.AMEM_LICENSE_TIER;
      else process.env.AMEM_LICENSE_TIER = prevTier;
    });
  });
});

describe("local n-gram embedder", () => {
  it("produces a larger local vector and still ranks similar claims", async () => {
    await withAmemHome(async () => {
      const prev = process.env.AMEM_LICENSE_TIER;
      process.env.AMEM_LICENSE_TIER = "pro";
      const { embedText, embedNgram, cosine, setEmbedBackend, searchClaimsEmbed, ensureClaimsEmbed } =
        await import("../dist/embed.js");
      const { openDb, closeDb, upsertRepo } = await import("../dist/db.js");
      const { applyProposal } = await import("../dist/proposal.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");

      const a = embedNgram("auth startup sync service");
      const b = embedNgram("auth startup sync service");
      const c = embedNgram("unrelated baking recipes");
      assert.equal(a.length, 256);
      assert.ok(Math.abs(cosine(a, b) - 1) < 1e-5);
      assert.ok(cosine(a, c) < cosine(a, b));
      assert.equal(embedText("hello", "hash").length, 128);

      setEmbedBackend("ngram");
      const repoDir = makeGitRepo();
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      applyProposal(repo.id, {
        claims: [
          {
            id: "claim.auth_boot",
            kind: "constraint",
            text: "Auth mode is checked during sync service startup",
            code_anchors: ["src/auth.ts"],
          },
          {
            id: "claim.unrelated",
            kind: "session",
            text: "Prefers dark roast coffee in the morning",
            code_anchors: ["README.md"],
          },
        ],
      });
      const db = openDb();
      ensureClaimsEmbed(db);
      const hits = searchClaimsEmbed(db, repo.id, "sync auth startup", 5);
      assert.ok(hits.length >= 1);
      assert.equal(hits[0].id, "claim.auth_boot");
      closeDb();
      if (prev === undefined) delete process.env.AMEM_LICENSE_TIER;
      else process.env.AMEM_LICENSE_TIER = prev;
    });
  });

  it("refuses ngram without a Pro license", async () => {
    await withAmemHome(async () => {
      const prev = process.env.AMEM_LICENSE_TIER;
      delete process.env.AMEM_LICENSE_TIER;
      const { setEmbedBackend, activeEmbedBackend } = await import("../dist/embed.js");
      const { clearLicense } = await import("../dist/license.js");
      clearLicense();
      assert.equal(activeEmbedBackend(), "hash");
      assert.throws(() => setEmbedBackend("ngram"), /Pro or IT/);
      if (prev === undefined) delete process.env.AMEM_LICENSE_TIER;
      else process.env.AMEM_LICENSE_TIER = prev;
    });
  });
});

describe("IT attest SKU", () => {
  it("adds a vault/host packet on the IT tier", async () => {
    await withAmemHome(async () => {
      const prev = process.env.AMEM_LICENSE_TIER;
      process.env.AMEM_LICENSE_TIER = "it";
      const { buildAttestReport, formatAttestHuman } = await import("../dist/attest.js");
      const report = buildAttestReport(process.cwd());
      assert.equal(report.license.tier, "it");
      assert.ok(report.sku);
      assert.equal(report.sku.airgap, true);
      assert.equal(report.sku.network_egress, "none");
      assert.ok(report.embed.backend);
      assert.match(formatAttestHuman(report), /license: it/);
      if (prev === undefined) delete process.env.AMEM_LICENSE_TIER;
      else process.env.AMEM_LICENSE_TIER = prev;
    });
  });
});
