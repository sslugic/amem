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
  it("includes all features on all tiers", async () => {
    await withAmemHome(async () => {
      const {
        featuresForTier,
        hasFeature,
        FEATURE_ATTEST_SKU,
        FEATURE_HYGIENE,
        FEATURE_RULES_SYNC,
        FEATURE_LOCAL_EMBED,
      } = await import("../dist/license.js");

      const all = [FEATURE_LOCAL_EMBED, FEATURE_HYGIENE, FEATURE_RULES_SYNC, FEATURE_ATTEST_SKU];
      assert.deepEqual([...featuresForTier("free")].sort(), [...all].sort());
      assert.deepEqual([...featuresForTier("pro")].sort(), [...all].sort());
      assert.deepEqual([...featuresForTier("it")].sort(), [...all].sort());

      for (const f of all) {
        assert.equal(hasFeature(f), true, `${f} must be unlocked for all`);
      }
    });
  });

  it("reports tier it, valid, transferable, with no issues when signed license is applied", async () => {
    await withAmemHome(async () => {
      const { licenseStatus } = await import("../dist/license.js");
      await installTestLicense("it");
      const status = licenseStatus();
      assert.equal(status.tier, "it");
      assert.equal(status.kind, "signed");
      assert.equal(status.valid, true);
      assert.equal(status.transferable, true);
      assert.deepEqual(status.issues, []);
      assert.ok(status.features.length >= 4);
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
      const status = setEmbedBackend("ngram");
      assert.equal(status.backend, "ngram");
      assert.equal(status.licensed, true);
      assert.equal(activeEmbedBackend(), "ngram");
      assert.ok(embedStatus().dim > 0);
    });
  });

  it("unlocks the Pro side of the retrieval showdown", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("it-showdown");
      const repo = await seedRepoWithClaims(repoDir);
      const { buildRetrievalShowdown } = await import("../dist/context.js");

      const showdown = buildRetrievalShowdown(repo.id, "payment retry");
      assert.equal(showdown.proLocked, false);
      assert.ok(showdown.pro.length > 0);
      rmSync(repoDir, { recursive: true, force: true });
    });
  });
});

describe("IT tier: attest SKU packet", () => {
  it("adds the airgap/vault/host packet on attest", async () => {
    await withAmemHome(async () => {
      const { buildAttestReport, formatAttestHuman } = await import("../dist/attest.js");

      const report = buildAttestReport(process.cwd());
      assert.ok(report.sku, "Attest must emit the sku packet");
      assert.equal(report.sku.airgap, true);
      assert.equal(report.sku.network_egress, "none");
      assert.equal(typeof report.sku.vault.encryptedAtRest, "boolean");
      assert.equal(typeof report.sku.vault.backup.scheduled, "boolean");
      for (const host of ["continue", "zed", "windsurf"]) {
        assert.ok(Array.isArray(report.sku.host_health[host]), `${host} health missing`);
      }

      assert.equal(report.privacy.telemetry, false);
      assert.equal(report.privacy.network_egress, "none");
      assert.match(report.privacy.ui_bind, /^(127\.0\.0\.1|localhost)$/);

      const human = formatAttestHuman(report);
      assert.match(human, /airgap packet/);
    });
  });
});

describe("IT tier: IT pack", () => {
  it("writes policy, MDM, offboard, SBOM and notes stamped with the IT tier", async () => {
    await withAmemHome(async (home) => {
      const { writeItPack, buildSbom } = await import("../dist/it-pack.js");

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
      assert.equal((statSync(pack.dir).mode & 0o777).toString(8), "700");

      const notes = readFileSync(join(pack.dir, "README.txt"), "utf8");
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
});

describe("IT tier: HTTP API", () => {
  it("serves the license and returns 200 on all routes", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("it-api");
      const repo = await seedRepoWithClaims(repoDir);
      const { handleApi } = await import("../dist/api/routes.js");

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
    const home = mkdtempSync(join(tmpdir(), "amem-it-cli-"));
    const repoDir = makeGitRepo("it-cli");
    const { generateLicenseKeys } = await import("../dist/license.js");
    const keys = generateLicenseKeys();
    const env = {
      AMEM_HOME: home,
      HOME: home,
      AMEM_LICENSE_PUBKEY: keys.publicKeyHex,
      AMEM_LICENSE_PRIVKEY: keys.privateKeyHex,
    };

    try {
      runAmem(["init", "--platform", "cursor"], { cwd: repoDir, env });
      runAmem(["remember", "Auth must run before drive sync in src/auth.ts", "--kind", "constraint"], {
        cwd: repoDir,
        env,
      });

      const lic = join(home, "it.json");
      runAmem(["license", "issue", "--tier", "it", "--out", lic], { cwd: repoDir, env });
      assert.ok(existsSync(lic));

      const applied = runAmem(["license", "apply", "--file", lic], { cwd: repoDir, env });
      assert.match(applied, /tier it/);

      const status = runAmem(["license", "status"], { cwd: repoDir, env });
      assert.match(status, /tier: it/);
      assert.match(status, /attest_sku/);

      const packDir = join(home, "security-pack");
      runAmem(["it-pack", "--out", packDir], { cwd: repoDir, env });
      assert.ok(existsSync(join(packDir, "policy.toml")));
      assert.ok(existsSync(join(packDir, "sbom.json")));

      const attest = JSON.parse(runAmem(["doctor", "--attest", "--json"], { cwd: repoDir, env }));
      assert.equal(attest.sku.tier, "it");
      assert.equal(attest.sku.airgap, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
