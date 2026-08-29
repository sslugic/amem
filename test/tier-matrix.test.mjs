import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAmemHome, makeGitRepo, installTestLicense, root } from "./helpers.mjs";

const cli = join(root, "dist", "cli.js");

const TIERS = ["free", "pro", "it"];

const ALL_FEATURES = [
  "local_embed_model",
  "hygiene",
  "rules_sync",
  "attest_sku",
];

/** Move the running process onto a tier. "free" means no license file at all. */
async function setTier(tier) {
  const { clearLicense } = await import("../dist/license.js");
  clearLicense();
  if (tier === "free") return;
  await installTestLicense(tier);
}

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

async function seedRepo(repoDir, { pin = false } = {}) {
  const { upsertRepo, setClaimPinned } = await import("../dist/db.js");
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
  if (pin) setClaimPinned(repo.id, "claim.unique_0", true);
  return repo;
}

describe("tier matrix: hasFeature across every tier", () => {
  it("unlocks all features on every tier", async () => {
    await withAmemHome(async () => {
      const { hasFeature, licenseStatus } = await import("../dist/license.js");
      for (const tier of TIERS) {
        await setTier(tier);
        assert.equal(licenseStatus().tier, tier, `status should report ${tier}`);
        for (const feature of ALL_FEATURES) {
          assert.equal(
            hasFeature(feature),
            true,
            `${tier} × ${feature} should be true`,
          );
        }
      }
    });
  });

  it("featuresForTier returns all features", async () => {
    await withAmemHome(async () => {
      const { featuresForTier } = await import("../dist/license.js");
      for (const tier of TIERS) {
        const features = new Set(featuresForTier(tier));
        for (const f of ALL_FEATURES) {
          assert.ok(features.has(f), `${tier} must include ${f}`);
        }
      }
    });
  });

  it("signed license is valid and carries all features", async () => {
    await withAmemHome(async () => {
      const { signLicense, generateLicenseKeys, applyLicenseJson, hasFeature, licenseStatus } =
        await import("../dist/license.js");
      const keys = generateLicenseKeys();
      process.env.AMEM_LICENSE_PUBKEY = keys.publicKeyHex;
      applyLicenseJson(
        signLicense(keys.privateKeyHex, {
          tier: "free",
          subject: "free-user",
          issued_at: new Date().toISOString(),
        }),
      );
      const status = licenseStatus();
      assert.equal(status.tier, "free");
      assert.equal(status.valid, true);
      assert.equal(status.kind, "signed");
      for (const feature of ALL_FEATURES) assert.equal(hasFeature(feature), true);
    });
  });
});

describe("tier matrix: all call sites are unlocked by default", () => {
  it("allows each entry point across all tiers", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("matrix-calls");
      const repo = await seedRepo(repoDir, { pin: true });
      const { hygieneReport, decayStaleClaims } = await import("../dist/hygiene.js");
      const { syncPinnedRules } = await import("../dist/rules-sync.js");
      const { setEmbedBackend, activeEmbedBackend } = await import("../dist/embed.js");
      const { buildAttestReport } = await import("../dist/attest.js");
      const { getRepoByCwd } = await import("../dist/db.js");
      const repoRow = getRepoByCwd(repoDir);

      for (const tier of TIERS) {
        await setTier(tier);

        assert.ok(hygieneReport(repo.id), `${tier}: hygieneReport should run`);
        assert.ok(decayStaleClaims(repo.id), `${tier}: decayStaleClaims should run`);

        assert.ok(syncPinnedRules(repoRow).path, `${tier}: rules sync should run`);

        assert.equal(setEmbedBackend("ngram").backend, "ngram", `${tier}: ngram`);
        assert.equal(activeEmbedBackend(), "ngram");

        const sku = buildAttestReport(repoDir).sku;
        assert.ok(sku, `${tier}: attest sku packet must be present`);
      }
      rmSync(repoDir, { recursive: true, force: true });
    });
  });

  it("runs scheduled hygiene cleanly", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("matrix-sched");
      await seedRepo(repoDir);
      const { runScheduledHygiene } = await import("../dist/hygiene.js");

      const ran = runScheduledHygiene();
      assert.ok(Array.isArray(ran.repos));
      rmSync(repoDir, { recursive: true, force: true });
    });
  });
});

