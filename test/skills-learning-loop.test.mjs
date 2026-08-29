import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

function seedSkill(home, name, content) {
  const dir = join(home, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
}

const DEPLOY_SKILL = `---
name: deploy-staging
description: Deploy the staging server and verify health
---

# Deploy Staging
`;

async function bindRepo(prefix = "skills-loop-") {
  const repoDir = makeGitRepo(prefix);
  const { upsertRepo } = await import("../dist/db.js");
  const { detectRepoIdentity } = await import("../dist/repo-identity.js");
  return { repo: upsertRepo(detectRepoIdentity(repoDir), "cursor"), repoDir };
}

/** A session that genuinely looks like a repeatable, hard-won procedure. */
function proceduralNotes() {
  return [
    { role: "user", text: "the staging deploy keeps failing, can you figure out the right sequence" },
    {
      role: "assistant",
      text: [
        "I hit an error on the first attempt: the migration failed because the database was not reachable.",
        "1. Run `npm run build` to produce the bundle.",
        "2. Run `docker compose up -d db` and wait for the health check.",
        "3. Run `npm run migrate` against the staging URL.",
        "4. Run `kubectl rollout restart deploy/api` to pick up the new image.",
        "After adding step 2 the migration passed and the rollout is green — it works now.",
      ].join("\n"),
    },
    { role: "user", text: "no, actually we use pnpm here not npm, redo it with that" },
    {
      role: "assistant",
      text: [
        "Understood. Corrected sequence, verified end to end:",
        "1. `pnpm build` produces the bundle.",
        "2. `docker compose up -d db` and wait for healthy.",
        "3. `pnpm migrate` against staging.",
        "4. `kubectl rollout restart deploy/api`.",
        "The deploy succeeded and the health endpoint returns 200. That did it.",
      ].join("\n"),
    },
  ];
}

/** Ordinary chatter that must never produce a suggestion. */
function chattyNotes() {
  return [
    { role: "user", text: "what does this repo do again?" },
    { role: "assistant", text: "It is a local memory tool for coding agents. It stores facts in SQLite." },
    { role: "user", text: "thanks" },
    { role: "assistant", text: "Happy to help. Let me know if you want to dig into any part of it." },
  ];
}

test("detects a hard-won multi-step procedure", async () => {
  const { detectSkillOpportunity } = await import("../dist/skill-capture.js");
  const found = detectSkillOpportunity(proceduralNotes());
  assert.ok(found, "should flag a procedural session");
  assert.ok(found.reasons.length >= 2, "needs multiple independent signals");
  assert.ok(found.score >= 55);
  assert.match(found.title, /staging deploy/i);
});

test("stays quiet on ordinary conversation", async () => {
  const { detectSkillOpportunity } = await import("../dist/skill-capture.js");
  assert.equal(detectSkillOpportunity(chattyNotes()), null);
  assert.equal(detectSkillOpportunity([]), null);
  assert.equal(detectSkillOpportunity([{ role: "user", text: "hi" }]), null);
  // Steps alone, with no struggle and no correction, are not enough.
  assert.equal(
    detectSkillOpportunity([
      { role: "user", text: "list the steps" },
      { role: "assistant", text: `${"1. do a thing\n2. do another\n3. done\n".repeat(20)}` },
    ]),
    null,
  );
});

test("session end queues one suggestion, and only one", async () => {
  await withAmemHome(async () => {
    const { repo } = await bindRepo();
    const { captureSkillSuggestion } = await import("../dist/skill-capture.js");
    const { listSkillDrafts } = await import("../dist/db.js");

    const first = captureSkillSuggestion({ repo, sessionId: "s1", notes: proceduralNotes() });
    assert.ok(first);
    assert.equal(first.kind, "suggestion");
    assert.equal(first.content, null, "amem has no model — it must not invent a body");

    const again = captureSkillSuggestion({ repo, sessionId: "s1", notes: proceduralNotes() });
    assert.equal(again, null, "same session must not queue twice");
    assert.equal(listSkillDrafts({ status: "pending" }).length, 1);
  });
});

test("skill_capture=false turns the nudge off", async () => {
  await withAmemHome(async (home) => {
    writeFileSync(join(home, "policy.toml"), "skill_capture = false\n");
    const { clearPolicyCache } = await import("../dist/policy.js");
    clearPolicyCache();
    const { repo } = await bindRepo();
    const { captureSkillSuggestion } = await import("../dist/skill-capture.js");
    assert.equal(captureSkillSuggestion({ repo, sessionId: "s1", notes: proceduralNotes() }), null);
    clearPolicyCache();
  });
});

test("the nudge reaches the agent through the next context packet", async () => {
  await withAmemHome(async () => {
    const { repo } = await bindRepo();
    const { captureSkillSuggestion } = await import("../dist/skill-capture.js");
    const { buildContext, renderContextMarkdown } = await import("../dist/context.js");

    captureSkillSuggestion({ repo, sessionId: "s1", notes: proceduralNotes() });
    const packet = buildContext(repo.id, "anything at all");
    assert.equal(packet.skillDrafts.length, 1);

    const md = renderContextMarkdown(packet);
    assert.match(md, /## Worth saving as a skill/);
    assert.match(md, /amem_skill_save/);
    assert.match(md, /user corrected the approach/);
  });
});

test("a skill followed during a bad session queues a revision, not a new skill", async () => {
  await withAmemHome(async (home) => {
    seedSkill(home, "deploy-staging", DEPLOY_SKILL);
    const { repo } = await bindRepo();
    const { syncSkillIndex } = await import("../dist/skills.js");
    const { recordSkillUse, listSkillDrafts } = await import("../dist/db.js");
    const { captureSkillRevision } = await import("../dist/skill-capture.js");

    syncSkillIndex();
    recordSkillUse("deploy-staging", { repoId: repo.id, sessionId: "s9" });

    const revision = captureSkillRevision({ repo, sessionId: "s9", notes: proceduralNotes() });
    assert.ok(revision);
    assert.equal(revision.kind, "revision");
    assert.equal(revision.target_skill, "deploy-staging");
    assert.equal(listSkillDrafts({ status: "pending" }).length, 1);

    const md = await import("../dist/context.js").then(({ buildContext, renderContextMarkdown }) =>
      renderContextMarkdown(buildContext(repo.id, "anything")),
    );
    assert.match(md, /## Skill worth revising/);
    assert.match(md, /deploy-staging/);
  });
});

test("no revision when the session went fine", async () => {
  await withAmemHome(async (home) => {
    seedSkill(home, "deploy-staging", DEPLOY_SKILL);
    const { repo } = await bindRepo();
    const { syncSkillIndex } = await import("../dist/skills.js");
    const { recordSkillUse } = await import("../dist/db.js");
    const { captureSkillRevision } = await import("../dist/skill-capture.js");
    syncSkillIndex();
    recordSkillUse("deploy-staging", { repoId: repo.id, sessionId: "s9" });
    assert.equal(captureSkillRevision({ repo, sessionId: "s9", notes: chattyNotes() }), null);
  });
});

test("no revision when no skill was actually followed", async () => {
  await withAmemHome(async () => {
    const { repo } = await bindRepo();
    const { captureSkillRevision } = await import("../dist/skill-capture.js");
    assert.equal(captureSkillRevision({ repo, sessionId: "s9", notes: proceduralNotes() }), null);
  });
});

test("write approval stages the agent's skill instead of writing it", async () => {
  await withAmemHome(async (home) => {
    writeFileSync(join(home, "policy.toml"), "skill_write_approval = true\n");
    const { clearPolicyCache } = await import("../dist/policy.js");
    clearPolicyCache();
    const { repoDir } = await bindRepo();
    const { handleApi } = await import("../dist/api/routes.js");
    const { findSkillOnDisk } = await import("../dist/skills.js");
    const { listSkillDrafts } = await import("../dist/db.js");

    const save = handleApi({
      method: "POST",
      pathname: "/api/skills",
      searchParams: new URLSearchParams(),
      body: { name: "gated-skill", description: "A gated procedure", content: "# Gated\n\n1. Step.\n" },
      cwd: repoDir,
    });
    assert.equal(save.status, 200);
    assert.equal(save.body.pending, true);
    assert.equal(findSkillOnDisk("gated-skill"), null, "must not reach disk before approval");

    const [draft] = listSkillDrafts({ status: "pending" });
    assert.equal(draft.name, "gated-skill");
    assert.ok(draft.content, "staged draft must carry the body to review");

    const apply = handleApi({
      method: "POST",
      pathname: "/api/skills/drafts/apply",
      searchParams: new URLSearchParams(),
      body: { id: draft.id },
      cwd: repoDir,
    });
    assert.equal(apply.status, 200);
    assert.ok(findSkillOnDisk("gated-skill"), "approval writes it to disk");
    assert.equal(listSkillDrafts({ status: "pending" }).length, 0);
    clearPolicyCache();
  });
});

test("a suggestion cannot be approved into a skill, since it has no body", async () => {
  await withAmemHome(async () => {
    const { repo, repoDir } = await bindRepo();
    const { captureSkillSuggestion } = await import("../dist/skill-capture.js");
    const { handleApi } = await import("../dist/api/routes.js");

    const draft = captureSkillSuggestion({ repo, sessionId: "s1", notes: proceduralNotes() });
    const res = handleApi({
      method: "POST",
      pathname: "/api/skills/drafts/apply",
      searchParams: new URLSearchParams(),
      body: { id: draft.id },
      cwd: repoDir,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /suggestion/i);
  });
});

test("saving a skill clears the nudge that prompted it", async () => {
  await withAmemHome(async () => {
    const { repo, repoDir } = await bindRepo();
    const { captureSkillSuggestion } = await import("../dist/skill-capture.js");
    const { handleApi } = await import("../dist/api/routes.js");
    const { listSkillDrafts } = await import("../dist/db.js");

    captureSkillSuggestion({ repo, sessionId: "s1", notes: proceduralNotes() });
    assert.equal(listSkillDrafts({ status: "pending" }).length, 1);

    const res = handleApi({
      method: "POST",
      pathname: "/api/skills",
      searchParams: new URLSearchParams(),
      body: { name: "deploy-staging", description: "Deploy staging", content: "# Deploy\n\n1. Go.\n" },
      cwd: repoDir,
    });
    assert.equal(res.status, 200);
    assert.equal(listSkillDrafts({ status: "pending" }).length, 0, "nudge should not keep nagging");
  });
});

test("dismissing a draft stops the nudge without writing anything", async () => {
  await withAmemHome(async () => {
    const { repo, repoDir } = await bindRepo();
    const { captureSkillSuggestion } = await import("../dist/skill-capture.js");
    const { handleApi } = await import("../dist/api/routes.js");
    const { buildContext } = await import("../dist/context.js");

    const draft = captureSkillSuggestion({ repo, sessionId: "s1", notes: proceduralNotes() });
    const res = handleApi({
      method: "POST",
      pathname: "/api/skills/drafts/dismiss",
      searchParams: new URLSearchParams(),
      body: { id: draft.id },
      cwd: repoDir,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(buildContext(repo.id, "anything").skillDrafts, []);
  });
});

test("skills_enabled=false disables injection and saving", async () => {
  await withAmemHome(async (home) => {
    writeFileSync(join(home, "policy.toml"), "skills_enabled = false\n");
    const { clearPolicyCache } = await import("../dist/policy.js");
    clearPolicyCache();
    seedSkill(home, "deploy-staging", DEPLOY_SKILL);
    const { repo, repoDir } = await bindRepo();
    const { buildContext } = await import("../dist/context.js");
    const { handleApi } = await import("../dist/api/routes.js");

    const packet = buildContext(repo.id, "deploy staging");
    assert.deepEqual(packet.skills, []);
    assert.deepEqual(packet.skillDrafts, []);

    const res = handleApi({
      method: "POST",
      pathname: "/api/skills",
      searchParams: new URLSearchParams(),
      body: { name: "nope", description: "x", content: "# No\n\n1. Step.\n" },
      cwd: repoDir,
    });
    assert.equal(res.status, 403);
    clearPolicyCache();
  });
});

test("a broken policy file forces skill writes into review", async () => {
  await withAmemHome(async (home) => {
    writeFileSync(join(home, "policy.toml"), "this is not valid policy\n");
    const { clearPolicyCache, loadPolicy } = await import("../dist/policy.js");
    clearPolicyCache();
    const loaded = loadPolicy(true);
    assert.ok(loaded.sources.some((s) => s.error), "the bad file should be reported");
    assert.equal(loaded.policy.skill_write_approval, true, "must fail closed, not open");
    clearPolicyCache();
  });
});

test("attest inventories skills with hashes for audit", async () => {
  await withAmemHome(async (home) => {
    seedSkill(home, "deploy-staging", DEPLOY_SKILL);
    seedSkill(home, "no-desc", `---\nname: no-desc\n---\n`);
    await bindRepo();
    const { buildAttestReport } = await import("../dist/attest.js");
    const report = buildAttestReport();

    assert.equal(report.skills.enabled, true);
    const names = report.skills.installed.map((s) => s.name).sort();
    assert.deepEqual(names, ["deploy-staging", "no-desc"]);
    const deploy = report.skills.installed.find((s) => s.name === "deploy-staging");
    assert.match(deploy.hash, /^[0-9a-f]{16}$/, "hash lets auditors diff machines");
    assert.ok(
      report.issues.some((i) => i.includes("no-desc") && i.includes("description")),
      "a skill agents cannot rank should be flagged",
    );
  });
});
