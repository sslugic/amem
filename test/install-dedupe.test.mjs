import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDedupe, autoFixInstalls, autoFixInstallsEnabled, planDedupe, prefixOf } from "../dist/install-dedupe.js";

/** A fake machine: two global prefixes with amem, host configs pointing at both. */
function machine({ aVersion = "0.13.0", bVersion = "0.13.0" } = {}) {
  // Real path: macOS tmp is a /var -> /private/var symlink and installs resolve to real paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "amem-dedupe-")));
  const home = join(root, "home");
  const mk = (prefix, version) => {
    const pkg = join(prefix, "lib", "node_modules", "@iamem", "amem");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@iamem/amem", version }));
    writeFileSync(join(pkg, "dist", "cli.js"), "#!/usr/bin/env node\n");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    symlinkSync("../lib/node_modules/@iamem/amem/dist/cli.js", join(prefix, "bin", "amem"));
    return { prefix, pkg, bin: join(prefix, "bin", "amem") };
  };
  const a = mk(join(root, "local"), aVersion); // like ~/.local
  const b = mk(join(root, "brew"), bVersion); // like /opt/homebrew
  const put = (rel, text, mode = 0o600) => {
    const p = join(home, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
    chmodSync(p, mode);
    return p;
  };
  const claude = put(".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: `${b.bin} hook stop` }] }], SessionStart: [{ hooks: [{ command: `${b.bin} hook start` }] }] }, apiKey: "sk-secret-keep" }));
  const gemini = put(".gemini/settings.json", JSON.stringify({ mcpServers: { amem: { command: b.bin } } }));
  const cursor = put(".cursor/hooks.json", JSON.stringify({ hooks: { stop: [{ command: `${a.bin} hook stop` }] } }));
  const codex = put(".codex/config.toml", `[mcp_servers.amem]\ncommand = "${a.pkg}/scripts/mcp-launch.sh"\n`);
  const env = { PATH: [join(a.prefix, "bin"), join(b.prefix, "bin")].join(":") };
  const runs = [];
  const run = (cmd, args) => runs.push([cmd, ...args]);
  return { root, home, a, b, env, run, runs, files: { claude, gemini, cursor, codex }, deps: { home, env, prefixes: [a.prefix, b.prefix], platform: "linux", run, current: null } };
}

describe("duplicate installs", () => {
  it("finds the prefix of a global install", () => {
    assert.equal(prefixOf("/opt/homebrew/lib/node_modules/@iamem/amem"), "/opt/homebrew");
    assert.equal(prefixOf("/Users/me/GitHub/amem"), null);
  });

  it("keeps the install most hosts use when versions match", () => {
    const m = machine();
    const plan = planDedupe(m.deps);
    assert.equal(plan.keep.root.endsWith(join("brew", "lib", "node_modules", "@iamem", "amem")), true);
    assert.deepEqual(plan.rewrites.map((r) => r.path).sort(), [m.files.codex, m.files.cursor].sort());
  });

  it("keeps the newest version first", () => {
    const m = machine({ aVersion: "0.14.0" });
    assert.ok(planDedupe(m.deps).keep.root.includes(join("local", "lib")));
  });

  it("repoints configs, keeps their permissions and other values, and removes the extra install", () => {
    const m = machine();
    const r = applyDedupe(planDedupe(m.deps), m.deps);
    assert.deepEqual(r.errors, []);
    assert.equal(readFileSync(m.files.cursor, "utf8").includes(m.a.bin), false);
    assert.equal(readFileSync(m.files.cursor, "utf8").includes(m.b.bin), true);
    assert.equal(readFileSync(m.files.codex, "utf8").includes(`${m.b.pkg}/scripts/mcp-launch.sh`), true);
    assert.equal(statSync(m.files.cursor).mode & 0o777, 0o600);
    assert.equal(statSync(`${m.files.cursor}.amem-bak`).mode & 0o777, 0o600);
    assert.match(readFileSync(m.files.claude, "utf8"), /sk-secret-keep/, "untouched file keeps its contents");
    assert.equal(existsSync(`${m.files.claude}.amem-bak`), false, "files that needed no change are not touched");
    // The fake npm call is recorded; the fallback then removes the package and its bin link.
    assert.deepEqual(m.runs[0].slice(1), ["uninstall", "-g", "--prefix", m.a.prefix, "@iamem/amem"]);
    assert.equal(existsSync(m.a.pkg), false);
    assert.equal(existsSync(m.a.bin), false);
    assert.equal(existsSync(m.b.pkg), true);
    assert.equal(planDedupe(m.deps), null, "nothing left to fix");
  });

  it("never removes the install it is running from", () => {
    const m = machine({ aVersion: "0.12.0" });
    const plan = planDedupe(m.deps);
    const r = applyDedupe(plan, { ...m.deps, current: plan.remove[0].root });
    assert.equal(existsSync(m.a.pkg), true);
    assert.match(r.errors.join(" "), /running from it/);
  });

  it("auto-fix runs only from the install it keeps, and can be turned off", () => {
    const m = machine();
    const keep = planDedupe(m.deps).keep.root;
    assert.equal(autoFixInstalls({ ...m.deps, current: m.a.pkg }), null, "running from the one it would remove: leave it");
    assert.equal(autoFixInstalls({ ...m.deps, env: { ...m.env, AMEM_AUTOFIX_INSTALLS: "0" }, current: keep }), null);
    assert.equal(autoFixInstallsEnabled({ AMEM_AUTOFIX_INSTALLS: "off" }), false);
    assert.equal(autoFixInstallsEnabled({}), true);
    const r = autoFixInstalls({ ...m.deps, current: keep });
    assert.deepEqual(r.errors, []);
    assert.equal(existsSync(m.a.pkg), false);
  });
});
