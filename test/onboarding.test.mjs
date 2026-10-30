import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGitRepo, root, withAmemHome } from "./helpers.mjs";

const cli = join(root, "dist", "cli.js");

describe("first run", () => {
  it("registers the MCP server for Claude Code and Cursor without touching other config", () => {
    const home = mkdtempSync(join(tmpdir(), "amem-onboard-home-"));
    const repoDir = makeGitRepo();
    try {
      writeFileSync(join(home, ".claude.json"), JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }));
      const env = { ...process.env, AMEM_HOME: join(home, ".amem"), HOME: home, USERPROFILE: home };
      delete env.CLAUDE_CONFIG_DIR;
      delete env.CURSOR_HOME;
      const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: repoDir, env, encoding: "utf8" });

      assert.match(run("init", "--platform", "claude"), /MCP server amem added/);
      const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
      assert.equal(claude.theme, "dark");
      assert.equal(claude.mcpServers.other.command, "x");
      assert.deepEqual(claude.mcpServers.amem.args.slice(-1), ["mcp"]);
      // Running it again changes nothing.
      assert.doesNotMatch(run("init", "--platform", "claude"), /MCP server amem/);

      run("init", "--platform", "cursor");
      const cursor = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
      assert.deepEqual(cursor.mcpServers.amem.args.slice(-1), ["mcp"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("leaves a config it cannot parse alone", async () => {
    const { mergeMcpServer } = await import("../dist/install/mcp-register.js");
    const dir = mkdtempSync(join(tmpdir(), "amem-onboard-bad-"));
    const path = join(dir, ".claude.json");
    writeFileSync(path, "{ half written");
    assert.equal(mergeMcpServer(path, { command: "amem" }).status, "skipped");
    assert.equal(readFileSync(path, "utf8"), "{ half written");
    rmSync(dir, { recursive: true, force: true });
  });

  it("seeds an empty repo from its manifests so the first question gets an answer", async () => {
    await withAmemHome(async () => {
      const { upsertRepo, listClaims } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { handleHookPayload } = await import("../dist/hook.js");
      const repoDir = makeGitRepo();
      writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "shop", scripts: { test: "vitest run", lint: "eslint ." } }));
      writeFileSync(join(repoDir, "pnpm-lock.yaml"), "");
      mkdirSync(join(repoDir, ".github", "workflows"), { recursive: true });
      writeFileSync(join(repoDir, ".github", "workflows", "ci.yml"), "name: CI\non: push\n");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");

      const start = handleHookPayload(JSON.stringify({ hook_event_name: "SessionStart", cwd: repoDir, session_id: "s1" }));
      assert.match(start.hookSpecificOutput.additionalContext, /pnpm test \(vitest run\)/);
      const seeded = listClaims(repo.id).length;
      assert.ok(seeded >= 2, `seeded ${seeded}`);

      // Seeding happens once: a repo with memories is never reseeded.
      handleHookPayload(JSON.stringify({ hook_event_name: "SessionStart", cwd: repoDir, session_id: "s2" }));
      assert.equal(listClaims(repo.id).length, seeded);

      // The prompt is answered from the seed, and is not echoed back as a "note".
      const ask = handleHookPayload(
        JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: repoDir, session_id: "s2", prompt: "how do I lint this repo with pnpm" }),
      ).hookSpecificOutput.additionalContext;
      assert.match(ask, /pnpm lint/);
      assert.doesNotMatch(ask, /You asked/);
    });
  });
});
