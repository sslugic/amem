import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeGitRepo, withAmemHome } from "./helpers.mjs";

async function setup(repoDir) {
  const { upsertRepo, getClaim } = await import("../dist/db.js");
  const { detectRepoIdentity } = await import("../dist/repo-identity.js");
  const { applyProposal } = await import("../dist/proposal.js");
  const { assessClaimFreshness } = await import("../dist/freshness.js");
  const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");
  const remember = (id, anchors) =>
    applyProposal(repo.id, { claims: [{ id, kind: "fact", text: `WAL mode is set in ${anchors[0]} for every connection.`, code_anchors: anchors }] });
  const status = (id) => assessClaimFreshness(repo.root_path, getClaim(repo.id, id)).status;
  return { remember, status };
}

const past = () => new Date(Date.now() - 3600e3);
const future = () => new Date(Date.now() + 3600e3);

describe("freshness by content hash", () => {
  it("a rewrite that keeps the old mtime is stale; a touch with the same bytes stays fresh", async () => {
    const repoDir = makeGitRepo();
    try {
      await withAmemHome(async () => {
        mkdirSync(join(repoDir, "src"), { recursive: true });
        const file = join(repoDir, "src", "db.ts");
        writeFileSync(file, "journal_mode = WAL");
        utimesSync(file, past(), past());
        const { remember, status } = await setup(repoDir);
        remember("claim.wal", ["src/db.ts"]);
        assert.equal(status("claim.wal"), "fresh");

        writeFileSync(file, "journal_mode = WAL");
        utimesSync(file, future(), future());
        assert.equal(status("claim.wal"), "fresh", "touch / git checkout with identical content");

        writeFileSync(file, "journal_mode = DELETE");
        utimesSync(file, past(), past());
        assert.equal(status("claim.wal"), "stale", "cp -p / rsync -a with new content");
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("rejects anchors that leave the repo", async () => {
    const repoDir = makeGitRepo();
    try {
      await withAmemHome(async () => {
        const { remember } = await setup(repoDir);
        assert.throws(() => remember("claim.escape", ["README.md", "../../../../etc/hosts"]), /outside the repo: \.\.\/\.\.\/\.\.\/\.\.\/etc\/hosts/);
        assert.throws(() => remember("claim.abs", ["/etc/hosts"]), /outside the repo: \/etc\/hosts/);
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("any missing anchor makes the claim missing_anchor", async () => {
    const repoDir = makeGitRepo();
    try {
      await withAmemHome(async () => {
        mkdirSync(join(repoDir, "src"), { recursive: true });
        writeFileSync(join(repoDir, "src", "a.ts"), "a");
        writeFileSync(join(repoDir, "src", "b.ts"), "b");
        const { remember, status } = await setup(repoDir);
        remember("claim.two", ["src/a.ts", "src/b.ts"]);
        rmSync(join(repoDir, "src", "b.ts"));
        assert.equal(status("claim.two"), "missing_anchor");
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("one query over many claims looks at each file once", async () => {
    const { assessClaimFreshness, freshnessPass } = await import("../dist/freshness.js");
    const repoDir = makeGitRepo();
    try {
      writeFileSync(join(repoDir, "a.ts"), "a");
      const claims = Array.from({ length: 5000 }, (_, i) => ({
        code_anchors: JSON.stringify(["a.ts", `missing${i}.ts`, "README.md"]),
        anchor_hashes: null,
        updated_at: new Date().toISOString(),
      }));
      const t = performance.now();
      freshnessPass(() => claims.forEach((c) => assessClaimFreshness(repoDir, c)));
      const ms = performance.now() - t;
      assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
