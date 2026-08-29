import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("hygiene preview + accept-safe + schedule", () => {
  it("preview, report, and accept-safe are completely free and unlocked", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("hygiene-paywall");
      const { upsertRepo } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { applyProposal } = await import("../dist/proposal.js");
      const {
        hygienePreview,
        hygieneReport,
        acceptSafeCleanups,
      } = await import("../dist/hygiene.js");
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

      const preview = hygienePreview(repo.id);
      assert.ok(preview.active >= 20);
      assert.ok(preview.duplicateCount >= 1);
      assert.ok(preview.afterCleanup <= preview.active);
      assert.equal(typeof preview.sessionCount, "number");
      assert.equal(typeof preview.sessionRatio, "number");
      assert.ok(preview.sessionCount >= 12);

      const report = hygieneReport(repo.id);
      assert.ok(report.active >= 20);
      assert.ok(Array.isArray(report.stale));
      assert.ok(Array.isArray(report.duplicates));

      const apiRes = handleApi({
        method: "POST",
        pathname: "/api/hygiene/accept-safe",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: {},
        cwd: repoDir,
      });
      assert.equal(apiRes.status, 200);

      const cleaned = acceptSafeCleanups(repo.id);
      assert.ok(Array.isArray(cleaned.decayed));
      assert.ok(Array.isArray(cleaned.merged));
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