describe("tier matrix: free tier has everything included", () => {
  it("does not paywall the core loop, preview, attest or it-pack", async () => {
    await withAmemHome(async (home) => {
      const repoDir = makeGitRepo("matrix-free");
      const repo = await seedRepo(repoDir);
      await setTier("free");

      const { buildContext } = await import("../dist/context.js");
      const { hygienePreview, hygienePreviewAll } = await import("../dist/hygiene.js");
      const { buildAttestReport } = await import("../dist/attest.js");
      const { writeItPack } = await import("../dist/it-pack.js");
      const { searchClaimsEmbed } = await import("../dist/embed.js");
      const { openDb } = await import("../dist/db.js");

      const packet = buildContext(repo.id, "payment retry semantics");
      assert.ok(packet.claims.length > 0, "free must retrieve facts");

      assert.ok(searchClaimsEmbed(openDb(), repo.id, "payment retry").length > 0);

      assert.ok(hygienePreview(repo.id).active >= 20, "preview is free");
      assert.ok(hygienePreviewAll());

      const report = buildAttestReport(repoDir);
      assert.ok(report.sku, "sku is included by default");
      assert.equal(report.license.tier, "free");
      assert.equal(report.privacy.telemetry, false);

      const pack = writeItPack(join(home, "free-pack"));
      assert.equal(pack.files.length, 5);
      assert.match(readFileSync(join(pack.dir, "README.txt"), "utf8"), /License: free/);
      rmSync(repoDir, { recursive: true, force: true });
    });
  });
});

describe("tier matrix: license file validation", () => {
  it("rejects malformed license shapes", async () => {
    await withAmemHome(async () => {
      const { parseLicenseFile } = await import("../dist/license.js");
      const now = new Date().toISOString();
      const cases = [
        [null, /JSON object/],
        ["nope", /JSON object/],
        [{ kind: "env", payload: { tier: "it", issued_at: now } }, /kind must be signed/],
        [{ kind: "signed", payload: { tier: "it", issued_at: now } }, /requires a signature/],
        [{ kind: "signed", signature: "ab", payload: { tier: "enterprise", issued_at: now } }, /tier must be/],
        [{ kind: "signed", signature: "ab" }, /tier must be/],
      ];
      for (const [input, pattern] of cases) {
        assert.throws(() => parseLicenseFile(input), pattern);
      }
    });
  });

  it("handles corrupt license file gracefully", async () => {
    await withAmemHome(async () => {
      const { licenseStatus, licensePath, hasFeature } = await import("../dist/license.js");
      writeFileSync(licensePath(), "{ not json");
      const status = licenseStatus();
      assert.equal(status.tier, "free");
      assert.equal(status.valid, true);
      assert.equal(hasFeature("hygiene"), true);
    });
  });
});

describe("tier matrix: HTTP routes per tier", () => {
  it("returns 200 on all routes across all tiers", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("matrix-http");
      const repo = await seedRepo(repoDir, { pin: true });
      const { handleApi } = await import("../dist/api/routes.js");

      for (const tier of TIERS) {
        await setTier(tier);
        const call = (method, pathname, body = null) =>
          handleApi({
            method,
            pathname,
            searchParams: new URLSearchParams({ repo: repo.id }),
            body,
            cwd: repoDir,
          });

        assert.equal(call("GET", "/api/status").status, 200, `${tier}: status`);
        assert.equal(call("GET", "/api/hygiene").status, 200, `${tier}: hygiene`);
        assert.equal(call("GET", "/api/hygiene/preview").status, 200, `${tier}: preview`);
        assert.equal(call("POST", "/api/hygiene/accept-safe", {}).status, 200, `${tier}: accept-safe`);
        assert.equal(call("POST", "/api/rules/sync", {}).status, 200, `${tier}: rules sync`);
      }
      rmSync(repoDir, { recursive: true, force: true });
    });
  });
});

describe("tier matrix: CLI per tier", () => {
  it("executes CLI commands without paywall gates", async () => {
    const home = mkdtempSync(join(tmpdir(), "amem-matrix-cli-"));
    const repoDir = makeGitRepo("matrix-cli-all");
    const env = { AMEM_HOME: home, HOME: home };

    try {
      runAmem(["init", "--platform", "cursor"], { cwd: repoDir, env });
      runAmem(["remember", "payment retry uses exponential backoff", "--kind", "constraint"], {
        cwd: repoDir,
        env,
      });

      const hygieneOut = runAmem(["hygiene"], { cwd: repoDir, env });
      assert.match(hygieneOut, /active: 1/);

      const rulesOut = runAmem(["rules", "sync"], { cwd: repoDir, env });
      assert.match(rulesOut, /Wrote/);

      const doctor = runAmem(["doctor"], { cwd: repoDir, env });
      assert.match(doctor, /doctor: ok/);

      const attest = JSON.parse(runAmem(["doctor", "--attest", "--json"], { cwd: repoDir, env }));
      assert.ok(attest.sku);
      assert.equal(attest.sku.airgap, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
