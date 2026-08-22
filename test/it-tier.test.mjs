import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAmemHome, makeGitRepo, installTestLicense, root } from "./helpers.mjs";

const cli = join(root, "dist", "cli.js");

function runAmem(args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  delete env.AMEM_PASSPHRASE;
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: opts.cwd || process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Sign an arbitrary payload with a throwaway vendor key and trust that key. */
async function signWithTestVendor(payload) {
  const { generateLicenseKeys, signLicense } = await import("../dist/license.js");
  const keys = generateLicenseKeys();
  process.env.AMEM_LICENSE_PUBKEY = keys.publicKeyHex;
  const file = signLicense(keys.privateKeyHex, {
    subject: "test",
    issued_at: new Date().toISOString(),
    ...payload,
  });
  return { file, keys };
}

async function seedRepoWithClaims(repoDir) {
  const { upsertRepo } = await import("../dist/db.js");
  const { detectRepoIdentity } = await import("../dist/repo-identity.js");
  const { applyProposal } = await import("../dist/proposal.js");
  const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
  const claims = [];
  for (let i = 0; i < 12; i++) {
    claims.push({
      id: `claim.noise_${i}`,
      kind: "session",
      text: `Nearly identical noise about the same file README.md and local setup loop ${i % 2}`,
      code_anchors: ["README.md"],
    });
  }
  for (let i = 0; i < 8; i++) {
    claims.push({
      id: `claim.unique_${i}`,
      kind: "constraint",
      text: `Totally unique constraint about module-${i} payment retry semantics`,
      code_anchors: [`src/mod${i}.ts`],
    });
  }
  applyProposal(repo.id, { claims });
  return repo;
}

describe("IT tier: feature matrix", () => {
  it("gives IT everything Pro has, plus attest_sku as the only exclusive", async () => {
    await withAmemHome(async () => {
      const {
        featuresForTier,
        hasFeature,
        clearLicense,
        FEATURE_ATTEST_SKU,
        FEATURE_HYGIENE,
        FEATURE_RULES_SYNC,
        FEATURE_LOCAL_EMBED,
      } = await import("../dist/license.js");

      const all = [FEATURE_LOCAL_EMBED, FEATURE_HYGIENE, FEATURE_RULES_SYNC, FEATURE_ATTEST_SKU];
      const pro = featuresForTier("pro");
      const itTier = featuresForTier("it");

      assert.deepEqual(featuresForTier("free"), []);
      assert.deepEqual([...itTier].sort(), [...all].sort());
      // attest_sku is what IT buys over Pro; everything else must be identical.
      assert.equal(pro.includes(FEATURE_ATTEST_SKU), false);
      assert.deepEqual(itTier.filter((f) => f !== FEATURE_ATTEST_SKU).sort(), [...pro].sort());

      clearLicense();
      for (const f of all) assert.equal(hasFeature(f), false, `free must not unlock ${f}`);

      await installTestLicense("pro");
      assert.equal(hasFeature(FEATURE_ATTEST_SKU), false, "pro must not unlock attest_sku");

      await installTestLicense("it");
      for (const f of all) assert.equal(hasFeature(f), true, `it must unlock ${f}`);
    });
  });

  it("reports tier it, valid, transferable, with no issues", async () => {
    await withAmemHome(async () => {
      const { licenseStatus } = await import("../dist/license.js");
      await installTestLicense("it");
      const status = licenseStatus();
      assert.equal(status.tier, "it");
      assert.equal(status.kind, "signed");
      assert.equal(status.valid, true);
      assert.equal(status.transferable, true);
      assert.deepEqual(status.issues, []);
      assert.equal(status.features.length, 4);
    });
  });
});

describe("IT tier: every gated call site is unlocked", () => {
  it("runs hygiene report and accept-safe", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("it-hygiene");
      const repo = await seedRepoWithClaims(repoDir);
      const { hygieneReport, acceptSafeCleanups, hygienePreview } = await import(
        "../dist/hygiene.js"
      );
      await installTestLicense("it");

      const preview = hygienePreview(repo.id);
      assert.ok(preview.active >= 20);

      const report = hygieneReport(repo.id);
      assert.ok(report);

      const cleaned = acceptSafeCleanups(repo.id);
      assert.ok(Array.isArray(cleaned.decayed));
      assert.ok(cleaned.merged.length >= 1);
      rmSync(repoDir, { recursive: true, force: true });
    });
  });

  it("syncs pinned Cursor rules", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("it-rules");
      const { upsertRepo, setClaimPinned } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { applyProposal } = await import("../dist/proposal.js");
      const { syncPinnedRules } = await import("../dist/rules-sync.js");

      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      applyProposal(repo.id, {
        claims: [
          {
            id: "claim.itpin",
            kind: "constraint",
            text: "Auth must run before Drive sync in src/auth.ts",
            code_anchors: ["src/auth.ts"],
          },
        ],
      });
      setClaimPinned(repo.id, "claim.itpin", true);

      await installTestLicense("it");
      const synced = syncPinnedRules(repo);
      assert.equal(synced.pinned, 1);
      assert.ok(existsSync(synced.path));
      assert.match(readFileSync(synced.path, "utf8"), /Auth must run/);
      rmSync(repoDir, { recursive: true, force: true });
    });
  });

  it("enables local ngram embeddings", async () => {
    await withAmemHome(async () => {
      const { setEmbedBackend, activeEmbedBackend, embedStatus } = await import(
        "../dist/embed.js"
      );
      await installTestLicense("it");
      const status = setEmbedBackend("ngram");
      assert.equal(status.backend, "ngram");
      assert.equal(status.licensed, true);
      assert.equal(activeEmbedBackend(), "ngram");
      assert.ok(embedStatus().dim > 0);
      setEmbedBackend("hash");
    });
  });

  it("unlocks the Pro side of the retrieval showdown", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("it-showdown");
      const repo = await seedRepoWithClaims(repoDir);
      const { buildRetrievalShowdown } = await import("../dist/context.js");
      const { clearLicense } = await import("../dist/license.js");

      clearLicense();
      assert.equal(buildRetrievalShowdown(repo.id, "payment retry").proLocked, true);

      await installTestLicense("it");
      const showdown = buildRetrievalShowdown(repo.id, "payment retry");
      assert.equal(showdown.proLocked, false);
      assert.ok(showdown.pro.length > 0);
      rmSync(repoDir, { recursive: true, force: true });
    });
  });
});

