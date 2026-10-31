import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { makeGitRepo, root } from "./helpers.mjs";

const cli = join(root, "dist", "cli.js");
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function envFor(home, repo) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, AMEM_HOME: join(home, ".amem"), CLAUDE_PROJECT_DIR: repo };
  delete env.AMEM_WORKSPACE;
  delete env.CURSOR_PROJECT_DIR;
  return env;
}

/** amem_remember over MCP stdin; long text on the command line is fragile on some hosts. */
function rememberAll(cwd, env, texts) {
  const input = texts
    .map((text, id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "amem_remember", arguments: { text, kind: "fact", anchors: ["README.md"] } } }))
    .join("\n");
  const out = execFileSync(process.execPath, [cli, "mcp"], { cwd, env, input: `${input}\n`, encoding: "utf8" });
  return out.split("\n").filter(Boolean).map((l) => JSON.parse(l).result);
}

function hook(cwd, env, payload) {
  const out = execFileSync(process.execPath, [cli, "hook"], { cwd, env, input: JSON.stringify({ cwd, session_id: "s1", ...payload }) });
  return JSON.parse(out.toString()).hookSpecificOutput?.additionalContext ?? "";
}

describe("hook context budget", () => {
  it("capBytes counts UTF-8 bytes, keeps the marker inside the budget and never splits a surrogate pair", async () => {
    const { capBytes, HOOK_CONTEXT_MAX_BYTES } = await import("../dist/hook.js");
    const text = "数据库 layer 🚀🚀 uses WAL. ".repeat(400);
    for (const max of [HOOK_CONTEXT_MAX_BYTES, 1001, 1002, 1003, 1004]) {
      const out = capBytes(text, max);
      assert.ok(Buffer.byteLength(out) <= max, `${Buffer.byteLength(out)} > ${max}`);
      assert.ok(out.endsWith("_[amem truncated]_"));
      assert.doesNotMatch(out, LONE_SURROGATE);
    }
    assert.equal(capBytes("short", 2400), "short");
  });

  it("CJK and emoji memories keep both hook events under their byte caps", async () => {
    const { HOOK_CONTEXT_MAX_BYTES, SESSION_START_MAX_BYTES } = await import("../dist/hook.js");
    const home = mkdtempSync(join(tmpdir(), "amem-budget-home-"));
    const repo = makeGitRepo();
    try {
      const env = envFor(home, repo);
      execFileSync(process.execPath, [cli, "init", "--platform", "claude"], { cwd: repo, env, stdio: "ignore" });
      const saved = rememberAll(
        repo,
        env,
        Array.from({ length: 12 }, (_, i) => `Fact ${i}: the 数据库 layer 🚀🚀🚀 ${"層".repeat(300)} is configured in README.md with WAL and busy_timeout.`),
      );
      assert.deepEqual(saved.map((r) => r.isError), Array(12).fill(false));
      const start = hook(repo, env, { hook_event_name: "SessionStart" });
      const prompt = hook(repo, env, { hook_event_name: "UserPromptSubmit", prompt: "how is the 数据库 layer configured with WAL busy_timeout" });
      assert.ok(prompt.length > 0, "the prompt should get context");
      assert.ok(Buffer.byteLength(prompt) <= HOOK_CONTEXT_MAX_BYTES, `prompt: ${Buffer.byteLength(prompt)} bytes`);
      assert.ok(Buffer.byteLength(start) <= SESSION_START_MAX_BYTES, `session start: ${Buffer.byteLength(start)} bytes`);
      for (const ctx of [start, prompt]) assert.doesNotMatch(ctx, LONE_SURROGATE);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects an oversized memory with a clear error", () => {
    const home = mkdtempSync(join(tmpdir(), "amem-long-home-"));
    const repo = makeGitRepo();
    try {
      const env = envFor(home, repo);
      execFileSync(process.execPath, [cli, "init", "--platform", "claude"], { cwd: repo, env, stdio: "ignore" });
      const [result] = rememberAll(repo, env, [`The README.md notes: ${"word ".repeat(600)}`]);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /is \d+ characters; the limit is 2000/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not bind a folder that is not a git checkout, or the home directory", () => {
    const home = mkdtempSync(join(tmpdir(), "amem-bind-home-"));
    const loose = mkdtempSync(join(tmpdir(), "amem-loose-dir-"));
    try {
      const env = envFor(home, loose);
      hook(loose, env, { hook_event_name: "SessionStart" });
      hook(home, { ...env, CLAUDE_PROJECT_DIR: home }, { hook_event_name: "SessionStart" });
      const db = new Database(join(home, ".amem", "graph.db"), { readonly: true });
      const { n } = db.prepare("SELECT COUNT(*) AS n FROM repos").get();
      db.close();
      assert.equal(n, 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(loose, { recursive: true, force: true });
    }
  });
});
