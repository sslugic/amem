import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAmemHome, makeGitRepo, root } from "./helpers.mjs";

const cli = join(root, "dist", "cli.js");

async function seed(repoDir) {
  const { upsertRepo } = await import("../dist/db.js");
  const { detectRepoIdentity } = await import("../dist/repo-identity.js");
  const { applyProposal } = await import("../dist/proposal.js");
  const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
  applyProposal(repo.id, {
    claims: [
      { id: "c.1", kind: "constraint", text: "payment retry uses exponential backoff", code_anchors: ["src/pay.ts"] },
      { id: "c.2", kind: "constraint", text: "auth refresh runs before drive sync", code_anchors: ["src/auth.ts"] },
      { id: "c.3", kind: "session", text: "local setup needs node 20 or newer", code_anchors: ["README.md"] },
    ],
  });
  return repo;
}

describe("embed index health", () => {
  it("reports a clean index when nothing has drifted", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("embed-health-clean");
      await seed(repoDir);
      const { embedIndexHealth, embedIndexIssues } = await import("../dist/embed.js");
      const { openDb } = await import("../dist/db.js");
      const db = openDb();

      const health = embedIndexHealth(db);
      assert.equal(health.active, "ngram");
      assert.equal(health.stale, 0);
      assert.equal(health.usable, health.total);
      assert.ok(health.total >= 3);
      assert.deepEqual(health.strandedBy, []);
      assert.deepEqual(embedIndexIssues(db), []);
      rmSync(repoDir, { recursive: true, force: true });
    });
  });

  it("detects vectors stranded by a backend switch and clears after reindex", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("embed-health-drift");
      await seed(repoDir);
      const { embedIndexHealth, embedIndexIssues, setEmbedBackend, reindexAllEmbeds } =
        await import("../dist/embed.js");
      const { openDb } = await import("../dist/db.js");
      const db = openDb();

      assert.equal(embedIndexHealth(db).stale, 0, "reindexed on ngram should be clean");

      setEmbedBackend("hash");
      const health = embedIndexHealth(db);
      assert.equal(health.active, "hash");
      assert.equal(health.usable, 0, "no ngram vector is scorable under hash");
      assert.equal(health.stale, health.total);
      assert.deepEqual(
        health.strandedBy.map((s) => `${s.backend}/${s.dim}`),
        ["ngram/256"],
      );

      const issues = embedIndexIssues(db);
      assert.equal(issues.length, 1);
      assert.match(issues[0], /ngram\/256/);
      assert.match(issues[0], /active embed backend is hash/);
      assert.match(issues[0], /amem embed reindex/, "must name the fix");

      reindexAllEmbeds(db);
      assert.equal(embedIndexHealth(db).stale, 0);
      assert.deepEqual(embedIndexIssues(db), []);
      rmSync(repoDir, { recursive: true, force: true });
    });
  });

  it("counts a partially drifted index rather than calling it all bad", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("embed-health-partial");
      const repo = await seed(repoDir);
      const { embedIndexHealth, setEmbedBackend, upsertClaimEmbed } =
        await import("../dist/embed.js");
      const { openDb, listClaims } = await import("../dist/db.js");
      const db = openDb();

      setEmbedBackend("hash");
      const [first] = listClaims(repo.id);
      upsertClaimEmbed(db, first);

      const health = embedIndexHealth(db);
      assert.equal(health.active, "hash");
      assert.equal(health.usable, 1, "the row rewritten on hash is usable");
      assert.equal(health.stale, health.total - 1);
      rmSync(repoDir, { recursive: true, force: true });
    });
  });

  it("GET /api/embed includes index health and issues when drifted", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("embed-health-api");
      await seed(repoDir);
      const { setEmbedBackend } = await import("../dist/embed.js");
      const { handleApi } = await import("../dist/api/routes.js");

      setEmbedBackend("hash");

      const res = handleApi({
        method: "GET",
        pathname: "/api/embed",
        searchParams: new URLSearchParams(),
        body: null,
        cwd: repoDir,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.backend, "hash");
      assert.ok(res.body.index);
      assert.ok(res.body.index.stale > 0);
      assert.ok(Array.isArray(res.body.issues));
      assert.match(res.body.issues[0] || "", /amem embed reindex/);
      rmSync(repoDir, { recursive: true, force: true });
    });
  });

  it("surfaces the drift through amem doctor and attest", async () => {
    const home = mkdtempSync(join(tmpdir(), "amem-embed-doctor-"));
    const repoDir = makeGitRepo("embed-health-cli");
    const env = {
      AMEM_HOME: home,
      HOME: home,
    };
    const run = (args, extraEnv = {}) => {
      try {
        return execFileSync(process.execPath, [cli, ...args], {
          encoding: "utf8",
          cwd: repoDir,
          env: { ...process.env, ...env, ...extraEnv },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        if (e.stdout) return String(e.stdout);
        throw e;
      }
    };

    try {
      run(["init", "--platform", "cursor"]);
      run(["remember", "payment retry uses exponential backoff", "--kind", "constraint"]);

      assert.match(run(["doctor"]), /doctor: ok/, "clean index should pass doctor");

      // Switch backend to hash without reindexing to produce drift
      run(["embed", "use", "hash"]);

      const doctorOut = run(["doctor"]);
      assert.match(doctorOut, /issues found/);
      assert.match(doctorOut, /amem embed reindex/, "doctor must name the fix");

      const attest = JSON.parse(run(["doctor", "--attest", "--json"]));
      assert.ok(
        attest.issues.some((i) => /amem embed reindex/.test(i)),
        `attest must carry the drift issue, got ${JSON.stringify(attest.issues)}`,
      );

      run(["embed", "reindex"]);
      assert.match(run(["doctor"]), /doctor: ok/, "reindex should clear it");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