describe("IT tier: attest SKU packet", () => {
  it("adds the airgap/vault/host packet only on IT", async () => {
    await withAmemHome(async () => {
      const { buildAttestReport, formatAttestHuman } = await import("../dist/attest.js");

      await installTestLicense("pro");
      assert.equal(buildAttestReport(process.cwd()).sku, undefined);

      await installTestLicense("it");
      const report = buildAttestReport(process.cwd());
      assert.ok(report.sku, "IT must emit the sku packet");
      assert.equal(report.sku.tier, "it");
      assert.equal(report.sku.airgap, true);
      assert.equal(report.sku.network_egress, "none");
      assert.equal(typeof report.sku.vault.encryptedAtRest, "boolean");
      assert.equal(typeof report.sku.vault.backup.scheduled, "boolean");
      for (const host of ["continue", "zed", "windsurf"]) {
        assert.ok(Array.isArray(report.sku.host_health[host]), `${host} health missing`);
      }

      // The privacy posture IT is buying an attestation of.
      assert.equal(report.privacy.telemetry, false);
      assert.equal(report.privacy.network_egress, "none");
      assert.match(report.privacy.ui_bind, /^(127\.0\.0\.1|localhost)$/);

      const human = formatAttestHuman(report);
      assert.match(human, /license: it/);
      assert.match(human, /sku: IT airgap packet/);
    });
  });
});

