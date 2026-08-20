import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("license apply JSON + retrieval showdown", () => {
  it("applies a dev license from JSON without a file path", async () => {
    await withAmemHome(async () => {
      const { applyLicenseJson, activateDevLicense, clearLicense, licenseStatus, readLicenseFile } =
        await import("../dist/license.js");
      clearLicense();
      activateDevLicense("pro");
      const file = readLicenseFile();
      assert.ok(file);
      clearLicense();
      assert.equal(licenseStatus().tier, "free");
      const applied = applyLicenseJson(file);
      assert.equal(applied.tier, "pro");
      assert.equal(applied.valid, true);
      assert.ok(applied.features.includes("local_embed_model"));
    });
  });

  it("showdown locks Pro on free and unlocks after Pro; API apply works", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo } = await import("../dist/db.js");
      const { applyProposal } = await import("../dist/proposal.js");
      const { buildRetrievalShowdown } = await import("../dist/context.js");
      const { activateDevLicense, clearLicense, readLicenseFile } = await import("../dist/license.js");
      const { handleApi } = await import("../dist/api/routes.js");

      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      applyProposal(repo.id, {
        claims: [
          {
            id: "claim.alpha",
            kind: "constraint",
            text: "Webhook retries must stay idempotent on event.id before mutate invoices",
            code_anchors: ["src/api.ts"],
          },
          {
            id: "claim.beta",
            kind: "gotcha",
            text: "n-gram embeddings boost semantic near-matches for vault passphrase restore flow",
            code_anchors: ["src/crypto.ts"],
          },
          {
            id: "claim.gamma",
            kind: "howto",
            text: "Run amem embed use ngram then reindex after applying a Pro license file",
            code_anchors: ["docs/license.md"],
          },
        ],
      });

      clearLicense();
      const locked = buildRetrievalShowdown(repo.id, "n-gram embeddings vault restore", 5);
      assert.equal(locked.proLocked, true);
      assert.equal(locked.pro.length, 0);
      assert.ok(locked.free.length >= 1);

      activateDevLicense("pro");
      const open = buildRetrievalShowdown(repo.id, "n-gram embeddings vault restore", 5);
      assert.equal(open.proLocked, false);
      assert.ok(open.pro.length >= 1);
      assert.ok(Array.isArray(open.proOnlyIds));

      const showdownApi = handleApi({
        method: "POST",
        pathname: "/api/retrieval/showdown",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: { query: "idempotent webhook event.id" },
        cwd: repoDir,
      });
      assert.equal(showdownApi.status, 200);
      assert.equal(showdownApi.body.proLocked, false);
      assert.ok(showdownApi.body.free.length >= 1);

      const lic = readLicenseFile();
      clearLicense();
      const viaApi = handleApi({
        method: "POST",
        pathname: "/api/license/apply",
        searchParams: new URLSearchParams(),
        body: { json: lic },
        cwd: repoDir,
      });
      assert.equal(viaApi.status, 200);
      assert.equal(viaApi.body.tier, "pro");
    });
  });
});
