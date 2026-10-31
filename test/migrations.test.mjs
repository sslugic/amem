import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { makeGitRepo, root } from "./helpers.mjs";

const cli = join(root, "dist", "cli.js");

function envFor(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, AMEM_HOME: join(home, ".amem") };
  delete env.AMEM_WORKSPACE;
  return env;
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

describe("schema migrations", () => {
  it("eight processes creating a brand-new database at once all succeed", async () => {
    const home = mkdtempSync(join(tmpdir(), "amem-cold-home-"));
    const repo = makeGitRepo();
    try {
      const env = envFor(home);
      const runs = await Promise.all(
        Array.from({ length: 8 }, () =>
          new Promise((resolve) => {
            const p = spawn(process.execPath, [cli, "init", "--platform", "claude"], { cwd: repo, env });
            let err = "";
            p.stderr.on("data", (d) => (err += d));
            p.on("close", (code) => resolve({ code, err }));
          }),
        ),
      );
      assert.deepEqual(runs.map((r) => r.code), Array(8).fill(0), runs.map((r) => r.err).join("\n"));
      const db = new Database(join(home, ".amem", "graph.db"), { readonly: true });
      assert.ok(db.pragma("user_version", { simple: true }) >= 1);
      db.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("upgrades a database from before the version ladder and keeps its data", () => {
    const home = mkdtempSync(join(tmpdir(), "amem-upgrade-home-"));
    const repo = makeGitRepo();
    try {
      const env = envFor(home);
      const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: "utf8" });
      run("init", "--platform", "claude");
      run("remember", "The upgrade test fact lives in src/db.ts and must survive the migration.");

      // Make it look like an old install: no version, and later columns missing.
      const path = join(home, ".amem", "graph.db");
      let db = new Database(path);
      for (const col of ["anchors_json", "anchor_tokens", "attested_at"]) db.exec(`ALTER TABLE usage_events DROP COLUMN ${col}`);
      db.exec("ALTER TABLE claims DROP COLUMN pinned");
      db.pragma("user_version = 0");
      db.close();

      run("status");

      db = new Database(path, { readonly: true });
      assert.ok(db.pragma("user_version", { simple: true }) >= 1);
      for (const col of ["anchors_json", "anchor_tokens", "attested_at"]) assert.ok(columns(db, "usage_events").includes(col), col);
      assert.ok(columns(db, "claims").includes("pinned"));
      const { n } = db.prepare("SELECT COUNT(*) AS n FROM claims WHERE text LIKE 'The upgrade test fact%'").get();
      db.close();
      assert.equal(n, 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
