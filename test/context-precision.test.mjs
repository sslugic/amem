import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

async function setup(claims, tasks = []) {
  const repoDir = makeGitRepo("precision");
  const { upsertRepo, insertTask, setClaimPinned } = await import("../dist/db.js");
  const { detectRepoIdentity } = await import("../dist/repo-identity.js");
  const { applyProposal } = await import("../dist/proposal.js");
  const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");
  applyProposal(repo.id, { claims: claims.map((c) => ({ code_anchors: ["README.md"], ...c })) });
  for (const c of claims) if (c.pinned) setClaimPinned(repo.id, c.id, true);
  for (const t of tasks) insertTask({ repoId: repo.id, ...t });
  return { repo, repoDir };
}

describe("context precision", () => {
  it("ignores stopwords, so unrelated memories do not match through 'the' / 'is'", async () => {
    await withAmemHome(async () => {
      const { contentTokens } = await import("../dist/search.js");
      assert.deepEqual(contentTokens("what is the status of the billing work"), ["status", "billing"]);
      const { buildContext } = await import("../dist/context.js");
      const { repo } = await setup([
        { id: "claim.billing", kind: "project", text: "Billing retries are live on staging and back off for 30 minutes." },
        { id: "claim.other", kind: "fact", text: "The onboarding form is the first step of the funnel and is rendered server side." },
      ]);
      const ids = buildContext(repo.id, "what is the status of the billing work", 8).claims.map((c) => c.id);
      assert.equal(ids[0], "claim.billing");
      assert.ok(!ids.includes("claim.other"), "no match through stopwords");
    });
  });

  it("shows only tasks the question is about", async () => {
    await withAmemHome(async () => {
      const { buildContext } = await import("../dist/context.js");
      const { repo } = await setup(
        [{ id: "claim.billing", kind: "project", text: "Billing retries back off for 30 minutes before paging." }],
        [
          { title: "Login journeys: Google happy path", body: "Firebase emulator", status: "next" },
          { title: "Billing retry alerting", body: "page after the third retry", status: "next" },
          { title: "Login coverage: wallet sign-in", body: "signed nonce", status: "done" },
        ],
      );
      const titles = buildContext(repo.id, "how do billing retries back off", 8).tasks.map((t) => t.title);
      assert.deepEqual(titles, ["Billing retry alerting"]);
      const start = buildContext(repo.id, "", 8).tasks.map((t) => t.status);
      assert.ok(start.length >= 2 && start.every((s) => s !== "done"), "session start lists the open backlog");
    });
  });

  it("does not put a pinned memory into every packet", async () => {
    await withAmemHome(async () => {
      const { buildContext } = await import("../dist/context.js");
      const { repo } = await setup([
        { id: "claim.pinned", kind: "constraint", text: "The report iframe is sandboxed HTML from scripts/report.mjs.", pinned: true },
        { id: "claim.billing", kind: "project", text: "Billing retries back off for 30 minutes before paging." },
      ]);
      const ids = buildContext(repo.id, "billing retries", 8).claims.map((c) => c.id);
      assert.ok(!ids.includes("claim.pinned"));
      assert.ok(buildContext(repo.id, "report iframe", 8).claims.some((c) => c.id === "claim.pinned"));
    });
  });

  it("answers time questions with recent dated work", async () => {
    await withAmemHome(async () => {
      const { buildContext, hasTimeIntent } = await import("../dist/context.js");
      assert.equal(hasTimeIntent("what did I work on yesterday for standup"), true);
      assert.equal(hasTimeIntent("how do billing retries back off"), false);
      const { repo } = await setup([
        { id: "claim.worklog", kind: "worklog", text: "Shipped the retry dashboard and filed two follow-up bugs." },
        { id: "claim.rule", kind: "constraint", text: "Never page on the first retry of a billing job." },
      ]);
      assert.equal(buildContext(repo.id, "what did I do yesterday", 8).claims[0]?.id, "claim.worklog");
    });
  });

  it("keeps the newest of two near-duplicate status updates", async () => {
    const { dropSupersededUpdates } = await import("../dist/context.js");
    const older = { id: "a", kind: "project", text: "Billing retry rollout status: backend merged, staging config pending review", updated_at: "2026-10-20T00:00:00Z" };
    const newer = { id: "b", kind: "project", text: "Billing retry rollout status: backend merged, staging config applied and live", updated_at: "2026-10-22T00:00:00Z" };
    const other = { id: "c", kind: "project", text: "Onboarding funnel copy was reviewed with design", updated_at: "2026-10-21T00:00:00Z" };
    assert.deepEqual(dropSupersededUpdates([older, other, newer]).map((c) => c.id), ["b", "c"]);
  });

  it("never captures pasted system notifications or bare replies", async () => {
    const { isUsefulCaptureText } = await import("../dist/capture.js");
    const { nonFactReason } = await import("../dist/kinds.js");
    assert.equal(isUsefulCaptureText("Yes open the bug <task-notification> <task-id>abc</task-id> done"), false);
    assert.equal(nonFactReason("[SYSTEM NOTIFICATION - NOT USER INPUT] background task finished"), "system-text");
    assert.equal(nonFactReason("Yes open the bug but no manual steps for the reporter please"), "chat-fragment");
  });
});
