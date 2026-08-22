import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAmemHome, makeGitRepo, installTestLicense, root } from "./helpers.mjs";

const cli = join(root, "dist", "cli.js");

const TIERS = ["free", "pro", "it"];

/** Expected unlock per tier. attest_sku is the single IT-exclusive. */
const GATES = {
  local_embed_model: { free: false, pro: true, it: true },
  hygiene: { free: false, pro: true, it: true },
  rules_sync: { free: false, pro: true, it: true },
  attest_sku: { free: false, pro: false, it: true },
};

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
  it("unlocks exactly the documented feature set on each tier", async () => {
    await withAmemHome(async () => {
      const { hasFeature, licenseStatus } = await import("../dist/license.js");
      for (const tier of TIERS) {
        await setTier(tier);
        assert.equal(licenseStatus().tier, tier, `status should report ${tier}`);
        for (const [feature, expected] of Object.entries(GATES)) {
          assert.equal(
            hasFeature(feature),
            expected[tier],
            `${tier} × ${feature} should be ${expected[tier]}`,
          );
        }
      }
    });
  });

  it("keeps tiers monotonic: free ⊂ pro ⊂ it", async () => {
    await withAmemHome(async () => {
      const { featuresForTier } = await import("../dist/license.js");
      const [free, pro, itTier] = TIERS.map((t) => new Set(featuresForTier(t)));
      for (const f of free) assert.ok(pro.has(f), `pro must keep free feature ${f}`);
      for (const f of pro) assert.ok(itTier.has(f), `it must keep pro feature ${f}`);
      assert.ok(itTier.size > pro.size, "it must add something over pro");
      assert.equal(free.size, 0);
    });
  });

  it("treats a signed free license the same as no license", async () => {
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
      for (const feature of Object.keys(GATES)) assert.equal(hasFeature(feature), false);
    });
  });
});

describe("tier matrix: gated call sites behave per tier", () => {
  it("allows or refuses each entry point according to the matrix", async () => {
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
        const g = (f) => GATES[f][tier];

        if (g("hygiene")) {
          assert.ok(hygieneReport(repo.id), `${tier}: hygieneReport should run`);
          assert.ok(decayStaleClaims(repo.id), `${tier}: decayStaleClaims should run`);
        } else {
          assert.throws(() => hygieneReport(repo.id), /Pro or IT/, `${tier}: hygieneReport`);
          assert.throws(() => decayStaleClaims(repo.id), /Pro or IT/, `${tier}: decay`);
        }

        if (g("rules_sync")) {
          assert.ok(syncPinnedRules(repoRow).path, `${tier}: rules sync should run`);
        } else {
          assert.throws(() => syncPinnedRules(repoRow), /Pro or IT/, `${tier}: rules sync`);
        }

        if (g("local_embed_model")) {
          assert.equal(setEmbedBackend("ngram").backend, "ngram", `${tier}: ngram`);
          assert.equal(activeEmbedBackend(), "ngram");
          setEmbedBackend("hash");
        } else {
          assert.throws(() => setEmbedBackend("ngram"), /Pro or IT/, `${tier}: ngram`);
          assert.equal(activeEmbedBackend(), "hash");
        }

        const sku = buildAttestReport(repoDir).sku;
        assert.equal(Boolean(sku), g("attest_sku"), `${tier}: attest sku packet`);
      }
      rmSync(repoDir, { recursive: true, force: true });
    });
  });

  it("skips scheduled hygiene without throwing on free", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("matrix-sched");
      await seedRepo(repoDir);
      const { runScheduledHygiene } = await import("../dist/hygiene.js");

      await setTier("free");
      // The scheduler runs unattended, so an unlicensed machine must no-op, not crash.
      const skipped = runScheduledHygiene();
      assert.equal(skipped.skipped, true);
      assert.match(skipped.reason, /Pro\/IT/);
      assert.deepEqual(skipped.repos, []);

      await setTier("pro");
      const ran = runScheduledHygiene();
      assert.notEqual(ran.skipped, true);
      assert.ok(Array.isArray(ran.repos));
      rmSync(repoDir, { recursive: true, force: true });
    });
  });

  it("explains how to upgrade whenever it refuses", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("matrix-msg");
      const repo = await seedRepo(repoDir);
      const { hygieneReport } = await import("../dist/hygiene.js");
      const { setEmbedBackend } = await import("../dist/embed.js");
      await setTier("free");

      for (const call of [() => hygieneReport(repo.id), () => setEmbedBackend("ngram")]) {
        assert.throws(call, (e) => {
          assert.match(e.message, /Pro or IT/, "must name the tier that unlocks it");
          assert.match(e.message, /getamem\.com/, "must say where to buy");
          return true;
        });
      }
      rmSync(repoDir, { recursive: true, force: true });
    });
  });
});

