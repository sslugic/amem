import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("db claim CRUD + drafts", () => {
  it("updateClaim, pin, delete, and FTS reindex", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const {
          upsertRepo,
          listClaims,
          updateClaim,
          setClaimPinned,
          deleteClaim,
          getClaim,
        } = await import("../dist/db.js");
        const { applyProposal } = await import("../dist/proposal.js");
        const { buildContext } = await import("../dist/context.js");

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        applyProposal(repo.id, {
          claims: [
            {
              id: "claim.edit_me",
              kind: "structure",
              text: "Original text about widgets",
              code_anchors: ["src/api.ts"],
            },
          ],
        });

        const updated = updateClaim(repo.id, "claim.edit_me", {
          text: "Revised text about widgets",
          kind: "constraint",
        });
        assert.equal(updated.text, "Revised text about widgets");
        assert.equal(updated.kind, "constraint");

        setClaimPinned(repo.id, "claim.edit_me", true);
        assert.equal(getClaim(repo.id, "claim.edit_me").pinned, 1);
        const ordered = listClaims(repo.id);
        assert.equal(ordered[0].id, "claim.edit_me");

        const hit = buildContext(repo.id, "widgets", { rootPath: repoDir });
        assert.ok(hit.claims.some((c) => c.id === "claim.edit_me"));

        assert.equal(deleteClaim(repo.id, "claim.edit_me"), true);
        assert.equal(getClaim(repo.id, "claim.edit_me"), null);
        assert.equal(deleteClaim(repo.id, "claim.edit_me"), false);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  it("draft apply and dismiss lifecycle", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const {
          upsertRepo,
          listClaims,
          listProposalDrafts,
          insertProposalDraft,
          setProposalDraftStatus,
          getProposalDraft,
        } = await import("../dist/db.js");
        const { applyProposal } = await import("../dist/proposal.js");
        const { handleApi } = await import("../dist/api/routes.js");

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        const draft = insertProposalDraft({
          repoId: repo.id,
          platform: "cursor",
          title: "Approve me",
          proposal: {
            claims: [
              {
                id: "claim.from_draft",
                kind: "session",
                text: "Drafted durable fact about src/api.ts",
                code_anchors: ["src/api.ts"],
              },
            ],
          },
        });

        const apply = handleApi({
          method: "POST",
          pathname: "/api/drafts/apply",
          searchParams: new URLSearchParams(),
          body: { id: draft.id, repoId: repo.id },
          cwd: repoDir,
        });
        assert.equal(apply.status, 200);
        assert.ok(listClaims(repo.id).some((c) => c.id === "claim.from_draft"));
        assert.equal(getProposalDraft(draft.id).status, "applied");

        const draft2 = insertProposalDraft({
          repoId: repo.id,
          platform: "cursor",
          title: "Dismiss me",
          proposal: {
            claims: [
              {
                id: "claim.dismissed",
                kind: "session",
                text: "Should not land",
                code_anchors: ["src/api.ts"],
              },
            ],
          },
        });
        const dismiss = handleApi({
          method: "POST",
          pathname: "/api/drafts/dismiss",
          searchParams: new URLSearchParams(),
          body: { id: draft2.id, repoId: repo.id },
          cwd: repoDir,
        });
        assert.equal(dismiss.status, 200);
        assert.equal(getProposalDraft(draft2.id).status, "dismissed");
        assert.ok(!listClaims(repo.id).some((c) => c.id === "claim.dismissed"));
        assert.equal(listProposalDrafts(repo.id, { status: "pending" }).length, 0);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});

describe("service install paths", () => {
  it("reports support and can install/uninstall unit file on linux", async () => {
    const {
      isServiceSupported,
      servicePlatform,
      installLoginService,
      uninstallLoginService,
      isServiceInstalled,
      systemdUserUnitPath,
    } = await import("../dist/service.js");

    assert.equal(typeof isServiceSupported(), "boolean");
    if (process.platform !== "linux") {
      assert.ok(["darwin", "win32", "unsupported"].includes(servicePlatform()));
      return;
    }

    assert.equal(servicePlatform(), "linux");
    assert.equal(isServiceSupported(), true);

    // Isolate unit path side effects: install writes under homedir; uninstall cleans.
    const before = isServiceInstalled();
    const installed = installLoginService();
    assert.equal(installed.installed, true);
    assert.ok(existsSync(installed.path));
    const body = readFileSync(installed.path, "utf8");
    assert.match(body, /amem-ui|amem|cli\.js/);
    assert.match(body, /WantedBy=default\.target/);

    const removed = uninstallLoginService();
    assert.equal(removed.installed, false);
    assert.equal(existsSync(systemdUserUnitPath()), false);

    // leave environment as we found it
    if (before) installLoginService();
  });
});