describe("IT tier: IT pack", () => {
  it("writes policy, MDM, offboard, SBOM and notes stamped with the IT tier", async () => {
    await withAmemHome(async (home) => {
      const { writeItPack, buildSbom } = await import("../dist/it-pack.js");
      await installTestLicense("it");

      const pack = writeItPack(join(home, "it-pack"));
      for (const name of [
        "policy.toml",
        "sbom.json",
        "README.txt",
        "co.amem.managed.plist",
        "mdm-offboard.sh",
      ]) {
        assert.ok(existsSync(join(pack.dir, name)), `missing ${name}`);
      }
      // The pack can carry policy for a whole fleet, so it must not be world-readable.
      assert.equal((statSync(pack.dir).mode & 0o777).toString(8), "700");

      const notes = readFileSync(join(pack.dir, "README.txt"), "utf8");
      assert.match(notes, /License: it/);
      assert.match(notes, /no license server and no cloud sync/i);

      const policy = readFileSync(join(pack.dir, "policy.toml"), "utf8");
      assert.ok(policy.length > 0);

      const sbom = JSON.parse(readFileSync(join(pack.dir, "sbom.json"), "utf8"));
      assert.equal(sbom.bomFormat, "CycloneDX");
      assert.equal(sbom.specVersion, "1.5");
      assert.match(sbom.serialNumber, /^urn:uuid:[0-9a-f]{32}$/);
      assert.ok(sbom.components.some((c) => c.name === "better-sqlite3"));
      for (const c of sbom.components) {
        assert.equal(typeof c.name, "string");
        assert.doesNotMatch(c.version, /^[\^~]/, `${c.name} version must be pinned, got ${c.version}`);
      }
      assert.deepEqual(buildSbom().components, sbom.components);
    });
  });
});

describe("IT tier: license integrity", () => {
  it("falls back to free when an IT license has expired", async () => {
    await withAmemHome(async () => {
      const { applyLicenseJson, licenseStatus, hasFeature, FEATURE_ATTEST_SKU } = await import(
        "../dist/license.js"
      );
      const { file } = await signWithTestVendor({
        tier: "it",
        expires_at: new Date(Date.now() - 86_400_000).toISOString(),
      });
      applyLicenseJson(file);

      const status = licenseStatus();
      assert.equal(status.tier, "free");
      assert.equal(status.valid, false);
      assert.ok(status.issues.some((i) => /expired/i.test(i)));
      assert.deepEqual(status.features, []);
      assert.equal(hasFeature(FEATURE_ATTEST_SKU), false);
    });
  });

  it("rejects a Pro license edited to claim IT after signing", async () => {
    await withAmemHome(async () => {
      const { applyLicenseJson, licenseStatus, writeLicense } = await import(
        "../dist/license.js"
      );
      const { file } = await signWithTestVendor({ tier: "pro" });
      applyLicenseJson(file);
      assert.equal(licenseStatus().tier, "pro");

      // Signature covers the payload, so a hand-edited tier must not stick.
      writeLicense({ ...file, payload: { ...file.payload, tier: "it" } });
      const status = licenseStatus();
      assert.equal(status.tier, "free");
      assert.equal(status.valid, false);
      assert.ok(status.issues.some((i) => /signature/i.test(i)));
    });
  });

  it("refuses an IT license signed by a key that is not the vendor's", async () => {
    await withAmemHome(async () => {
      const { generateLicenseKeys, signLicense, applyLicenseJson, licenseStatus } = await import(
        "../dist/license.js"
      );
      const vendor = generateLicenseKeys();
      const impostor = generateLicenseKeys();
      process.env.AMEM_LICENSE_PUBKEY = vendor.publicKeyHex;

      const forged = signLicense(impostor.privateKeyHex, {
        tier: "it",
        subject: "forged",
        issued_at: new Date().toISOString(),
      });
      assert.throws(() => applyLicenseJson(forged), /signature/i);
      assert.equal(licenseStatus().tier, "free");
    });
  });

  it("honors an extra feature grant carried in a signed payload", async () => {
    await withAmemHome(async () => {
      const { applyLicenseJson, hasFeature, FEATURE_ATTEST_SKU } = await import(
        "../dist/license.js"
      );
      const { file } = await signWithTestVendor({
        tier: "pro",
        features: [FEATURE_ATTEST_SKU],
      });
      applyLicenseJson(file);
      assert.equal(hasFeature(FEATURE_ATTEST_SKU), true);
    });
  });

  it("drops back to free features after the license is cleared", async () => {
    await withAmemHome(async () => {
      const { clearLicense, licenseStatus, hasFeature, FEATURE_HYGIENE } = await import(
        "../dist/license.js"
      );
      await installTestLicense("it");
      assert.equal(hasFeature(FEATURE_HYGIENE), true);
      clearLicense();
      const status = licenseStatus();
      assert.equal(status.tier, "free");
      assert.equal(status.kind, "none");
      assert.equal(hasFeature(FEATURE_HYGIENE), false);
    });
  });
});

