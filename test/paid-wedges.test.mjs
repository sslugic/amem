import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("auto-capture applies strong session facts", () => {
  it("stores a high-quality session draft as an applied claim", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo, listClaims, listProposalDrafts } = await import("../dist/db.js");
      const { captureSessionDraft, shouldAutoApplyProposal } = await import("../dist/capture.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      const prompt = "Webhook retries must stay idempotent in src/api.ts";
      const answer =
        "Stripe webhooks must be idempotent on event.id in src/api.ts before mutating invoices. Never apply the same event twice.";
      const built = {
        claims: [
          {
            id: "claim.demo",
            kind: "constraint",
            text: answer,
            code_anchors: ["src/api.ts"],
          },
        ],
      };
      assert.equal(shouldAutoApplyProposal(built), true);
      const draft = captureSessionDraft({
        repo,
        platform: "cursor",
        prompt,
        answer,
      });
      assert.ok(draft);
      assert.equal(listProposalDrafts(repo.id, { status: "applied" }).length >= 1, true);
      assert.ok(listClaims(repo.id).some((c) => /idempotent/i.test(c.text)));
    });
  });
});

describe("restore backup", () => {
  it("restores an encrypted backup over a later database", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo, listRepos, closeDb, openDb } = await import("../dist/db.js");
      const { createBackup, restoreBackup } = await import("../dist/crypto.js");
      upsertRepo(detectRepoIdentity(repoDir), "cursor");
      closeDb();
      const backup = createBackup({ passphrase: "restore-pass", label: "wedge" });
      assert.equal(backup.encrypted, true);
      openDb();
      upsertRepo(detectRepoIdentity(makeGitRepo()), "cursor");
      assert.ok(listRepos().length >= 2);
      closeDb();
      const restored = restoreBackup({ file: backup.path, passphrase: "restore-pass" });
      assert.ok(restored.safetyCopy);
      openDb();
      assert.equal(listRepos().length, 1);
    });
  });
});

describe("hygiene", () => {
  it("finds duplicates and refuses the feature on free", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo } = await import("../dist/db.js");
      const { applyProposal } = await import("../dist/proposal.js");
      const { hygieneReport, mergeDuplicate } = await import("../dist/hygiene.js");
      const { activateDevLicense, clearLicense } = await import("../dist/license.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      applyProposal(repo.id, {
        claims: [
          {
            id: "claim.one",
            kind: "constraint",
            text: "Webhook idempotency uses event.id in src/api.ts before mutate",
            code_anchors: ["src/api.ts"],
          },
          {
            id: "claim.two",
            kind: "constraint",
            text: "Webhook idempotency uses event.id in src/api.ts before mutate invoices",
            code_anchors: ["src/api.ts"],
          },
        ],
      });
      clearLicense();
      assert.throws(() => hygieneReport(repo.id), /Pro or IT/);
      activateDevLicense("pro");
      const report = hygieneReport(repo.id, 90);
      assert.ok(report.duplicates.length >= 1);
      const merged = mergeDuplicate(repo.id, "claim.one", "claim.two");
      assert.equal(merged.keepId, "claim.one");
    });
  });
});

describe("external embedder", () => {
  it("reads a local command vector", async () => {
    await withAmemHome(async (home) => {
      const script = join(home, "embed-echo.mjs");
      writeFileSync(
        script,
        `const chunks=[]; for await (const c of process.stdin) chunks.push(c);
const text = Buffer.concat(chunks).toString("utf8");
const v = Array.from({ length: 8 }, (_, i) => (text.length + i) / 100);
console.log(JSON.stringify({ vector: v }));
`,
        "utf8",
      );
      const { activateDevLicense } = await import("../dist/license.js");
      const { setEmbedBackend, embedExternal, embedStatus } = await import("../dist/embed.js");
      activateDevLicense("pro");
      setEmbedBackend("external", { command: process.execPath, args: [script], dim: 8 });
      assert.equal(embedStatus().backend, "external");
      const vec = embedExternal("hello amem");
      assert.equal(vec.length, 8);
    });
  });
});

describe("rules sync + IT pack", () => {
  it("writes pinned cursor rules and an IT pack folder", async () => {
    await withAmemHome(async (home) => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo } = await import("../dist/db.js");
      const { applyProposal } = await import("../dist/proposal.js");
      const { setClaimPinned } = await import("../dist/db.js");
      const { activateDevLicense } = await import("../dist/license.js");
      const { syncPinnedRules } = await import("../dist/rules-sync.js");
      const { writeItPack, buildSbom } = await import("../dist/it-pack.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      applyProposal(repo.id, {
        claims: [
          {
            id: "claim.pinme",
            kind: "constraint",
            text: "Auth must run before Drive sync in src/auth.ts",
            code_anchors: ["src/auth.ts"],
          },
        ],
      });
      setClaimPinned(repo.id, "claim.pinme", true);
      activateDevLicense("pro");
      const synced = syncPinnedRules(repo);
      assert.equal(synced.pinned, 1);
      assert.ok(existsSync(synced.path));
      assert.match(readFileSync(synced.path, "utf8"), /Auth must run/);

      const pack = writeItPack(join(home, "it-pack"));
      assert.ok(existsSync(join(pack.dir, "policy.toml")));
      assert.ok(existsSync(join(pack.dir, "sbom.json")));
      const sbom = buildSbom();
      assert.equal(sbom.bomFormat, "CycloneDX");
      assert.ok(sbom.components.some((c) => c.name === "better-sqlite3"));
    });
  });
});
