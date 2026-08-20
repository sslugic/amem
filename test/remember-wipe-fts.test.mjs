import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("remember + wipe + export edges", () => {
  it("remember API upserts a claim and wipe removes binding", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo, listClaims, getRepoById } = await import("../dist/db.js");
        const { handleApi } = await import("../dist/api/routes.js");

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        const remembered = handleApi({
          method: "POST",
          pathname: "/api/remember",
          searchParams: new URLSearchParams(),
          body: {
            repoId: repo.id,
            text: "Prefer verifying anchors before broad greps",
            kind: "constraint",
            anchors: ["src/api.ts"],
          },
          cwd: repoDir,
        });
        assert.equal(remembered.status, 200);
        assert.ok(remembered.body.claimId);
        assert.ok(listClaims(repo.id).some((c) => c.id === remembered.body.claimId));

        const wipe = handleApi({
          method: "POST",
          pathname: "/api/wipe",
          searchParams: new URLSearchParams({ repo: repo.id }),
          body: { yes: true },
          cwd: repoDir,
        });
        assert.equal(wipe.status, 200);
        assert.equal(getRepoById(repo.id), null);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  it("context API requires query and logs usage", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo } = await import("../dist/db.js");
        const { applyProposal } = await import("../dist/proposal.js");
        const { handleApi } = await import("../dist/api/routes.js");

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        applyProposal(repo.id, {
          claims: [
            {
              id: "claim.ctx",
              kind: "structure",
              text: "Context lookup uses FTS and keywords",
              code_anchors: ["src/api.ts"],
            },
          ],
        });

        const missing = handleApi({
          method: "POST",
          pathname: "/api/context",
          searchParams: new URLSearchParams({ repo: repo.id }),
          body: {},
          cwd: repoDir,
        });
        assert.equal(missing.status, 400);

        const ok = handleApi({
          method: "POST",
          pathname: "/api/context",
          searchParams: new URLSearchParams({ repo: repo.id }),
          body: { query: "FTS keywords", platform: "cursor" },
          cwd: repoDir,
        });
        assert.equal(ok.status, 200);
        assert.match(ok.body.markdown, /claim\.ctx/);
        assert.ok(ok.body.event?.id);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});

describe("search FTS index integration", () => {
  it("searchClaimsFts finds stemmed terms after apply", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo, openDb } = await import("../dist/db.js");
        const { applyProposal } = await import("../dist/proposal.js");
        const { searchClaimsFts } = await import("../dist/search.js");

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        applyProposal(repo.id, {
          claims: [
            {
              id: "claim.initialize",
              kind: "constraint",
              text: "Service initializes workers during boot",
              code_anchors: ["src/api.ts"],
            },
          ],
        });
        const hits = searchClaimsFts(openDb(), repo.id, "initializing", 10);
        assert.ok(hits.some((h) => h.id === "claim.initialize"));
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});
