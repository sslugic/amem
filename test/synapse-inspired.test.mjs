import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
  normalizeAnchor,
  parseAnchor,
  anchorsOverlap,
  extractAnchorsFromText,
  uniqueAnchorPaths,
} from "../dist/anchors.js";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("symbol-level anchors", () => {
  it("parses path, path:Symbol, path#Symbol, path:line", () => {
    assert.deepEqual(parseAnchor("src/api.ts"), { raw: "src/api.ts", path: "src/api.ts" });
    assert.equal(normalizeAnchor("src/api.ts#validateWebhook"), "src/api.ts:validateWebhook");
    assert.equal(normalizeAnchor("src/api.ts::Foo"), "src/api.ts:Foo");
    assert.equal(normalizeAnchor("src/api.ts:42"), "src/api.ts:42");
    assert.equal(parseAnchor("src/api.ts:validateWebhook").symbol, "validateWebhook");
  });

  it("overlap matches same path even when symbols differ", () => {
    assert.equal(
      anchorsOverlap(["src/api.ts:validateWebhook"], ["src/api.ts"]),
      true,
    );
    assert.equal(anchorsOverlap(["src/a.ts"], ["src/b.ts"]), false);
  });

  it("extracts path:Symbol from prose", () => {
    const found = extractAnchorsFromText(
      "Retries live in src/api.ts:validateWebhook with exponential backoff.",
    );
    assert.ok(found.some((a) => a === "src/api.ts:validateWebhook"));
  });

  it("uniqueAnchorPaths collapses symbols to files", () => {
    assert.deepEqual(
      uniqueAnchorPaths(["src/api.ts:Foo", "src/api.ts:Bar", "src/other.ts"]),
      ["src/api.ts", "src/other.ts"],
    );
  });

  it("freshness uses path portion of symbol anchors", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { assessClaimFreshness } = await import("../dist/freshness.js");
        const { claimFixture } = await import("./helpers.mjs");
        const nowIso = new Date().toISOString();
        const claim = claimFixture({
          updated_at: nowIso,
          code_anchors: JSON.stringify(["src/api.ts:validateWebhook"]),
        });
        assert.equal(assessClaimFreshness(repoDir, claim).status, "fresh");
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  it("applyProposal stores normalized symbol anchors", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo, listClaims } = await import("../dist/db.js");
        const { applyProposal } = await import("../dist/proposal.js");
        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        applyProposal(repo.id, {
          claims: [
            {
              id: "claim.sym",
              kind: "constraint",
              text: "Webhooks must be idempotent",
              code_anchors: ["src/api.ts#validateWebhook"],
            },
          ],
        });
        const claim = listClaims(repo.id).find((c) => c.id === "claim.sym");
        assert.equal(JSON.parse(claim.code_anchors)[0], "src/api.ts:validateWebhook");
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});

describe("retrieval reinforcement", () => {
  it("boosts claims that previously helped for similar queries", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo } = await import("../dist/db.js");
        const { applyProposal } = await import("../dist/proposal.js");
        const { buildContext } = await import("../dist/context.js");
        const { recordClaimHelpful } = await import("../dist/reinforce.js");

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        applyProposal(repo.id, {
          claims: [
            {
              id: "claim.helped",
              kind: "constraint",
              text: "Payment webhook retries use exponential backoff",
              code_anchors: ["src/api.ts"],
            },
            {
              id: "claim.other",
              kind: "structure",
              text: "Payment webhook entrypoint is in the HTTP layer",
              code_anchors: ["src/api.ts"],
            },
          ],
        });

        recordClaimHelpful(repo.id, "payment webhook retry backoff", ["claim.helped"]);
        recordClaimHelpful(repo.id, "payment webhook retry backoff", ["claim.helped"]);
        recordClaimHelpful(repo.id, "payment webhook retry backoff", ["claim.helped"]);

        const packet = buildContext(repo.id, "payment webhook retry", { rootPath: repoDir });
        assert.equal(packet.claims[0]?.id, "claim.helped");
        assert.ok(packet.claims[0]?.reasons.some((r) => r.startsWith("helped")));
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});

describe("memory gaps", () => {
  it("surfaces recurring misses and unclaimed paths", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo, insertUsageEvent } = await import("../dist/db.js");
        const { findMemoryGaps, renderGapsMarkdown } = await import("../dist/gaps.js");

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        for (let i = 0; i < 3; i++) {
          insertUsageEvent({
            repoId: repo.id,
            platform: "cursor",
            sessionId: "g1",
            query: "Where is stripe webhook retry handled?",
            claimIds: [],
            anchorsCount: 0,
            claimsCount: 0,
            packetTokens: 8,
            estimatedTokensSaved: 0,
            kind: "server_trip",
          });
        }
        insertUsageEvent({
          repoId: repo.id,
          platform: "cursor",
          sessionId: "g1",
          query: "Look at src/api.ts for handlers",
          claimIds: [],
          anchorsCount: 0,
          claimsCount: 0,
          packetTokens: 8,
          estimatedTokensSaved: 0,
          kind: "server_trip",
        });

        const gaps = findMemoryGaps(repo.id, { days: 30, limit: 8 });
        assert.ok(gaps.missQueries.length >= 1);
        assert.ok(gaps.unclaimedPaths.some((p) => p.path === "src/api.ts"));
        assert.match(renderGapsMarkdown(gaps), /Memory gaps/);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});

describe("compact context packets", () => {
  it("renders denser markdown than full format", async () => {
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
              id: "claim.compact",
              kind: "constraint",
              text: "Auth mode is checked during sync startup before Drive sync is enabled.",
              code_anchors: ["src/api.ts:boot"],
            },
          ],
        });
        const packet = buildContext(repo.id, "auth sync startup", {
          rootPath: repoDir,
          includeGaps: true,
        });
        const full = renderContextMarkdown(packet, { compact: false });
        const compact = renderContextMarkdown(packet, { compact: true });
        assert.match(full, /Agent Memory Context/);
        assert.match(compact, /^# amem/m);
        assert.ok(compact.length < full.length);
        assert.match(compact, /src\/api\.ts:boot/);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});
