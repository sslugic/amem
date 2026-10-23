import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("clipText", () => {
  it("cuts at a sentence, then a word, never mid-word", async () => {
    const { clipText } = await import("../dist/text-clip.js");
    const text = "First sentence is here. Second sentence runs on and on without stopping anywhere soon";
    assert.equal(clipText(text, 200), text);
    assert.equal(clipText(text, 40), "First sentence is here. …");
    const words = clipText("alpha beta gamma delta epsilon zeta eta theta", 25);
    assert.ok(words.endsWith("…"));
    assert.ok(!/\w…$/.test(words.replace(/ …$/, "")) || words.split(" ").every((w) => w.length > 0));
    assert.ok(words.length <= 26);
  });
});

describe("prompt-derived skills", () => {
  it("are not suggested unless used", async () => {
    const { rankSkills, isPromptDerivedSkill } = await import("../dist/skills.js");
    const junk = { name: "can-you-check-the-regression-run", description: "Procedure for can you check the regression run", tags: ["workflow", "auto-generated"], uses: 0 };
    const real = { name: "regression-triage", description: "Triage the morning regression run and fix non-product failures", tags: [], uses: 0 };
    assert.equal(isPromptDerivedSkill(junk), true);
    assert.equal(isPromptDerivedSkill({ ...junk, uses: 3 }), false);
    assert.equal(isPromptDerivedSkill(real), false);
    const ranked = rankSkills([junk, real], "check the regression run", 3).map((s) => s.name);
    assert.deepEqual(ranked, ["regression-triage"]);
  });
});

describe("personal memory in work repos", () => {
  it("leaves private memories out and ranks repo-relevant ones first", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("billing-service");
      const { upsertRepo } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { ensurePersonalWorkspace } = await import("../dist/personal.js");
      const { handleApi } = await import("../dist/api/routes.js");
      const { recentPersonalContext } = await import("../dist/hook.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");
      const personal = ensurePersonalWorkspace("claude");
      const remember = (text, kind, anchors) =>
        handleApi({
          method: "POST",
          pathname: "/api/remember",
          searchParams: new URLSearchParams({ repo: personal.id }),
          body: { text, kind, anchors },
          cwd: repoDir,
        }).status;
      assert.equal(remember("Planning a dentist appointment for next Tuesday afternoon", "private"), 200);
      assert.equal(remember("A friend is referring me to a job at another company", "fact", ["private"]), 200);
      assert.equal(remember("Weekly team sync moved to Thursdays at 10am", "fact"), 200);
      assert.equal(remember("billing-service retries need a 30 minute backoff before paging", "project"), 200);

      const text = recentPersonalContext(repo);
      assert.ok(text, "has personal context");
      assert.doesNotMatch(text, /dentist|referring me/);
      const lines = text.split("\n").filter((l) => l.startsWith("- "));
      assert.match(lines[0], /billing-service/, "repo-relevant memory first");
      assert.match(text, /team sync/);
    });
  });
});
