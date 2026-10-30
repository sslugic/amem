import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("personal memory in work repositories", () => {
  it("keeps career notes and loose matches out, lets on-topic prefs in", async () => {
    await withAmemHome(async () => {
      const { ensurePersonalWorkspace } = await import("../dist/personal.js");
      const { upsertRepo } = await import("../dist/db.js");
      const { applyProposal } = await import("../dist/proposal.js");
      const { buildContext } = await import("../dist/context.js");
      const { recentPersonalContext } = await import("../dist/hook.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");

      const personal = ensurePersonalWorkspace("app");
      applyProposal(personal.id, {
        claims: [
          {
            id: "claim.interview",
            kind: "fact",
            text: "Acme interview loop: weekly Wednesday monorepo deploy, hiring manager round went well",
            code_anchors: ["acme", "interview", "career"],
          },
          {
            id: "claim.pref",
            kind: "constraint",
            text: "I prefer squash merges and short deploy notes in pull requests",
            code_anchors: ["personal"],
          },
        ],
      });

      const repoDir = makeGitRepo();
      const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");
      applyProposal(repo.id, {
        claims: [{ id: "claim.repo", kind: "structure", text: "Deploys run from deploy.yml", code_anchors: ["deploy.yml"] }],
      });

      const ids = (q) => buildContext(repo.id, q, { limit: 8, rootPath: repoDir }).claims.map((c) => c.id);

      // A deploy question shares one word with the interview note: not enough, and it is career anyway.
      assert.ok(!ids("start the app runner deploy").includes("claim.interview"));
      // A question that overlaps a normal preference on two words still gets it.
      assert.ok(ids("squash merges for pull requests").includes("claim.pref"));
      // Asking about the interview itself is allowed.
      assert.ok(ids("acme interview loop recap").includes("claim.interview"));
      // Session start never lists career notes in a work repository.
      const recent = recentPersonalContext(repo) || "";
      assert.ok(!recent.includes("interview loop"), recent);
      assert.ok(recent.includes("squash merges"), recent);
    });
  });
});
