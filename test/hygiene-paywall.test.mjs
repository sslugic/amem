import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAmemHome, makeGitRepo, installTestLicense } from "./helpers.mjs";

describe("hygiene preview + accept-safe + schedule", () => {
  it("preview works on free; accept-safe and report need Pro", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("hygiene-paywall");
      const { upsertRepo } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { applyProposal } = await import("../dist/proposal.js");
      const {
        hygienePreview,
        hygieneReport,
        acceptSafeCleanups,
        SOFT_PAYWALL_FACTS,
        SOFT_PAYWALL_NOISE,
      } = await import("../dist/hygiene.js");
      const { clearLicense } = await import("../dist/license.js");
      const { handleApi } = await import("../dist/api/routes.js");

      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      const claims = [];
      for (let i = 0; i < 12; i++) {
        claims.push({
          id: `claim.noise_${i}`,
          kind: "session",
          text: `Nearly identical noise about the same file README.md and local setup loop ${i % 2}`,
          code_anchors: ["README.md"],
        });
      }
      for (let i = 0; i < 8; i++) {
        claims.push({
          id: `claim.unique_${i}`,
          kind: "constraint",
          text: `Totally unique constraint about module-${i} payment retry semantics`,
          code_anchors: [`src/mod${i}.ts`],
        });
      }
      applyProposal(repo.id, { claims });

      clearLicense();
      const preview = hygienePreview(repo.id);
      assert.ok(preview.active >= 20);
      assert.ok(preview.duplicateCount >= 1);
      assert.equal(typeof preview.softPaywall, "boolean");
      assert.ok(preview.afterCleanup <= preview.active);
      assert.equal(typeof preview.sessionCount, "number");
      assert.equal(typeof preview.sessionRatio, "number");
      assert.ok(preview.sessionCount >= 12);
      assert.equal(SOFT_PAYWALL_FACTS, 200);
      assert.equal(SOFT_PAYWALL_NOISE, 15);

      // Session-heavy graphs trip the soft paywall even under the fact-count threshold.
      clearLicense();
      const sessionClaims = [];
      for (let i = 0; i < 30; i++) {
        sessionClaims.push({
          id: `claim.session_flood_${i}`,
          kind: "session",
          text: `Short chat takeaway number ${i} about nothing durable`,
          code_anchors: ["README.md"],
        });
      }
      applyProposal(repo.id, { claims: sessionClaims });
      const flood = hygienePreview(repo.id);
      assert.ok(flood.sessionRatio >= 0.55);
      assert.equal(flood.softPaywall, true, "high session ratio should soft-paywall on free");

      const freePreview = handleApi({
        method: "GET",
        pathname: "/api/hygiene/preview",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: null,
        cwd: repoDir,
      });
      assert.equal(freePreview.status, 200);
      assert.ok(freePreview.body.active >= 20);

      assert.throws(() => hygieneReport(repo.id), /Pro|license|hygiene/i);
      assert.throws(() => acceptSafeCleanups(repo.id), /Pro|license|hygiene/i);

      const blocked = handleApi({
        method: "POST",
        pathname: "/api/hygiene/accept-safe",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: {},
        cwd: repoDir,
      });
      assert.equal(blocked.status, 403);

      await installTestLicense("pro");
      const paidPreview = hygienePreview(repo.id);
      assert.equal(paidPreview.softPaywall, false, "paid licenses must not report softPaywall");
      const paidApi = handleApi({
        method: "GET",
        pathname: "/api/hygiene/preview",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: null,
        cwd: repoDir,
      });
      assert.equal(paidApi.status, 200);
      assert.equal(paidApi.body.softPaywall, false);

      const cleaned = acceptSafeCleanups(repo.id);
      assert.ok(Array.isArray(cleaned.decayed));
      assert.ok(Array.isArray(cleaned.merged));
      assert.ok(cleaned.merged.length >= 1);

      const sched = handleApi({
        method: "GET",
        pathname: "/api/hygiene/schedule",
        searchParams: new URLSearchParams(),
        body: null,
        cwd: repoDir,
      });
      assert.equal(sched.status, 200);
      assert.equal(typeof sched.body.installed, "boolean");
    });
  });

  it("schedule install writes a helper and can unschedule", async () => {
    await withAmemHome(async () => {
      const {
        installHygieneSchedule,
        uninstallHygieneSchedule,
        isHygieneScheduleInstalled,
        writeHygieneHelperScript,
      } = await import("../dist/hygiene-schedule.js");

      if (!["darwin", "linux", "win32"].includes(process.platform)) return;

      const helper = writeHygieneHelperScript();
      assert.ok(helper.includes("amem-hygiene"));
      const installed = installHygieneSchedule({ hour: 5 });
      assert.ok(installed.path);
      assert.equal(installed.hour, 5);
      assert.equal(isHygieneScheduleInstalled(), true);
      uninstallHygieneSchedule();
      assert.equal(isHygieneScheduleInstalled(), false);
    });
  });
});
