import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { inferClaimKind, compactClaimText, kindRankBoost } from "../dist/kinds.js";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("kinds + ranking explainability", () => {
  it("infers durable kinds from language", () => {
    assert.equal(inferClaimKind("never call this twice", "gotcha: breaks invoices"), "gotcha");
    assert.equal(inferClaimKind("webhooks must be idempotent", ""), "constraint");
    assert.equal(inferClaimKind("who owns billing?", "owned by payments team"), "owner");
    assert.equal(inferClaimKind("how to run migrations", "steps to apply"), "howto");
    assert.equal(inferClaimKind("where is the API?", "entrypoint lives in src/api.ts"), "structure");
  });

  it("compacts answers into claim text", () => {
    const text = compactClaimText(
      "long question ".repeat(20),
      "First sentence. Second sentence. Third should be dropped.",
    );
    assert.match(text, /First sentence/);
    assert.match(text, /Second sentence/);
    assert.ok(!text.includes("Third should"));
  });

  it("kind weights prefer constraints over sessions", () => {
    assert.ok(kindRankBoost("constraint") > kindRankBoost("session"));
    assert.ok(kindRankBoost("gotcha") >= kindRankBoost("structure"));
  });

  it("context packet includes Why reasons and kind tie-break", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo } = await import("../dist/db.js");
        const { applyProposal } = await import("../dist/proposal.js");
        const { buildContext, renderContextMarkdown } = await import("../dist/context.js");

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        applyProposal(repo.id, {
          claims: [
            {
              id: "claim.weak_session",
              kind: "session",
              text: "API boot discussion notes",
              code_anchors: ["src/api.ts"],
            },
            {
              id: "claim.strong_rule",
              kind: "constraint",
              text: "API boot must initialize auth before serving",
              code_anchors: ["src/api.ts"],
            },
          ],
        });
        const packet = buildContext(repo.id, "API boot", { rootPath: repoDir });
        assert.ok(packet.claims[0]?.reasons?.length);
        assert.equal(packet.claims[0]?.id, "claim.strong_rule");
        const md = renderContextMarkdown(packet);
        assert.match(md, /Why:/);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});

describe("miss → learn", () => {
  it("queues a durable draft after a context miss + answer with paths", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo, listClaims, listProposalDrafts, insertUsageEvent } = await import(
          "../dist/db.js"
        );
        const { captureMissLearnDraft, findRecentContextMisses } = await import(
          "../dist/capture.js"
        );

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        insertUsageEvent({
          repoId: repo.id,
          platform: "cursor",
          sessionId: "miss-sess",
          query: "Where is webhook retry handled?",
          claimIds: [],
          anchorsCount: 0,
          claimsCount: 0,
          packetTokens: 10,
          estimatedTokensSaved: 0,
          kind: "server_trip",
        });
        const misses = findRecentContextMisses(repo.id, { sessionId: "miss-sess" });
        assert.equal(misses.length, 1);

        const draft = captureMissLearnDraft({
          repo,
          platform: "cursor",
          sessionId: "miss-sess",
          miss: misses[0],
          answer:
            "Webhook retries are handled in src/api.ts with exponential backoff on 5xx responses.",
        });
        assert.ok(draft);
        assert.match(draft.source, /^miss-learn:/);
        assert.equal(listClaims(repo.id).length, 0);
        assert.ok(listProposalDrafts(repo.id, { status: "pending" }).some((d) => d.id === draft.id));

        // idempotent — same miss does not duplicate
        const again = captureMissLearnDraft({
          repo,
          platform: "cursor",
          miss: misses[0],
          answer: "Webhook retries are handled in src/api.ts with exponential backoff on 5xx responses.",
        });
        assert.equal(again, null);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});

describe("propose diff", () => {
  it("diffs added vs updated claims and supersede targets", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo } = await import("../dist/db.js");
        const { applyProposal, diffProposal, formatProposalDiff } = await import(
          "../dist/proposal.js"
        );

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        applyProposal(repo.id, {
          claims: [
            {
              id: "claim.a",
              kind: "structure",
              text: "old text",
              code_anchors: ["src/api.ts"],
            },
          ],
        });
        const diff = diffProposal(repo.id, {
          claims: [
            {
              id: "claim.a",
              kind: "structure",
              text: "new text",
              code_anchors: ["src/api.ts"],
            },
            {
              id: "claim.b",
              kind: "constraint",
              text: "brand new",
              code_anchors: ["src/auth.ts"],
              supersedes: ["claim.a"],
            },
          ],
        });
        assert.deepEqual(diff.claimsUpdated, ["claim.a"]);
        assert.deepEqual(diff.claimsAdded, ["claim.b"]);
        assert.ok(diff.willSupersede.includes("claim.a"));
        assert.match(formatProposalDiff(diff), /update claims/);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});
