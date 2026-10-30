import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGitRepo, root } from "./helpers.mjs";

const cli = join(root, "dist", "cli.js");

describe("uninstall and doctor --fix", () => {
  it("removes only what amem added, and doctor --fix puts it back", () => {
    const home = mkdtempSync(join(tmpdir(), "amem-uninstall-home-"));
    const repoDir = makeGitRepo();
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "say done" }] }] } }),
      );
      writeFileSync(join(home, ".claude.json"), JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }));
      writeFileSync(join(repoDir, "CLAUDE.md"), "# My notes\n\nKeep this.\n");
      const env = { ...process.env, AMEM_HOME: join(home, ".amem"), HOME: home, USERPROFILE: home };
      delete env.CLAUDE_CONFIG_DIR;
      delete env.CLAUDE_HOME;
      const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: repoDir, env, encoding: "utf8" });

      run("init", "--platform", "claude");
      assert.match(readFileSync(join(repoDir, "CLAUDE.md"), "utf8"), /BEGIN amem/);

      // Dry run by default: nothing changes.
      assert.match(run("uninstall"), /would remove: Claude Code MCP server/);
      assert.ok(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.amem);

      run("uninstall", "--yes");
      const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
      assert.deepEqual(Object.keys(settings.hooks), ["Stop"]);
      assert.equal(settings.hooks.Stop[0].hooks[0].command, "say done");
      const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
      assert.equal(claude.theme, "dark");
      assert.deepEqual(Object.keys(claude.mcpServers), ["other"]);
      assert.equal(readFileSync(join(repoDir, "CLAUDE.md"), "utf8"), "# My notes\n\nKeep this.\n");
      assert.ok(!existsSync(join(home, ".claude", "skills", "amem-bootstrap")));
      assert.ok(existsSync(join(home, ".amem")), "memory is kept without --purge");
      assert.match(run("uninstall"), /Nothing to remove/);

      // The repo is still bound, so doctor --fix knows the host and rewires it.
      assert.match(run("doctor", "--fix"), /fixed: MCP server added/);
      assert.ok(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.amem);
      assert.match(readFileSync(join(repoDir, "CLAUDE.md"), "utf8"), /Keep this\.[\s\S]*BEGIN amem/);

      run("uninstall", "--yes", "--purge");
      assert.ok(!existsSync(join(home, ".amem")));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
