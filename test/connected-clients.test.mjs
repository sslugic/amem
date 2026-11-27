import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idleClients, scanClients } from "../dist/connected-clients.js";

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "amem-clients-"));
  const apps = join(home, "Apps");
  const put = (rel, body) => {
    const p = join(home, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  };
  // Connected
  put(".gemini/settings.json", { mcpServers: { amem: { command: "amem", env: { SECRET_TOKEN: "s3cr3t-value" } } } });
  put(".cursor/mcp.json", { mcpServers: { amem: { url: "http://127.0.0.1:7843/mcp" } } });
  put(".codeium/windsurf/mcp_config.json", { mcpServers: { amem: { serverUrl: "http://127.0.0.1:7843/mcp" } } });
  // Present but not wired to amem
  put(".gemini/antigravity-ide/mcp_config.json", { mcpServers: { unityMCP: { command: "unity" } } });
  mkdirSync(join(home, ".gemini/antigravity/mcp/amem"), { recursive: true });
  put("Library/Application Support/Claude/claude_desktop_config.json", { mcpServers: { other: {} } });
  put(".codex/notes.txt", "no config.toml here");
  for (const a of ["Perplexity.app", "Warp.app", "Gemini.app", "Claude.app", "Cursor.app"]) mkdirSync(join(apps, a), { recursive: true });
  return { home, apps };
}

describe("connected clients", () => {
  it("finds clients with an amem entry and nothing else", () => {
    const { home, apps } = fakeHome();
    const scan = scanClients({ home, platform: "darwin", appDirs: [apps], env: {} });
    assert.deepEqual(scan.connected.map((c) => c.id).sort(), ["cursor", "gemini", "windsurf"]);
    assert.deepEqual(scan.connected.find((c) => c.id === "gemini").via, ["mcp"]);
  });

  it("lists installed-but-unwired apps with a next step, never ones already connected", () => {
    const { home, apps } = fakeHome();
    const { detected } = scanClients({ home, platform: "darwin", appDirs: [apps], env: {} });
    const byId = Object.fromEntries(detected.map((d) => [d.id, d.nextStep]));
    assert.match(byId["claude-desktop"], /amem setup --platform claude-desktop/);
    assert.match(byId.perplexity, /Connectors/);
    assert.match(byId.warp, /Connectors/);
    assert.ok(byId.antigravity, "antigravity folder without an amem entry is detected, not connected");
    assert.ok(byId.codex, "codex folder without config.toml is detected");
    assert.equal(byId.cursor, undefined, "Cursor.app is already connected");
  });

  it("links each app to its setup guide section and lists MCP-less apps as unsupported", () => {
    const { home, apps } = fakeHome();
    const { detected, unsupported } = scanClients({ home, platform: "darwin", appDirs: [apps], env: {} });
    const guide = Object.fromEntries(detected.map((d) => [d.id, d.guide]));
    const base = "https://github.com/sslugic/amem/blob/main/docs/CLIENTS.md#";
    assert.equal(guide["claude-desktop"], `${base}one-command-setup`);
    assert.equal(guide.perplexity, `${base}perplexity-mac-app`);
    assert.equal(guide.warp, `${base}warp`);
    assert.equal(guide.antigravity, `${base}google-antigravity`);
    assert.equal(guide.codex, `${base}openai-codex-cli-ide-extension-and-app`);
    assert.equal(guide["gemini-app"], undefined, "Gemini app is not offered as connectable");
    assert.deepEqual(unsupported.map((u) => [u.id, u.instead]), [["gemini-app", "Not supported: use Gemini CLI"]]);
    assert.equal(unsupported[0].guide, `${base}apps-that-cant-use-amem-yet`);
  });

  it("every guide anchor exists in docs/CLIENTS.md", () => {
    const md = readFileSync(new URL("../docs/CLIENTS.md", import.meta.url), "utf8");
    const slug = (h) => h.trim().toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-");
    const anchors = new Set(md.split("\n").filter((l) => /^#{1,3} /.test(l)).map((l) => slug(l.replace(/^#+ /, ""))));
    const src = readFileSync(new URL("../src/connected-clients.ts", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("const GUIDE_ANCHORS"), src.indexOf("export function clientGuide"));
    for (const [, a] of block.matchAll(/: "([a-z0-9-]+)"/g)) assert.ok(anchors.has(a), `#${a} in docs/CLIENTS.md`);
  });

  it("never returns config values", () => {
    const { home, apps } = fakeHome();
    const out = JSON.stringify(scanClients({ home, platform: "darwin", appDirs: [apps], env: {} }));
    assert.doesNotMatch(out, /s3cr3t|SECRET_TOKEN|7843|unity/i);
  });

  it("reads Codex TOML and Claude Code hooks", () => {
    const { home } = fakeHome();
    writeFileSync(join(home, ".codex/config.toml"), '[mcp_servers.amem]\ncommand = "amem"\n');
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "/opt/homebrew/bin/amem hook stop" }] }] } }));
    const ids = scanClients({ home, platform: "linux", env: {} }).connected.map((c) => c.id);
    assert.ok(ids.includes("codex"));
    assert.ok(ids.includes("claude-code"));
  });

  it("an app that has called amem is not idle, matching its activity name", () => {
    const { home, apps } = fakeHome();
    const scan = scanClients({ home, platform: "darwin", appDirs: [apps], env: {} });
    assert.deepEqual(idleClients(scan, ["claude-code", "gemini-cli-mcp-client"]).map((c) => c.id).sort(), ["cursor", "windsurf"]);
    assert.deepEqual(idleClients(scan, ["cursor", "gemini", "windsurf"]), []);
  });

  it("the Activity page renders both groups", () => {
    const js = readFileSync(new URL("../ui-static/activity.js", import.meta.url), "utf8");
    assert.match(js, /\/api\/activity\/clients/);
    assert.match(js, /Connected · no calls yet/);
    assert.match(js, /Shows up after its agent first calls amem\./);
    assert.match(js, /Detected, not connected/);
    assert.match(js, /Can't use amem yet/);
    const app = readFileSync(new URL("../ui-static/app.js", import.meta.url), "utf8");
    assert.match(app, /docs\/CLIENTS\.md" target="_blank" rel="noopener">setup guide for every app/);
  });
});

describe("/api/activity/clients", () => {
  it("is served", async () => {
    const { withAmemHome } = await import("./helpers.mjs");
    await withAmemHome(async () => {
      const { handleApi } = await import("../dist/api/routes.js");
      const res = handleApi({ method: "GET", pathname: "/api/activity/clients", searchParams: new URLSearchParams(), body: null, cwd: process.cwd() });
      assert.equal(res.status, 200);
      for (const k of ["connected", "idle", "detected", "unsupported", "active"]) assert.ok(Array.isArray(res.body[k]), k);
      assert.match(res.body.guide, /docs\/CLIENTS\.md$/);
    });
  });
});
