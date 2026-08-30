import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("purgeNonFactClaims", () => {
  it("dry-runs by default, spares pinned claims, deletes only junk", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("purge-nonfacts");
      const { upsertRepo, listClaims, setClaimPinned } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { applyProposal } = await import("../dist/proposal.js");
      const { purgeNonFactClaims } = await import("../dist/hygiene.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");

      applyProposal(repo.id, {
        claims: [
          { id: "claim.good", kind: "constraint", text: "The loader reads src/db.ts at startup and caches the handle.", code_anchors: ["src/db.ts"] },
          { id: "claim.question", kind: "session", text: "so can we wire src/db.ts through the loader instead?", code_anchors: ["src/db.ts"] },
          { id: "claim.residue", kind: "gotcha", text: "The matching public key lives in and is what every install uses.", code_anchors: ["src/db.ts"] },
          { id: "claim.pinned_junk", kind: "session", text: "so should we just delete src/db.ts and start over?", code_anchors: ["src/db.ts"] },
        ],
      });
      setClaimPinned(repo.id, "claim.pinned_junk", true);

      const dry = purgeNonFactClaims({ repoId: repo.id });
      assert.equal(dry.dryRun, true);
      assert.equal(dry.deleted, 0, "dry run must not delete");
      assert.equal(listClaims(repo.id).length, 4, "nothing removed yet");

      const applied = purgeNonFactClaims({ repoId: repo.id, dryRun: false });
      assert.ok(applied.deleted >= 2, "removed the question and the residue");
      const left = listClaims(repo.id).map((c) => c.id);
      assert.ok(left.includes("claim.good"), "real fact kept");
      assert.ok(!left.includes("claim.question"), "question removed");
      assert.ok(!left.includes("claim.residue"), "scrub residue removed");
      assert.ok(left.includes("claim.pinned_junk"), "pinned claim spared even though it is junk");
    });
  });
});
