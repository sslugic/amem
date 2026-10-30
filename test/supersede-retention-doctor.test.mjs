import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("supersede outdated memories", () => {
  it("remember can supersede, and lists older look-alikes", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("supersede");
      const { upsertRepo, listClaims } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { handleApi } = await import("../dist/api/routes.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");
      const remember = (body) =>
        handleApi({ method: "POST", pathname: "/api/remember", searchParams: new URLSearchParams({ repo: repo.id }), body, cwd: repoDir }).body;

      const old = remember({ text: "Billing retry rollout status: backend merged, staging config still pending review", kind: "project" });
      const newer = remember({ text: "Billing retry rollout status: backend merged, staging config applied and live today", kind: "project" });
      assert.equal(newer.possiblySupersedes[0]?.id, old.claimId, "flags the older look-alike");
      assert.match(newer.hint, /amem_supersede/);

      const third = remember({ text: "Billing retry rollout finished: live in production", kind: "project", supersedes: [old.claimId, newer.claimId] });
      assert.deepEqual(third.superseded.sort(), [old.claimId, newer.claimId].sort());
      const active = listClaims(repo.id).map((c) => c.id);
      assert.ok(!active.includes(old.claimId) && !active.includes(newer.claimId));
      assert.ok(active.includes(third.claimId));
    });
  });

  it("supersede API retires claims and reports unknown ids", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("supersede-api");
      const { upsertRepo, listClaims } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { handleApi } = await import("../dist/api/routes.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");
      const call = (pathname, body) => handleApi({ method: "POST", pathname, searchParams: new URLSearchParams({ repo: repo.id }), body, cwd: repoDir });
      const a = call("/api/remember", { text: "Do not run the purge yet: it deletes good facts by mistake", kind: "gotcha" }).body;
      const res = call("/api/supersede", { ids: [a.claimId, "claim.nope"] });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.superseded, [a.claimId]);
      assert.deepEqual(res.body.notFound, ["claim.nope"]);
      assert.ok(!listClaims(repo.id).some((c) => c.id === a.claimId));
      assert.equal(call("/api/supersede", {}).status, 400);
    });
  });
});

describe("backup retention", () => {
  it("keeps newest per day (14d), per month (12m), last 3, and 5 pre-restore copies", async () => {
    const { backupsToPrune } = await import("../dist/crypto.js");
    const now = Date.parse("2026-10-23T12:00:00Z");
    const day = 86_400_000;
    const files = [];
    // three backups a day for 40 days
    for (let d = 0; d < 40; d += 1) for (let h = 0; h < 3; h += 1) files.push({ name: `amem-d${d}-h${h}.db`, mtimeMs: now - d * day - h * 3_600_000 });
    for (let i = 0; i < 8; i += 1) files.push({ name: `pre-restore-${i}.db`, mtimeMs: now - i * day });
    const drop = new Set(backupsToPrune(files, { keepDays: 14, keepMonths: 12, keepRecent: 3, keepPreRestore: 5 }, now));
    const kept = files.filter((f) => !drop.has(f.name)).map((f) => f.name);
    for (let d = 0; d <= 13; d += 1) assert.ok(kept.includes(`amem-d${d}-h0.db`), `newest of day ${d}`);
    assert.ok(kept.includes("amem-d0-h1.db") && kept.includes("amem-d0-h2.db"), "last 3 overall");
    assert.ok(!kept.includes("amem-d5-h1.db"), "older same-day copies pruned");
    assert.equal(kept.filter((n) => n.startsWith("pre-restore-")).length, 5);
    assert.ok(kept.length < 30, `pruned down to ${kept.length}`);
  });

  it("pruneBackups deletes only what the policy drops", async () => {
    await withAmemHome(async (home) => {
      const { pruneBackups } = await import("../dist/crypto.js");
      const dir = join(home, "backups");
      mkdirSync(dir, { recursive: true });
      const now = Date.now() / 1000;
      for (let i = 0; i < 6; i += 1) {
        const p = join(dir, `amem-same-day-${i}.db`);
        writeFileSync(p, "x".repeat(32));
        utimesSync(p, now - i * 60, now - i * 60);
      }
      const { removed, bytesFreed } = pruneBackups(dir, { keepDays: 14, keepMonths: 12, keepRecent: 3, keepPreRestore: 5 });
      assert.equal(removed.length, 3);
      assert.equal(bytesFreed, 96);
      assert.equal(readdirSync(dir).length, 3);
    });
  });
});

describe("doctor install check", () => {
  it("flags two installs and a host on another version", { skip: process.platform === "win32" && "npm bin layout and symlinks differ on Windows" }, async () => {
    const { installIssues } = await import("../dist/install-check.js");
    const base = mkdtempSync(join(tmpdir(), "amem-installs-"));
    const mkPkg = (prefix, version) => {
      const root = join(base, prefix, "lib", "node_modules", "@iamem", "amem");
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@iamem/amem", version }));
      writeFileSync(join(root, "dist", "cli.js"), "");
      mkdirSync(join(base, prefix, "bin"), { recursive: true });
      symlinkSync(join(root, "dist", "cli.js"), join(base, prefix, "bin", "amem"));
      return root;
    };
    mkPkg("a", "0.3.7");
    const oldRoot = mkPkg("b", "0.2.0");
    const home = join(base, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: `${join(base, "b", "bin", "amem")} hook` }] }] } }),
    );
    const issues = installIssues({ env: { PATH: `${join(base, "a", "bin")}${delimiter}${join(base, "b", "bin")}` }, home, prefixes: [] });
    assert.ok(issues.some((i) => /More than one amem install/.test(i)), issues.join("\n"));
    assert.ok(issues.some((i) => i.includes("Stop hook runs amem 0.2.0") && i.includes(oldRoot)), issues.join("\n"));
    assert.deepEqual(installIssues({ env: { PATH: join(base, "a", "bin") }, home: join(base, "nohome"), prefixes: [] }), []);
  });
});
