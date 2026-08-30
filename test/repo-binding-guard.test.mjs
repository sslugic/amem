import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { homedir } from "node:os";
import { parse as parsePath, join } from "node:path";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("unbindableRootReason", () => {
  it("refuses the home directory and the filesystem root", async () => {
    const { unbindableRootReason } = await import("../dist/repo-identity.js");
    // The exact shape that registered "/Users/<user>" as a repo: an init run
    // from a home directory, where detectRepoIdentity falls back to cwd.
    assert.equal(unbindableRootReason(homedir()), "your home directory");
    assert.equal(unbindableRootReason(parsePath(process.cwd()).root), "the filesystem root");
  });

  it("allows an ordinary project directory", async () => {
    const { unbindableRootReason } = await import("../dist/repo-identity.js");
    assert.equal(unbindableRootReason(process.cwd()), null);
    assert.equal(unbindableRootReason(join(homedir(), "projects", "thing")), null);
  });

  it("still allows deliberate workspace roots under the amem home", async () => {
    const { unbindableRootReason, workspaceIdentity } = await import("../dist/repo-identity.js");
    const identity = workspaceIdentity("personal", join(homedir(), ".amem", "workspaces", "personal"));
    assert.equal(unbindableRootReason(identity.rootPath), null);
  });
});

describe("machine-global host installers", () => {
  it("write config without binding the current directory", async () => {
    const { installHost } = await import("../dist/install/hosts.js");
    const home = mkdtempSync(join(tmpdir(), "amem-noBind-"));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      // installHost must be usable with no repoRoot at all — that is what lets
      // `amem init --platform claude-desktop` skip the cwd binding entirely.
      const result = installHost("claude-desktop", { workspace: "personal" });
      assert.ok(existsSync(result.paths[0]));
      const json = JSON.parse(readFileSync(result.paths[0], "utf8"));
      assert.equal(json.mcpServers.amem.env.AMEM_WORKSPACE, "personal");
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    }
  });
});