describe("IT tier: HTTP API", () => {
  it("serves the IT license and stops returning 403 on gated routes", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("it-api");
      const repo = await seedRepoWithClaims(repoDir);
      const { handleApi } = await import("../dist/api/routes.js");
      const { clearLicense } = await import("../dist/license.js");

      clearLicense();
      const blocked = handleApi({
        method: "POST",
        pathname: "/api/hygiene/accept-safe",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: {},
        cwd: repoDir,
      });
      assert.equal(blocked.status, 403);

      await installTestLicense("it");
      const license = handleApi({
        method: "GET",
        pathname: "/api/license",
        searchParams: new URLSearchParams(),
        body: null,
        cwd: repoDir,
      });
      assert.equal(license.status, 200);
      assert.equal(license.body.tier, "it");
      assert.ok(license.body.features.includes("attest_sku"));

      const allowed = handleApi({
        method: "POST",
        pathname: "/api/hygiene/accept-safe",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: {},
        cwd: repoDir,
      });
      assert.equal(allowed.status, 200);

      const rules = handleApi({
        method: "POST",
        pathname: "/api/rules/sync",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: {},
        cwd: repoDir,
      });
      assert.equal(rules.status, 200);
      rmSync(repoDir, { recursive: true, force: true });
    });
  });
});

describe("IT tier: CLI end-to-end", () => {
  it("issues, applies and attests an IT license through the CLI", async () => {
    const { generateLicenseKeys } = await import("../dist/license.js");
    const keys = generateLicenseKeys();
    const home = mkdtempSync(join(tmpdir(), "amem-it-cli-"));
    const repoDir = makeGitRepo("it-cli");
    try {
      const env = {
        AMEM_HOME: home,
        HOME: home,
        AMEM_LICENSE_PUBKEY: keys.publicKeyHex,
        AMEM_LICENSE_PRIVKEY: keys.privateKeyHex,
      };
      runAmem(["init", "--platform", "cursor"], { env, cwd: repoDir });

      const out = join(home, "it.json");
      const issued = runAmem(
        ["license", "issue", "--tier", "it", "--subject", "acme-it", "--out", out],
        { env, cwd: repoDir },
      );
      assert.match(issued, /Wrote signed license/);

      const applied = runAmem(["license", "apply", "--file", out], { env, cwd: repoDir });
      assert.match(applied, /tier it/);

      const status = JSON.parse(
        runAmem(["license", "status", "--json"], { env, cwd: repoDir }),
      );
      assert.equal(status.tier, "it");
      assert.equal(status.valid, true);
      assert.equal(status.subject, "acme-it");
      assert.ok(status.features.includes("attest_sku"));

      const attest = JSON.parse(
        runAmem(["doctor", "--attest", "--json"], { env, cwd: repoDir }),
      );
      assert.equal(attest.license.tier, "it");
      assert.ok(attest.sku, "CLI attest must carry the IT sku packet");
      assert.equal(attest.sku.airgap, true);
      assert.equal(attest.privacy.telemetry, false);

      const pack = runAmem(["it-pack", "--out", join(home, "pack")], { env, cwd: repoDir });
      assert.match(pack, /IT pack written/);
      assert.ok(existsSync(join(home, "pack", "sbom.json")));

      runAmem(["rules", "sync"], { env, cwd: repoDir });

      // Without the vendor key the same self-issued file must not unlock anything.
      const foreign = JSON.parse(
        runAmem(["license", "status", "--json"], {
          env: { ...env, AMEM_LICENSE_PUBKEY: generateLicenseKeys().publicKeyHex },
          cwd: repoDir,
        }),
      );
      assert.equal(foreign.tier, "free");
      assert.equal(foreign.valid, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
