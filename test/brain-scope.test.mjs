import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("auto-approve + all-memory graph", () => {
  it("applies pending drafts when auto-approve is turned on", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo, insertProposalDraft, listClaims, listProposalDrafts } = await import(
        "../dist/db.js"
      );
      const { setAutoApplyAll } = await import("../dist/prefs.js");
      const { applyPendingDrafts, captureSessionDraft } = await import("../dist/capture.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      insertProposalDraft({
        repoId: repo.id,
        platform: "cursor",
        title: "Use src/auth.ts for session cookies",
        source: "test-pending",
        proposal: {
          claims: [
            {
              id: "claim.pending_auto",
              kind: "constraint",
              text: "Session cookies are set in src/auth.ts only",
              code_anchors: ["src/auth.ts"],
            },
          ],
        },
      });
      assert.equal(listProposalDrafts(repo.id, { status: "pending" }).length, 1);
      setAutoApplyAll(true);
      const flushed = applyPendingDrafts();
      assert.equal(flushed.applied.length, 1);
      assert.equal(listProposalDrafts(repo.id, { status: "pending" }).length, 0);
      assert.ok(listClaims(repo.id).some((c) => /src\/auth\.ts/.test(c.text)));

      const later = captureSessionDraft({
        repo,
        platform: "cursor",
        prompt: "Keep webhook retries idempotent in src/api.ts",
        answer: "Webhook handlers must ignore duplicate event.id in src/api.ts before writes.",
      });
      assert.ok(later);
      assert.equal(later.status, "applied");
    });
  });

  it("GET /api/graph?scope=all merges two bindings", async () => {
    await withAmemHome(async () => {
      const a = makeGitRepo();
      const b = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo } = await import("../dist/db.js");
      const { applyProposal } = await import("../dist/proposal.js");
      const { handleApi } = await import("../dist/api/routes.js");
      const repoA = upsertRepo(detectRepoIdentity(a), "cursor");
      const repoB = upsertRepo(detectRepoIdentity(b), "cursor");
      applyProposal(repoA.id, {
        claims: [
          { id: "claim.a", kind: "constraint", text: "Repo A uses src/auth.ts for login", code_anchors: ["src/auth.ts"] },
        ],
      });
      applyProposal(repoB.id, {
        claims: [
          { id: "claim.b", kind: "structure", text: "Repo B stores jobs in src/queue.ts", code_anchors: ["src/queue.ts"] },
        ],
      });
      const res = handleApi({
        method: "GET",
        pathname: "/api/graph",
        searchParams: new URLSearchParams("scope=all"),
        body: null,
        cwd: a,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.scope, "all");
      const texts = (res.body.claims || []).map((c) => c.text).join("\n");
      assert.match(texts, /Repo A/);
      assert.match(texts, /Repo B/);

      const prefs = handleApi({
        method: "POST",
        pathname: "/api/prefs",
        searchParams: new URLSearchParams(),
        body: { autoApplyAll: true },
        cwd: a,
      });
      assert.equal(prefs.status, 200);
      assert.equal(prefs.body.autoApplyAll, true);
    });
  });

  it("GET /api/graph?scope=all works without a cwd repo", async () => {
    await withAmemHome(async (home) => {
      const { handleApi } = await import("../dist/api/routes.js");
      const res = handleApi({
        method: "GET",
        pathname: "/api/graph",
        searchParams: new URLSearchParams("scope=all"),
        body: null,
        cwd: home,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.scope, "all");
      assert.ok(Array.isArray(res.body.claims));
    });
  });
});