describe("tier matrix: free tier keeps working", () => {
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
      assert.ok(packet.claims.length > 0, "free must still retrieve facts");

      // Hash-backend search is the free offering and must return hits.
      assert.ok(searchClaimsEmbed(openDb(), repo.id, "payment retry").length > 0);

      assert.ok(hygienePreview(repo.id).active >= 20, "preview is free");
      assert.ok(hygienePreviewAll());

      const report = buildAttestReport(repoDir);
      assert.equal(report.sku, undefined, "no sku on free");
      assert.equal(report.license.tier, "free");
      assert.equal(report.privacy.telemetry, false);

      // Generating the pack is deliberately allowed anywhere; only the SKU packet is gated.
      const pack = writeItPack(join(home, "free-pack"));
      assert.equal(pack.files.length, 5);
      assert.match(readFileSync(join(pack.dir, "README.txt"), "utf8"), /License: free/);
      rmSync(repoDir, { recursive: true, force: true });
    });
  });
});

describe("tier matrix: upgrade and downgrade", () => {
  it("grants on upgrade and revokes on downgrade", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("matrix-updown");
      const repo = await seedRepo(repoDir, { pin: true });
      const { hasFeature, licenseStatus } = await import("../dist/license.js");
      const { hygieneReport } = await import("../dist/hygiene.js");
      const { buildAttestReport } = await import("../dist/attest.js");

      const seen = [];
      for (const tier of ["free", "pro", "it", "pro", "free"]) {
        await setTier(tier);
        seen.push({
          tier: licenseStatus().tier,
          hygiene: hasFeature("hygiene"),
          sku: Boolean(buildAttestReport(repoDir).sku),
        });
      }
      assert.deepEqual(seen, [
        { tier: "free", hygiene: false, sku: false },
        { tier: "pro", hygiene: true, sku: false },
        { tier: "it", hygiene: true, sku: true },
        { tier: "pro", hygiene: true, sku: false },
        { tier: "free", hygiene: false, sku: false },
      ]);

      assert.throws(() => hygieneReport(repo.id), /Pro or IT/, "downgrade must re-lock");
      rmSync(repoDir, { recursive: true, force: true });
    });
  });

  it("leaves already-written rules on disk after a downgrade", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("matrix-rules-down");
      await seedRepo(repoDir, { pin: true });
      const { syncPinnedRules } = await import("../dist/rules-sync.js");
      const { getRepoByCwd } = await import("../dist/db.js");
      const repoRow = getRepoByCwd(repoDir);

      await setTier("pro");
      const synced = syncPinnedRules(repoRow);
      assert.ok(existsSync(synced.path));

      await setTier("free");
      // Losing the license stops new syncs; it must not reach into the repo and delete work.
      assert.ok(existsSync(synced.path), "existing rules file must survive downgrade");
      assert.throws(() => syncPinnedRules(repoRow), /Pro or IT/);
      rmSync(repoDir, { recursive: true, force: true });
    });
  });

  it("strands ngram embeddings when the license lapses, and attest says so", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("matrix-embed-down");
      const repo = await seedRepo(repoDir);
      const { setEmbedBackend, reindexAllEmbeds, searchClaimsEmbed, embedStatus } = await import(
        "../dist/embed.js"
      );
      const { buildAttestReport } = await import("../dist/attest.js");
      const { openDb } = await import("../dist/db.js");
      const db = openDb();

      await setTier("it");
      setEmbedBackend("ngram");
      reindexAllEmbeds(db);
      assert.ok(searchClaimsEmbed(db, repo.id, "payment retry").length > 0, "ngram should hit");

      await setTier("free");
      const status = embedStatus();
      assert.equal(status.backend, "hash", "unlicensed falls back to hash");
      assert.equal(status.requested, "ngram", "the request is remembered");
      assert.equal(status.licensed, false);

      // Stored vectors are ngram/256 but the active backend queries hash/128, so semantic
      // ranking silently returns nothing until a reindex. Attest is what surfaces it.
      assert.equal(
        searchClaimsEmbed(db, repo.id, "payment retry").length,
        0,
        "stranded vectors must not be scored against the wrong backend",
      );
      const issues = buildAttestReport(repoDir).issues;
      assert.ok(
        issues.some((i) => /ngram requested but license is not Pro\/IT/.test(i)),
        `attest must warn about the mismatch, got ${JSON.stringify(issues)}`,
      );

      // Reindexing on the downgraded tier restores hash-backed retrieval.
      reindexAllEmbeds(db);
      assert.ok(searchClaimsEmbed(db, repo.id, "payment retry").length > 0);
      rmSync(repoDir, { recursive: true, force: true });
    });
  });
});

