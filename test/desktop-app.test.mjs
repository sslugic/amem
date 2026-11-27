import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAmemHome, makeGitRepo, root } from "./helpers.mjs";

/** HOME (and the config dirs tools honour) pointed at a throwaway folder. */
async function withFakeHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "amem-desktop-"));
  const keys = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "AMEM_SHIM"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  for (const k of ["CODEX_HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "AMEM_SHIM"]) delete process.env[k];
  try {
    return await fn(home);
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

function fakeShim(home) {
  const dir = join(home, ".amem", "bin");
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, process.platform === "win32" ? "amem.cmd" : "amem");
  writeFileSync(shim, "#!/bin/sh\n", { mode: 0o755 });
  return shim;
}

describe("desktop app launcher", () => {
  it("points hooks, MCP and services at the app's launcher when AMEM_SHIM is set", async () => {
    await withFakeHome(async (home) => {
      const shim = fakeShim(home);
      process.env.AMEM_SHIM = shim;
      const { resolveAmemProgramArgs, resolveAmemBin } = await import("../dist/install/skills.js");
      const { stdioMcpLaunch } = await import("../dist/mcp.js");
      assert.deepEqual(resolveAmemProgramArgs("mcp"), [shim, "mcp"]);
      assert.ok(resolveAmemBin().includes(shim));
      const launch = stdioMcpLaunch("personal");
      assert.equal(launch.command, shim);
      assert.deepEqual(launch.args, ["mcp"]);
      assert.equal(launch.env.AMEM_WORKSPACE, "personal");
    });
  });

  it("ignores AMEM_SHIM when the launcher file is gone", async () => {
    await withFakeHome(async (home) => {
      process.env.AMEM_SHIM = join(home, "missing", "amem");
      const { bundledShim, resolveAmemProgramArgs } = await import("../dist/install/skills.js");
      assert.equal(bundledShim(), null);
      assert.notEqual(resolveAmemProgramArgs("mcp")[0], process.env.AMEM_SHIM);
    });
  });

  it("writes Claude Desktop's entry with the launcher, not the shell script that needs Node", async () => {
    await withAmemHome(async () => {
      await withFakeHome(async (home) => {
        const shim = fakeShim(home);
        process.env.AMEM_SHIM = shim;
        const { installHost } = await import("../dist/install/hosts.js");
        const result = installHost("claude-desktop", { workspace: "personal" });
        const entry = JSON.parse(readFileSync(result.paths[0], "utf8")).mcpServers.amem;
        assert.equal(entry.command, shim);
        assert.deepEqual(entry.args, ["mcp"]);
      });
    });
  });
});

describe("AI tool detection", () => {
  it("finds tools by their config folders and reports whether amem is connected", async () => {
    await withAmemHome(async () => {
      await withFakeHome(async (home) => {
        mkdirSync(join(home, ".codex"), { recursive: true });
        mkdirSync(join(home, ".qwen"), { recursive: true });
        const { detectClients } = await import("../dist/detect-clients.js");
        const { installAgent } = await import("../dist/install/agents.js");
        let codex = detectClients().find((c) => c.id === "codex");
        assert.equal(codex.installed, true);
        assert.equal(codex.configured, false);
        assert.equal(codex.autoSetup, true);
        installAgent("codex");
        codex = detectClients().find((c) => c.id === "codex");
        assert.equal(codex.configured, true);
        const list = detectClients();
        const firstMissing = list.findIndex((c) => !c.installed);
        assert.ok(list.slice(firstMissing).every((c) => !c.installed), "installed tools are listed first");
      });
    });
  });
});

describe("guided setup endpoint", () => {
  it("connects machine-wide tools once and binds each project with its instruction files", async () => {
    await withAmemHome(async () => {
      await withFakeHome(async (home) => {
        const repoDir = makeGitRepo("wizard-apply");
        const { handleApi } = await import("../dist/api/routes.js");
        const res = handleApi({
          method: "POST",
          pathname: "/api/setup/apply",
          searchParams: new URLSearchParams(),
          body: { platforms: ["codex", "claude-desktop", "claude"], paths: [repoDir, join(home, "gone")] },
          cwd: home,
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const byLabel = Object.fromEntries(res.body.steps.map((s) => [s.label, s]));
        assert.equal(byLabel["Connect OpenAI Codex"].ok, true);
        assert.equal(byLabel["Connect Claude Desktop"].ok, true);
        assert.match(byLabel["Connect Claude Desktop"].detail, /^~/, "paths are shown relative to home");
        const repoName = repoDir.split(/[\\/]/).pop();
        assert.equal(byLabel[`Add ${repoName}`].ok, true);
        assert.equal(byLabel["Add gone"].ok, false);
        assert.equal(res.body.ok, false, "one failed step makes the run not ok");
        assert.ok(existsSync(join(repoDir, "CLAUDE.md")));
        assert.ok(existsSync(join(repoDir, "AGENTS.md")), "Codex reads AGENTS.md");
        assert.ok(existsSync(join(home, ".codex", "config.toml")));
        const { claudeDesktopConfigPath } = await import("../dist/install/hosts.js");
        const desktop = JSON.parse(readFileSync(claudeDesktopConfigPath(), "utf8")).mcpServers.amem;
        assert.equal(desktop.env.AMEM_WORKSPACE, "personal");
      });
    });
  });

  it("refuses a run with no tools", async () => {
    await withAmemHome(async () => {
      const { handleApi } = await import("../dist/api/routes.js");
      const res = handleApi({
        method: "POST",
        pathname: "/api/setup/apply",
        searchParams: new URLSearchParams(),
        body: { platforms: [], paths: [] },
        cwd: process.cwd(),
      });
      assert.equal(res.status, 400);
    });
  });
});

describe("dashboard wiring", () => {
  it("loads the setup wizard and the desktop bridge", () => {
    const html = readFileSync(join(root, "ui-static", "index.html"), "utf8");
    assert.match(html, /setup-wizard\.css/);
    assert.match(html, /setup-wizard\.js/);
    assert.match(html, /desktop-bridge\.js/);
    for (const f of ["setup-wizard.js", "setup-wizard.css", "desktop-bridge.js"]) {
      assert.ok(existsSync(join(root, "ui-static", f)), f);
    }
  });

  it("keeps the desktop app version in step with amem", () => {
    const amem = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    const app = JSON.parse(readFileSync(join(root, "desktop", "package.json"), "utf8")).version;
    assert.equal(app, amem, "run npm run sync-version --prefix desktop");
  });
});
