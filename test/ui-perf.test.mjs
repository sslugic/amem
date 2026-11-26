/**
 * Tab switches in `amem ui` took seconds on a busy machine: every Analytics/Memory load
 * re-labelled every usage event by fully scoring long prompts against every claim, and
 * /api/usage shipped every event (tens of MB). These guard the fixes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

async function seed(dir, events) {
  const { upsertRepo, insertUsageEvent } = await import("../dist/db.js");
  const { detectRepoIdentity } = await import("../dist/repo-identity.js");
  const { applyProposal } = await import("../dist/proposal.js");
  const repo = upsertRepo(detectRepoIdentity(dir), "claude");
  const claims = Array.from({ length: 300 }, (_, i) => ({
    id: `claim.c${i}`,
    kind: "constraint",
    text: `Service ${i} owns the billing reconciliation step ${i} for invoices and refunds`,
    code_anchors: ["README.md"],
  }));
  applyProposal(repo.id, { claims });
  const longPrompt = Array.from({ length: 250 }, (_, i) => `word${i}`).join(" ");
  for (let i = 0; i < events; i += 1) {
    insertUsageEvent({
      repoId: repo.id,
      platform: "claude",
      query: i % 2 ? longPrompt : `billing reconciliation ${i}`,
      claimIds: [`claim.c${i % 300}`, `claim.c${(i + 1) % 300}`],
      anchorsCount: 1,
      claimsCount: 2,
      packetTokens: 200,
      estimatedTokensSaved: 1000,
    });
  }
  return repo;
}

describe("dashboard performance", () => {
  it("labels thousands of usage events quickly and identically to full scoring", async () => {
    await withAmemHome(async () => {
      const dir = makeGitRepo();
      const repo = await seed(dir, 3000);
      const { listUsageEvents, listClaims } = await import("../dist/db.js");
      const { decorateUsageEvents, decorateUsageEvent } = await import("../dist/context.js");
      const events = listUsageEvents({ repoId: repo.id, days: 30 });
      const t = performance.now();
      const fast = decorateUsageEvents(events);
      const ms = performance.now() - t;
      assert.ok(ms < 1500, `3000 events labelled in ${Math.round(ms)}ms`);
      // Same labels as the original per-event path.
      const claims = listClaims(repo.id);
      for (const [i, e] of events.slice(0, 200).entries()) {
        assert.equal(fast[i].kind, decorateUsageEvent(e, claims).kind, e.id);
      }
      assert.ok(fast.some((e) => e.kind === "local_hit"));
      assert.ok(fast.some((e) => e.kind === "server_trip"));
      // Warm (the long-running dashboard): labels come from the cache.
      const t2 = performance.now();
      decorateUsageEvents(events);
      assert.ok(performance.now() - t2 < ms, "second pass is faster");
    });
  });

  it("/api/usage returns the aggregate, top claims and a short event list, not every event", async () => {
    await withAmemHome(async () => {
      const dir = makeGitRepo();
      await seed(dir, 400);
      const { handleApi } = await import("../dist/api/routes.js");
      const res = handleApi({ method: "GET", pathname: "/api/usage", searchParams: new URLSearchParams("days=30"), body: null, cwd: dir });
      assert.equal(res.status, 200);
      assert.equal(res.body.eventsTotal, 400);
      assert.equal(res.body.events.length, 50);
      assert.ok(res.body.topClaims.length > 0 && res.body.topClaims.length <= 20);
      assert.ok(res.body.topClaims[0].n >= res.body.topClaims.at(-1).n);
      assert.equal(res.body.aggregate.totals.queries, 400, "aggregate still covers every event");
    });
  });

  it("caches repo detection only when the UI server turns it on", async () => {
    const { detectRepoIdentity, setRepoIdentityCacheTtl } = await import("../dist/repo-identity.js");
    const dir = makeGitRepo();
    try {
      setRepoIdentityCacheTtl(15_000);
      const first = detectRepoIdentity(dir);
      const t = performance.now();
      for (let i = 0; i < 20; i += 1) assert.deepEqual(detectRepoIdentity(dir), first);
      assert.ok(performance.now() - t < 50, "cached lookups spawn no git");
    } finally {
      setRepoIdentityCacheTtl(0);
    }
  });
});
