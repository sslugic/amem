import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { withAmemHome, makeGitRepo, root } from "./helpers.mjs";

const cli = join(root, "dist", "cli.js");

describe("draft quality scoring", () => {
  it("scores durable claims high and chat noise as reject", async () => {
    const { scoreProposal } = await import("../dist/draft-quality.js");
    const high = scoreProposal({
      claims: [
        {
          id: "claim.boot",
          kind: "constraint",
          text: "Auth mode must be checked in src/auth.ts before Drive sync starts.",
          code_anchors: ["src/auth.ts"],
        },
      ],
    });
    assert.equal(high.reject, false);
    assert.ok(high.score >= 60, `expected high score, got ${high.score}`);
    assert.equal(high.label, "high");

    const junk = scoreProposal({
      claims: [{ id: "claim.chat", kind: "session", text: "ok sure thanks", code_anchors: [] }],
    });
    assert.equal(junk.reject, true);
    assert.equal(junk.label, "reject");
  });

  it("does not queue a reject-scored session draft", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo, listProposalDrafts } = await import("../dist/db.js");
      const { captureSessionDraft } = await import("../dist/capture.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      const skipped = captureSessionDraft({
        repo,
        platform: "cursor",
        prompt: "ok",
        answer: "sure thanks",
      });
      assert.equal(skipped, null);
      assert.equal(listProposalDrafts(repo.id, { status: "pending" }).length, 0);
    });
  });

  it("decorates pending drafts with quality and can reject noisy ones", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo, insertProposalDraft, listProposalDrafts } = await import(
        "../dist/db.js"
      );
      const { handleApi } = await import("../dist/api/routes.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      insertProposalDraft({
        repoId: repo.id,
        platform: "cursor",
        title: "thin chat",
        source: "test-noise",
        proposal: {
          claims: [{ id: "claim.noise", kind: "session", text: "ok thanks", code_anchors: [] }],
        },
      });
      const listed = handleApi({
        method: "GET",
        pathname: "/api/drafts",
        searchParams: new URLSearchParams({ repo: repo.id, status: "pending" }),
        body: null,
        cwd: repoDir,
      });
      assert.equal(listed.status, 200);
      assert.equal(listed.body.drafts[0].quality.reject, true);

      const rejected = handleApi({
        method: "POST",
        pathname: "/api/drafts/reject-noisy",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: {},
        cwd: repoDir,
      });
      assert.equal(rejected.status, 200);
      assert.equal(rejected.body.count, 1);
      assert.equal(listProposalDrafts(repo.id, { status: "pending" }).length, 0);
    });
  });

  it("bulk-approves high drafts and dismisses junk", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo, insertProposalDraft, listProposalDrafts, listClaims } = await import(
        "../dist/db.js"
      );
      const { handleApi } = await import("../dist/api/routes.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      insertProposalDraft({
        repoId: repo.id,
        platform: "cursor",
        title: "good",
        source: "test-high",
        proposal: {
          claims: [
            {
              id: "claim.good",
              kind: "constraint",
              text: "Auth mode must be checked in src/auth.ts before Drive sync starts.",
              code_anchors: ["src/auth.ts"],
            },
          ],
        },
      });
      insertProposalDraft({
        repoId: repo.id,
        platform: "cursor",
        title: "junk",
        source: "test-junk",
        proposal: {
          claims: [{ id: "claim.junk", kind: "session", text: "ok thanks", code_anchors: [] }],
        },
      });
      const approved = handleApi({
        method: "POST",
        pathname: "/api/drafts/bulk",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: { action: "approve_high" },
        cwd: repoDir,
      });
      assert.equal(approved.status, 200);
      assert.equal(approved.body.appliedCount, 1);
      assert.ok(listClaims(repo.id).some((c) => c.id === "claim.good"));

      const junked = handleApi({
        method: "POST",
        pathname: "/api/drafts/bulk",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: { action: "dismiss_junk" },
        cwd: repoDir,
      });
      assert.equal(junked.status, 200);
      assert.equal(junked.body.dismissedCount, 1);
      assert.equal(listProposalDrafts(repo.id, { status: "pending" }).length, 0);
    });
  });
});

describe("draft conflict UI / apply resolve", () => {
  it("returns 409 with structured conflicts, then supersedes on resolve", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo, insertProposalDraft, listClaims } = await import("../dist/db.js");
      const { applyProposal } = await import("../dist/proposal.js");
      const { handleApi } = await import("../dist/api/routes.js");

      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      applyProposal(repo.id, {
        claims: [
          {
            id: "claim.old_auth",
            kind: "constraint",
            text: "Auth mode must be checked during sync service startup",
            code_anchors: ["src/auth.ts"],
          },
        ],
      });
      const draft = insertProposalDraft({
        repoId: repo.id,
        platform: "cursor",
        title: "newer auth rule",
        source: "test-conflict",
        proposal: {
          claims: [
            {
              id: "claim.new_auth",
              kind: "constraint",
              text: "Auth mode must be checked during sync service startup before Drive",
              code_anchors: ["src/auth.ts"],
            },
          ],
        },
      });

      const blocked = handleApi({
        method: "POST",
        pathname: "/api/drafts/apply",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: { id: draft.id },
        cwd: repoDir,
      });
      assert.equal(blocked.status, 409);
      assert.ok(blocked.body.conflicts.some((c) => c.otherId === "claim.old_auth"));

      const applied = handleApi({
        method: "POST",
        pathname: "/api/drafts/apply",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: { id: draft.id, resolve: "supersede" },
        cwd: repoDir,
      });
      assert.equal(applied.status, 200);
      const claims = listClaims(repo.id, { includeSuperseded: true });
      const old = claims.find((c) => c.id === "claim.old_auth");
      assert.equal(old.status, "superseded");
      assert.ok(claims.some((c) => c.id === "claim.new_auth" && c.status === "active"));
    });
  });
});

