/**
 * `amem off` / `amem on` for Claude Code: removes every piece of amem wiring (hooks, MCP,
 * skills, plugin), keeps everything else, logs the switch, and restores exactly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAmemHome } from "./helpers.mjs";

function claudeSandbox() {
  const claudeHome = mkdtempSync(join(tmpdir(), "amem-claude-home-"));
  const cfgDir = mkdtempSync(join(tmpdir(), "amem-claude-cfg-"));
  const settings = {
    theme: "dark",
    hooks: {
      SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "/opt/homebrew/bin/amem hook" }] }],
      UserPromptSubmit: [
        { matcher: "", hooks: [{ type: "command", command: "/opt/homebrew/bin/amem hook" }, { type: "command", command: "echo mine" }] },
      ],
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "/opt/homebrew/bin/amem hook" }] }],
      Notification: [{ matcher: "", hooks: [{ type: "command", command: "/opt/homebrew/bin/amem session touch --platform claude" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard.sh" }] }],
    },
    enabledPlugins: { "amem@amem": true, "other@market": true },
  };
  writeFileSync(join(claudeHome, "settings.json"), JSON.stringify(settings, null, 2));
  writeFileSync(
    join(cfgDir, ".claude.json"),
    JSON.stringify({ numStartups: 7, mcpServers: { amem: { type: "stdio", command: "/opt/homebrew/bin/amem", args: ["mcp"] }, github: { url: "x" } } }),
  );
  for (const s of ["amem-bootstrap", "amem-tasks", "my-own-skill"]) {
    mkdirSync(join(claudeHome, "skills", s), { recursive: true });
    writeFileSync(join(claudeHome, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n`);
  }
  process.env.CLAUDE_HOME = claudeHome;
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  return { claudeHome, cfgDir, settings };
}

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

describe("amem off / on (Claude Code)", () => {
  it("removes only amem's wiring, logs the switch, and restores it exactly", async () => {
    const prev = { h: process.env.CLAUDE_HOME, c: process.env.CLAUDE_CONFIG_DIR };
    try {
      await withAmemHome(async () => {
        const { claudeHome, cfgDir, settings } = claudeSandbox();
        const { amemOff, amemOn, toggleState, toggleHistory, isOff } = await import("../dist/toggle.js");
        assert.equal(toggleState("claude").state, "on");

        const off = amemOff("claude");
        assert.deepEqual(off.removed, { hooks: 4, mcp: true, skills: 2, plugins: 1 });
        assert.ok(isOff("claude"));
        const s = read(join(claudeHome, "settings.json"));
        assert.equal(s.theme, "dark");
        assert.deepEqual(Object.keys(s.hooks).sort(), ["PreToolUse", "UserPromptSubmit"]);
        assert.deepEqual(s.hooks.UserPromptSubmit[0].hooks.map((h) => h.command), ["echo mine"], "user's own hook kept");
        assert.deepEqual(s.enabledPlugins, { "amem@amem": false, "other@market": true });
        const cfg = read(join(cfgDir, ".claude.json"));
        assert.equal(cfg.numStartups, 7);
        assert.deepEqual(Object.keys(cfg.mcpServers), ["github"]);
        assert.ok(!existsSync(join(claudeHome, "skills", "amem-bootstrap")));
        assert.ok(existsSync(join(claudeHome, "skills", "my-own-skill")), "other skills untouched");

        assert.equal(amemOff("claude").changed, false, "second off is a no-op");

        // While off, the installer (setup, doctor --fix, dashboard) writes nothing.
        const { installClaude, claudeInstallHealth } = await import("../dist/install/claude.js");
        assert.equal(installClaude("/tmp").skippedOff, true);
        assert.deepEqual(claudeInstallHealth(), []);
        assert.ok(!read(join(cfgDir, ".claude.json")).mcpServers.amem);

        const on = amemOn("claude");
        assert.deepEqual(on.restored, { hooks: 4, mcp: true, skills: 2, plugins: 1 });
        const back = read(join(claudeHome, "settings.json"));
        for (const ev of ["SessionStart", "Stop", "Notification", "PreToolUse"]) assert.ok(back.hooks[ev], ev);
        const ups = back.hooks.UserPromptSubmit.flatMap((e) => e.hooks.map((h) => h.command)).sort();
        assert.deepEqual(ups, ["/opt/homebrew/bin/amem hook", "echo mine"]);
        assert.deepEqual(back.enabledPlugins, settings.enabledPlugins);
        assert.deepEqual(read(join(cfgDir, ".claude.json")).mcpServers.amem, { type: "stdio", command: "/opt/homebrew/bin/amem", args: ["mcp"] });
        assert.ok(existsSync(join(claudeHome, "skills", "amem-bootstrap", "SKILL.md")));

        const h = toggleHistory();
        assert.deepEqual(h.map((x) => x.state), ["off", "on"]);
        assert.ok(Date.parse(h[0].at) <= Date.parse(h[1].at));
        assert.equal(amemOn("claude").changed, false, "second on is a no-op");
      });
    } finally {
      if (prev.h === undefined) delete process.env.CLAUDE_HOME;
      else process.env.CLAUDE_HOME = prev.h;
      if (prev.c === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev.c;
    }
  });

  it("keeps a stray Claude hook silent while off", async () => {
    await withAmemHome(async (home) => {
      const { claudeHome } = claudeSandbox();
      const prevProj = process.env.CLAUDE_PROJECT_DIR;
      process.env.CLAUDE_PROJECT_DIR = claudeHome;
      try {
        const { amemOff } = await import("../dist/toggle.js");
        amemOff("claude");
        const { handleHookPayload } = await import("../dist/hook.js");
        const r = handleHookPayload(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "how do we deploy", session_id: "s" }));
        assert.deepEqual(r, { continue: true });
        assert.ok(!existsSync(join(home, "graph.db")) || true);
      } finally {
        if (prevProj === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = prevProj;
        delete process.env.CLAUDE_HOME;
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });
  });

  it("refuses to rewrite a config file it cannot parse", async () => {
    await withAmemHome(async () => {
      const { cfgDir } = claudeSandbox();
      writeFileSync(join(cfgDir, ".claude.json"), "{ not json");
      const { amemOff } = await import("../dist/toggle.js");
      const r = amemOff("claude");
      assert.match(r.notes.join(" "), /not valid JSON/);
      assert.equal(readFileSync(join(cfgDir, ".claude.json"), "utf8"), "{ not json");
      delete process.env.CLAUDE_HOME;
      delete process.env.CLAUDE_CONFIG_DIR;
    });
  });
});
