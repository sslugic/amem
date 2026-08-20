import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("API routes coverage", () => {
  it("claims search, pin, patch, delete, graph drafts", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo } = await import("../dist/db.js");
        const { applyProposal } = await import("../dist/proposal.js");
        const { handleApi } = await import("../dist/api/routes.js");
        const { captureSessionDraft } = await import("../dist/capture.js");

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        applyProposal(repo.id, {
          claims: [
            {
              id: "claim.searchable",
              kind: "constraint",
              text: "Webhook idempotency uses event.id",
              code_anchors: ["src/api.ts"],
            },
          ],
        });
        captureSessionDraft({
          repo,
          platform: "cursor",
          prompt: "What should I know about webhook retries in src/api.ts?",
          answer: "Retry with backoff on 5xx",
        });

        const search = handleApi({
          method: "GET",
          pathname: "/api/claims/search",
          searchParams: new URLSearchParams({ q: "webhook", repo: repo.id }),
          body: null,
          cwd: repoDir,
        });
        assert.equal(search.status, 200);
        assert.ok((search.body.claims || []).some((c) => c.id === "claim.searchable"));

        const pin = handleApi({
          method: "POST",
          pathname: "/api/claims/pin",
          searchParams: new URLSearchParams({ repo: repo.id }),
          body: { id: "claim.searchable", pinned: true },
          cwd: repoDir,
        });
        assert.equal(pin.status, 200);
        assert.equal(pin.body.claim.pinned, 1);

        const patch = handleApi({
          method: "PATCH",
          pathname: "/api/claims",
          searchParams: new URLSearchParams({ repo: repo.id }),
          body: {
            id: "claim.searchable",
            text: "Webhook idempotency uses event.id before mutate",
            kind: "constraint",
            code_anchors: ["src/api.ts"],
          },
          cwd: repoDir,
        });
        assert.equal(patch.status, 200);
        assert.match(patch.body.claim.text, /before mutate/);

        const graph = handleApi({
          method: "GET",
          pathname: "/api/graph",
          searchParams: new URLSearchParams({ repo: repo.id }),
          body: null,
          cwd: repoDir,
        });
        assert.equal(graph.status, 200);
        assert.ok(Array.isArray(graph.body.drafts));
        assert.ok(graph.body.drafts.length >= 1);

        const del = handleApi({
          method: "DELETE",
          pathname: "/api/claims",
          searchParams: new URLSearchParams({ id: "claim.searchable", repo: repo.id }),
          body: null,
          cwd: repoDir,
        });
        assert.equal(del.status, 200);

        const missing = handleApi({
          method: "DELETE",
          pathname: "/api/claims",
          searchParams: new URLSearchParams({ id: "claim.searchable", repo: repo.id }),
          body: null,
          cwd: repoDir,
        });
        assert.equal(missing.status, 404);

        const badPin = handleApi({
          method: "POST",
          pathname: "/api/claims/pin",
          searchParams: new URLSearchParams({ repo: repo.id }),
          body: { id: "claim.searchable", pinned: "yes" },
          cwd: repoDir,
        });
        assert.equal(badPin.status, 400);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  it("service API reports supported platforms", async () => {
    await withAmemHome(async () => {
      const { handleApi } = await import("../dist/api/routes.js");
      const res = handleApi({
        method: "GET",
        pathname: "/api/service",
        searchParams: new URLSearchParams(),
        body: null,
        cwd: process.cwd(),
      });
      assert.equal(res.status, 200);
      assert.equal(typeof res.body.supported, "boolean");
      assert.equal(typeof res.body.installed, "boolean");
      assert.ok(res.body.servicePlatform);
    });
  });
});
