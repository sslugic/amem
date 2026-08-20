import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { withAmemHome, makeGitRepo, touchFuture } from "./helpers.mjs";

describe("capture + context ranking", () => {
  it("captureSessionDraft stores pending proposal without applying claims", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo, listClaims, listProposalDrafts } = await import("../dist/db.js");
        const { captureSessionDraft, isUsefulCaptureText } = await import("../dist/capture.js");

        assert.equal(isUsefulCaptureText("ok"), false);
        assert.equal(isUsefulCaptureText("password=secretvalue"), false);
        assert.equal(isUsefulCaptureText("How does auth startup work in src/auth.ts?"), true);

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        const draft = captureSessionDraft({
          repo,
          platform: "cursor",
          sessionId: "s1",
          prompt: "How does auth startup work in src/auth.ts?",
          answer: "Auth checks mode before Drive sync in src/auth.ts",
        });
        assert.ok(draft);
        assert.equal(draft.status, "pending");
        assert.equal(listClaims(repo.id).length, 0);
        assert.equal(listProposalDrafts(repo.id, { status: "pending" }).length, 1);

        const noop = captureSessionDraft({
          repo,
          platform: "cursor",
          prompt: "ok",
        });
        assert.equal(noop, null);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  it("buildContext ranks FTS hits, pins, and marks stale", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo, setClaimPinned } = await import("../dist/db.js");
        const { applyProposal } = await import("../dist/proposal.js");
        const { buildContext, renderContextMarkdown } = await import("../dist/context.js");

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        applyProposal(repo.id, {
          claims: [
            {
              id: "claim.boot_order",
              kind: "constraint",
              text: "Boot flow initializes API before serving requests",
              code_anchors: ["src/api.ts"],
            },
            {
              id: "claim.unrelated",
              kind: "session",
              text: "Completely different topic about invoices",
              code_anchors: ["src/auth.ts"],
            },
          ],
        });

        const stemmed = buildContext(repo.id, "booting initializes", {
          rootPath: repoDir,
        });
        assert.ok(stemmed.claims.some((c) => c.id === "claim.boot_order"));

        setClaimPinned(repo.id, "claim.unrelated", true);
        const pinnedPacket = buildContext(repo.id, "zzz-no-match-token-qqq", {
          rootPath: repoDir,
        });
        // pin boost alone should keep pinned claim visible
        assert.ok(pinnedPacket.claims.some((c) => c.id === "claim.unrelated"));

        // Make api claim stale
        touchFuture(join(repoDir, "src", "api.ts"));
        const stalePacket = buildContext(repo.id, "boot api", { rootPath: repoDir });
        const boot = stalePacket.claims.find((c) => c.id === "claim.boot_order");
        assert.ok(boot);
        assert.equal(boot.freshness.status, "stale");
        const md = renderContextMarkdown(stalePacket);
        assert.match(md, /stale/i);
        assert.match(md, /Pinned: `yes`/);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  it("hook stop creates draft instead of auto-applying", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo, listClaims, listProposalDrafts } = await import("../dist/db.js");
        const { applyProposal: apply } = await import("../dist/proposal.js");
        const { handleHookPayload } = await import("../dist/hook.js");

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        apply(repo.id, {
          claims: [
            {
              id: "claim.seed",
              kind: "structure",
              text: "API entrypoint lives in src/api.ts",
              code_anchors: ["src/api.ts"],
            },
          ],
        });
        const before = listClaims(repo.id).length;

        handleHookPayload(
          JSON.stringify({
            hook_event_name: "beforeSubmitPrompt",
            prompt: "Explain boot order for the API in src/api.ts please",
            workspace_roots: [repoDir],
            conversation_id: "unit-conv",
          }),
        );
        handleHookPayload(
          JSON.stringify({
            hook_event_name: "afterAgentResponse",
            text: "Boot flow initializes API before serving requests via src/api.ts",
            workspace_roots: [repoDir],
            conversation_id: "unit-conv",
          }),
        );
        handleHookPayload(
          JSON.stringify({
            hook_event_name: "stop",
            workspace_roots: [repoDir],
            conversation_id: "unit-conv",
          }),
        );

        assert.equal(listClaims(repo.id).length, before);
        assert.ok(listProposalDrafts(repo.id, { status: "pending" }).length >= 1);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});
