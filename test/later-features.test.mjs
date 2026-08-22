import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withAmemHome, makeGitRepo, installTestLicense } from "./helpers.mjs";

describe("license SKU", () => {
  it("defaults to free and rejects unsigned /dev licenses", async () => {
    await withAmemHome(async () => {
      const {
        licenseStatus,
        hasFeature,
        FEATURE_LOCAL_EMBED,
        clearLicense,
        applyLicenseJson,
        licensePath,
      } = await import("../dist/license.js");
      const { writeFileSync } = await import("node:fs");
      assert.equal(licenseStatus().tier, "free");
      assert.equal(hasFeature(FEATURE_LOCAL_EMBED), false);

      assert.throws(
        () =>
          applyLicenseJson({
            kind: "dev",
            payload: {
              tier: "pro",
              issued_at: new Date().toISOString(),
              features: [FEATURE_LOCAL_EMBED],
            },
          }),
        /not accepted|signed/i,
      );

      writeFileSync(
        licensePath(),
        JSON.stringify({
          kind: "dev",
          payload: { tier: "pro", issued_at: new Date().toISOString() },
        }),
      );
      const stale = licenseStatus();
      assert.equal(stale.tier, "free");
      assert.equal(stale.valid, false);
      assert.ok(stale.issues.some((i) => /not accepted|signed/i.test(i)));
      clearLicense();

      const { status } = await installTestLicense("pro");
      assert.equal(status.tier, "pro");
      assert.equal(status.kind, "signed");
      assert.equal(status.transferable, true);
      assert.equal(hasFeature(FEATURE_LOCAL_EMBED), true);
      clearLicense();
    });
  });

  it("signs and verifies a license file", async () => {
    await withAmemHome(async (home) => {
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
    });
  });
});

describe("local n-gram embedder", () => {
  it("produces a larger local vector and still ranks similar claims", async () => {
    await withAmemHome(async () => {
      await installTestLicense("pro");
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
    });
  });

  it("refuses ngram without a Pro license", async () => {
    await withAmemHome(async () => {
      const { setEmbedBackend, activeEmbedBackend } = await import("../dist/embed.js");
      const { clearLicense } = await import("../dist/license.js");
      clearLicense();
      assert.equal(activeEmbedBackend(), "hash");
      assert.throws(() => setEmbedBackend("ngram"), /Pro or IT/);
    });
  });
});

describe("IT attest SKU", () => {
  it("adds a vault/host packet on the IT tier", async () => {
    await withAmemHome(async () => {
      await installTestLicense("it");
      const { buildAttestReport, formatAttestHuman } = await import("../dist/attest.js");
      const report = buildAttestReport(process.cwd());
      assert.equal(report.license.tier, "it");
      assert.ok(report.sku);
      assert.equal(report.sku.airgap, true);
      assert.equal(report.sku.network_egress, "none");
      assert.ok(report.embed.backend);
      assert.match(formatAttestHuman(report), /license: it/);
    });
  });
});