describe("savings export", () => {
  it("builds markdown, json, and a readable PDF", async () => {
    const { buildSavingsExport, formatSavingsMarkdown, savingsPdf } = await import(
      "../dist/savings-export.js"
    );
    const report = buildSavingsExport({
      scope: "all",
      days: 30,
      repoName: "demo",
      generatedAt: "2026-08-20T15:00:00.000Z",
      aggregate: {
        totals: {
          queries: 10,
          estimatedTokensSaved: 4000,
          estimatedUsdSaved: 0.012,
          localHits: 8,
          serverTrips: 2,
          hitRate: 0.8,
        },
        monthly: { estimatedTokensSaved: 12000, estimatedUsdSaved: 0.036, sampleQueries: 10, trendDays: 7 },
        byPlatform: [{ platform: "cursor", queries: 10, estimatedTokensSaved: 4000, estimatedUsdSaved: 0.012 }],
      },
    });
    const md = formatSavingsMarkdown(report);
    assert.match(md, /not a Cursor or model bill/);
    assert.match(md, /4000/);
    const pdf = savingsPdf(report);
    assert.match(pdf.subarray(0, 5).toString(), /%PDF-/);
    assert.match(pdf.toString("latin1"), /amem savings report/);
  });

  it("exports via API and CLI", async () => {
    await withAmemHome(async (home) => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo } = await import("../dist/db.js");
      const { logContextUsage } = await import("../dist/api/routes.js");
      const { handleApi } = await import("../dist/api/routes.js");
      const { applyProposal } = await import("../dist/proposal.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      applyProposal(repo.id, {
        claims: [
          {
            id: "claim.api_entry",
            kind: "structure",
            text: "API entrypoint lives in src/api.ts",
            code_anchors: ["src/api.ts"],
          },
        ],
      });
      logContextUsage({ repoId: repo.id, platform: "cursor", query: "API entrypoint" });

      const json = handleApi({
        method: "GET",
        pathname: "/api/usage/export",
        searchParams: new URLSearchParams({ repo: repo.id, format: "json", days: "30" }),
        body: null,
        cwd: repoDir,
      });
      assert.equal(json.status, 200);
      assert.match(json.body.filename, /\.json$/);
      assert.match(json.body.report.disclaimer, /not a Cursor or model bill/);

      const pdf = handleApi({
        method: "GET",
        pathname: "/api/usage/export",
        searchParams: new URLSearchParams({ repo: repo.id, format: "pdf" }),
        body: null,
        cwd: repoDir,
      });
      assert.equal(pdf.status, 200);
      assert.ok(Buffer.from(pdf.body.contentBase64, "base64").subarray(0, 4).toString() === "%PDF");

      const out = join(home, "savings.md");
      const printed = execFileSync(process.execPath, [cli, "usage", "export", "--format", "md", "--out", out], {
        encoding: "utf8",
        env: { ...process.env, AMEM_HOME: home },
        cwd: repoDir,
      });
      assert.match(printed, /Wrote savings export/);
      assert.ok(existsSync(out));
      assert.match(readFileSync(out, "utf8"), /amem savings report/);
    });
  });
});

describe("continue / zed host adapters", () => {
  it("writes Continue yaml drop-in and Zed HTTP url, and reports health", async () => {
    await withAmemHome(async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "amem-host-next-"));
      const prev = process.env.HOME;
      process.env.HOME = fakeHome;
      try {
        const { installHost, continueInstallHealth, zedInstallHealth } = await import(
          "../dist/install/hosts.js"
        );
        assert.ok(continueInstallHealth()[0]);
        const cont = installHost("continue", { workspace: "personal" });
        assert.ok(cont.paths.some((p) => p.endsWith("amem.yaml")));
        assert.ok(existsSync(join(fakeHome, ".continue", "mcpServers", "amem.yaml")));
        assert.match(
          readFileSync(join(fakeHome, ".continue", "mcpServers", "amem.yaml"), "utf8"),
          /127\.0\.0\.1:7843/,
        );
        assert.deepEqual(continueInstallHealth(), []);

        const zed = installHost("zed", { workspace: "personal" });
        const zedJson = JSON.parse(readFileSync(zed.paths[0], "utf8"));
        assert.match(zedJson.context_servers.amem.url, /mcp\?workspace=personal/);
        assert.deepEqual(zedInstallHealth(), []);
      } finally {
        if (prev === undefined) delete process.env.HOME;
        else process.env.HOME = prev;
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });
  });
});
