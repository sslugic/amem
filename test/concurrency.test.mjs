import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { makeGitRepo, root } from "./helpers.mjs";

const cli = join(root, "dist", "cli.js");

function runMcp(cwd, env, lines) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, "mcp"], { cwd, env });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    for (const line of lines) p.stdin.write(`${line}\n`);
    p.stdin.end();
    p.on("close", (code) => resolve({ code, err, msgs: out.split("\n").filter(Boolean).map((l) => JSON.parse(l)) }));
  });
}

const remember = (id, text) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "amem_remember", arguments: { text, kind: "fact" } } });

describe("concurrent MCP servers", () => {
  it("eight servers writing to one AMEM_HOME all stay up and every write lands", async () => {
    const home = mkdtempSync(join(tmpdir(), "amem-race-home-"));
    const repo = makeGitRepo();
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home, AMEM_HOME: join(home, ".amem") };
      delete env.AMEM_WORKSPACE;
      execFileSync(process.execPath, [cli, "init", "--platform", "claude"], { cwd: repo, env, stdio: "ignore" });

      const N = 8;
      const PER = 30;
      const runs = await Promise.all(
        Array.from({ length: N }, (_, w) =>
          runMcp(
            repo,
            env,
            Array.from({ length: PER }, (_, i) => remember(i, `Worker ${w} fact ${i}: concurrency check for src/db.ts writes under WAL mode.`)),
          ),
        ),
      );
      assert.deepEqual(runs.map((r) => r.code), Array(N).fill(0), runs.map((r) => r.err).join("\n"));
      const failed = runs.flatMap((r) => r.msgs.filter((m) => m.error || m.result?.isError));
      assert.deepEqual(failed, []);
      assert.equal(runs.reduce((n, r) => n + r.msgs.length, 0), N * PER);

      const db = new Database(join(home, ".amem", "graph.db"), { readonly: true });
      const { n } = db.prepare("SELECT COUNT(*) AS n FROM claims WHERE text LIKE 'Worker %'").get();
      db.close();
      assert.equal(n, N * PER);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("answers malformed JSON with -32700 and keeps serving", async () => {
    const home = mkdtempSync(join(tmpdir(), "amem-parse-home-"));
    const repo = makeGitRepo();
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home, AMEM_HOME: join(home, ".amem") };
      const { code, msgs } = await runMcp(repo, env, [
        "{this is not json",
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      ]);
      assert.equal(code, 0);
      assert.deepEqual(msgs[0], { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      assert.deepEqual(msgs[1], { jsonrpc: "2.0", id: 1, result: {} });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
