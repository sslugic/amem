/**
 * The plugin pack (plugins/amem, plugins/amem-desktop, the marketplaces and the Gemini
 * extension) is generated from the package. These guard that it stays in sync and that
 * every manifest points at files that exist.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./helpers.mjs";

const json = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const version = json("package.json").version;

describe("plugin pack", () => {
  it("is up to date with the package (run `npm run plugins` after a version bump)", () => {
    execFileSync(process.execPath, [join(root, "scripts", "sync-plugins.mjs"), "--check"], { stdio: "pipe" });
  });

  it("carries the package version in every manifest", () => {
    for (const p of [
      "plugins/amem/plugin.json",
      "plugins/amem/.claude-plugin/plugin.json",
      "plugins/amem/.cursor-plugin/plugin.json",
      "plugins/amem-desktop/manifest.json",
      "gemini-extension.json",
    ]) {
      assert.equal(json(p).version, version, p);
    }
    assert.equal(json(".claude-plugin/marketplace.json").plugins[0].version, version);
  });

  it("points every manifest and marketplace at files that exist", () => {
    const P = "plugins/amem";
    const cursor = json(`${P}/.cursor-plugin/plugin.json`);
    for (const ref of [cursor.rules, cursor.skills, cursor.mcpServers, cursor.hooks, cursor.logo]) {
      assert.ok(existsSync(join(root, P, ref)), `cursor manifest -> ${ref}`);
    }
    assert.ok(existsSync(join(root, json(".claude-plugin/marketplace.json").plugins[0].source)));
    assert.ok(existsSync(join(root, json(".agents/plugins/marketplace.json").plugins[0].source.path)));
    assert.ok(existsSync(join(root, json("gemini-extension.json").contextFileName)));
    const desktop = json("plugins/amem-desktop/manifest.json");
    assert.ok(existsSync(join(root, "plugins/amem-desktop", desktop.server.entry_point)));
    assert.ok(existsSync(join(root, "plugins/amem-desktop", desktop.icon)));
  });

  it("starts amem the same way everywhere: npx for MCP, installed amem first for hooks", () => {
    const P = "plugins/amem";
    for (const cfg of [json(`${P}/.mcp.json`), json(`${P}/mcp.json`), json("gemini-extension.json")]) {
      assert.deepEqual(cfg.mcpServers.amem.args.slice(-2), ["@iamem/amem@latest", "mcp"]);
    }
    assert.equal(json(`${P}/mcp.json`).mcpServers.amem.type, "stdio");
    const hooks = json(`${P}/hooks/hooks.json`).hooks;
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      assert.match(hooks[ev][0].hooks[0].command, /command -v amem.*exec amem hook.*npx -y @iamem\/amem@latest hook/);
    }
  });

  it("ships a dependency-free Claude Desktop launcher", () => {
    const src = readFileSync(join(root, "plugins/amem-desktop/server/launcher.cjs"), "utf8");
    execFileSync(process.execPath, ["--check", join(root, "plugins/amem-desktop/server/launcher.cjs")]);
    const requires = [...src.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.ok(requires.every((r) => r.startsWith("node:")), `only node: builtins, got ${requires}`);
  });

  it("keeps the plugin pack out of the npm package", () => {
    assert.ok(!json("package.json").files.some((f) => f.startsWith("plugins")));
  });
});
