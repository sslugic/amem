import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("prompt injection relevance", () => {
  it("injects nothing for a vague prompt and the matching memory for a specific one", async () => {
    await withAmemHome(async () => {
      const { upsertRepo } = await import("../dist/db.js");
      const { applyProposal } = await import("../dist/proposal.js");
      const { handleHookPayload } = await import("../dist/hook.js");
      const { buildContext } = await import("../dist/context.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");

      const repoDir = makeGitRepo();
      const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");
      applyProposal(repo.id, {
        claims: [
          { id: "claim.flake", kind: "gotcha", text: "KYCLINK-07 flakes because expect.poll hides the real error; keep working on the plain loop", code_anchors: ["README.md"] },
          { id: "claim.look", kind: "fact", text: "The checkout page should look clean and keep the totals visible", code_anchors: ["README.md"] },
          { id: "claim.deploy", kind: "structure", text: "Deploys run from deploy.yml through App Runner", code_anchors: ["README.md"] },
        ],
      });

      const prompt = (text) =>
        handleHookPayload(JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: repoDir, session_id: "s1", prompt: text }))
          .hookSpecificOutput?.additionalContext ?? "";

      // Conversational prompts share words with memories ("look", "clean", "keep working") but name no topic.
      assert.equal(prompt("ok that looks good, keep working on it"), "");
      assert.equal(prompt("can you make it look nicer and clean it up a bit"), "");
      // Earlier prompts are notes; a filler word memory never uses must not pull them back.
      assert.equal(prompt("ok sounds good, keep going"), "");
      assert.equal(prompt("alright, wonderful, carry on"), "");
      // A ticket key alone is specific enough.
      assert.match(prompt("why does KYCLINK-07 still fail"), /plain loop/);
      // Two topic words are enough too.
      const deploy = prompt("how does the app runner deploy work");
      assert.match(deploy, /deploy\.yml/);
      assert.doesNotMatch(deploy, /checkout page/);

      // An explicit amem_context call stays loose: it still returns something to look at.
      assert.ok(buildContext(repo.id, "ok sounds good", { rootPath: repoDir }).claims.length > 0);
    });
  });

  it("matches skills on whole words, not letters inside them", async () => {
    const { rankSkills } = await import("../dist/skills.js");
    const skill = (name, description) => ({ name, description, tags: [], uses: 0, path: "", source: "user" });
    const skills = [skill("app-store-connect-edit", "Edit App Store Connect listing fields"), skill("getamem-site-deploy", "Deploy getamem.com")];
    // "it" and "on" used to match inside "edit" and "connect".
    assert.equal(rankSkills(skills, "is it on").length, 0);
    assert.equal(rankSkills(skills, "deploy the site")[0]?.name, "getamem-site-deploy");
  });
});