describe("tier matrix: license file validation", () => {
  it("refuses a self-issued dev license on every tier", async () => {
    await withAmemHome(async () => {
      const { parseLicenseFile, applyLicenseJson } = await import("../dist/license.js");
      for (const tier of TIERS) {
        const dev = { kind: "dev", payload: { tier, issued_at: new Date().toISOString() } };
        assert.throws(() => parseLicenseFile(dev), /Self-issued/, `dev ${tier} must be refused`);
        assert.throws(() => applyLicenseJson(dev), /getamem\.com/);
      }
    });
  });

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
        assert.throws(() => parseLicenseFile(input), pattern, `input ${JSON.stringify(input)}`);
      }
    });
  });

  it("degrades to free instead of crashing on a corrupt license file", async () => {
    await withAmemHome(async () => {
      const { licenseStatus, licensePath, hasFeature } = await import("../dist/license.js");
      writeFileSync(licensePath(), "{ not json at all", "utf8");
      const status = licenseStatus();
      assert.equal(status.tier, "free");
      assert.equal(status.valid, false);
      assert.ok(status.issues.length > 0);
      assert.equal(hasFeature("hygiene"), false);
    });
  });

  it("does not let one tier's license verify under another vendor key", async () => {
    await withAmemHome(async () => {
      const { generateLicenseKeys, signLicense, writeLicense, licenseStatus } = await import(
        "../dist/license.js"
      );
      for (const tier of ["pro", "it"]) {
        const vendor = generateLicenseKeys();
        process.env.AMEM_LICENSE_PUBKEY = vendor.publicKeyHex;
        writeLicense(
          signLicense(vendor.privateKeyHex, { tier, issued_at: new Date().toISOString() }),
        );
        assert.equal(licenseStatus().tier, tier);

        process.env.AMEM_LICENSE_PUBKEY = generateLicenseKeys().publicKeyHex;
        const status = licenseStatus();
        assert.equal(status.tier, "free", `${tier} must not verify under a foreign key`);
        assert.equal(status.valid, false);
      }
    });
  });
});

describe("tier matrix: HTTP routes per tier", () => {
  it("returns 403 on gated routes below the required tier and 200 at or above it", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("matrix-http");
      const repo = await seedRepo(repoDir, { pin: true });
      const { handleApi } = await import("../dist/api/routes.js");

      const call = (method, pathname) =>
        handleApi({
          method,
          pathname,
          searchParams: new URLSearchParams({ repo: repo.id }),
          body: method === "POST" ? {} : null,
          cwd: repoDir,
        });

      for (const tier of TIERS) {
        await setTier(tier);
        const gated = GATES.hygiene[tier];

        const license = call("GET", "/api/license");
        assert.equal(license.status, 200);
        assert.equal(license.body.tier, tier);

        // Preview stays open on every tier so free users can see what cleanup would do.
        assert.equal(call("GET", "/api/hygiene/preview").status, 200, `${tier}: preview`);

        for (const route of ["/api/hygiene/accept-safe", "/api/rules/sync"]) {
          const res = call("POST", route);
          assert.equal(res.status, gated ? 200 : 403, `${tier}: ${route} -> ${res.status}`);
          if (!gated) assert.match(JSON.stringify(res.body), /Pro or IT/);
        }
      }
      rmSync(repoDir, { recursive: true, force: true });
    });
  });
});

describe("tier matrix: CLI per tier", () => {
  it("issues each tier and enforces the gate at the command line", async () => {
    const { generateLicenseKeys } = await import("../dist/license.js");
    const keys = generateLicenseKeys();
    const home = mkdtempSync(join(tmpdir(), "amem-matrix-cli-"));
    const repoDir = makeGitRepo("matrix-cli");
    try {
      const env = {
        AMEM_HOME: home,
        HOME: home,
        AMEM_LICENSE_PUBKEY: keys.publicKeyHex,
        AMEM_LICENSE_PRIVKEY: keys.privateKeyHex,
      };
      runAmem(["init", "--platform", "cursor"], { env, cwd: repoDir });
      runAmem(["remember", "payments retry with backoff", "--kind", "constraint"], {
        env,
        cwd: repoDir,
      });

      for (const tier of TIERS) {
        const out = join(home, `${tier}.json`);
        runAmem(["license", "issue", "--tier", tier, "--out", out], { env, cwd: repoDir });
        runAmem(["license", "apply", "--file", out], { env, cwd: repoDir });

        const status = JSON.parse(runAmem(["license", "status", "--json"], { env, cwd: repoDir }));
        assert.equal(status.tier, tier);
        assert.equal(status.valid, true);
        for (const [feature, expected] of Object.entries(GATES)) {
          assert.equal(
            status.features.includes(feature),
            expected[tier],
            `CLI ${tier} × ${feature}`,
          );
        }

        const attest = JSON.parse(runAmem(["doctor", "--attest", "--json"], { env, cwd: repoDir }));
        assert.equal(Boolean(attest.sku), GATES.attest_sku[tier], `CLI ${tier} attest sku`);

        // `amem rules sync` must exit non-zero on free so scripts notice the paywall.
        let failed = false;
        try {
          runAmem(["rules", "sync"], { env, cwd: repoDir });
        } catch (e) {
          failed = true;
          assert.match(String(e.stderr || e.stdout || ""), /Pro or IT/);
        }
        assert.equal(failed, !GATES.rules_sync[tier], `CLI ${tier}: rules sync exit`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
