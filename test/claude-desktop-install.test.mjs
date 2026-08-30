import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute, dirname } from "node:path";
import { withAmemHome } from "./helpers.mjs";

/** Run fn with HOME pointed at a throwaway dir. */
async function withFakeHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "amem-claude-desktop-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

describe("claude desktop host install", () => {
  it("writes an absolute stdio command, never a bare one", async () => {
    await withAmemHome(async () => {
      await withFakeHome(async () => {
        const { installHost } = await import("../dist/install/hosts.js");
        const result = installHost("claude-desktop", { workspace: "personal" });
        const path = result.paths[0];
        assert.ok(existsSync(path), "config file written");
        const json = JSON.parse(readFileSync(path, "utf8"));
        const entry = json.mcpServers?.amem;
        assert.ok(entry, "amem server entry present");
        // The whole point: GUI hosts have no login PATH, so a bare command fails.
        assert.ok(isAbsolute(entry.command), `command must be absolute, got ${entry.command}`);
        assert.notEqual(entry.command, "amem");
        assert.notEqual(entry.command, "node");
        assert.equal(entry.env.AMEM_WORKSPACE, "personal");
      });
    });
  });

  it("merges into existing config instead of clobbering other servers", async () => {
    await withAmemHome(async () => {
      await withFakeHome(async () => {
        const { claudeDesktopConfigPath, installHost } = await import("../dist/install/hosts.js");
        const path = claudeDesktopConfigPath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          JSON.stringify({ mcpServers: { other: { command: "/bin/true" } }, theme: "dark" }),
          "utf8",
        );
        installHost("claude-desktop", { workspace: "personal" });
        const json = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(json.mcpServers.other.command, "/bin/true", "unrelated server preserved");
        assert.equal(json.theme, "dark", "unrelated top-level keys preserved");
        assert.ok(json.mcpServers.amem, "amem added alongside");
      });
    });
  });

  it("health check flags a missing entry and clears once installed", async () => {
    await withAmemHome(async () => {
      await withFakeHome(async () => {
        const { hostInstallHealth, installHost } = await import("../dist/install/hosts.js");
        assert.equal(hostInstallHealth("claude-desktop").length, 1, "missing entry reported");
        installHost("claude-desktop", { workspace: "personal" });
        assert.deepEqual(hostInstallHealth("claude-desktop"), [], "clean after install");
      });
    });
  });

  it("is a known platform with a host installer", async () => {
    const { isKnownPlatform, HOST_INSTALL_IDS } = await import("../dist/platforms.js");
    assert.ok(isKnownPlatform("claude-desktop"));
    assert.ok(HOST_INSTALL_IDS.has("claude-desktop"));
  });

  it("recipe offers stdio and stops forbidding it outright", async () => {
    const { rememberContract } = await import("../dist/remember-contract.js");
    const { paste, markdown } = rememberContract();
    assert.match(paste, /stdio/i, "paste mentions the stdio transport");
    assert.match(paste, /claude-desktop/, "paste names the installer");
    assert.doesNotMatch(
      paste,
      /Do not use a bare amem command from GUI apps\./,
      "old blanket ban removed",
    );
    assert.match(markdown, /amem init --platform claude-desktop/);
    // HTTP must still be documented — this is an addition, not a replacement.
    assert.match(markdown, /127\.0\.0\.1:7843/);
  });
});

describe("placeholder anchor freshness", () => {
  it("a claim anchored only to the README placeholder is unanchored, not stale", async () => {
    const { assessClaimFreshness, PLACEHOLDER_ANCHOR } = await import("../dist/freshness.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "amem-anchor-"));
    // README written now, claim written long ago: the old rule called this stale.
    writeFileSync(join(root, PLACEHOLDER_ANCHOR), "# changed\n", "utf8");
    const claim = {
      code_anchors: JSON.stringify([PLACEHOLDER_ANCHOR]),
      updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    const out = assessClaimFreshness(root, claim);
    assert.equal(out.status, "unanchored");
    assert.deepEqual(out.staleAnchors, []);
  });

  it("a real anchor still goes stale when its file changes", async () => {
    const { assessClaimFreshness } = await import("../dist/freshness.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "amem-anchor-real-"));
    writeFileSync(join(root, "thing.ts"), "export const a = 1;\n", "utf8");
    const claim = {
      code_anchors: JSON.stringify(["thing.ts", "README.md"]),
      updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    const out = assessClaimFreshness(root, claim);
    assert.equal(out.status, "stale", "real anchors still drive staleness");
    assert.deepEqual(out.staleAnchors, ["thing.ts"]);
  });
});
