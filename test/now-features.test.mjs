import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withAmemHome, makeGitRepo, root } from "./helpers.mjs";

const cli = join(root, "dist", "cli.js");

describe("remember contract", () => {
  it("requires read-then-write and forbids secrets / uploads", async () => {
    const { rememberContract, rememberContractMustIds, MCP_URL_TEMPLATE } = await import(
      "../dist/remember-contract.js"
    );
    const contract = rememberContract();
    assert.equal(contract.version, "1");
    assert.match(MCP_URL_TEMPLATE, /127\.0\.0\.1:7843\/mcp\?workspace=/);
    assert.ok(contract.tools.some((t) => t.name === "amem_context" && t.role === "read"));
    assert.ok(contract.tools.some((t) => t.name === "amem_remember" && t.role === "write"));
    assert.deepEqual(rememberContractMustIds().sort(), [
      "local-only",
      "no-prompt-strategy",
      "no-secrets",
      "read-first",
      "workspace",
      "write-outcomes",
    ]);
    assert.match(contract.paste, /amem_context/);
    assert.match(contract.paste, /amem_remember/);
    assert.match(contract.paste, /~\/\.amem/);
    assert.match(contract.markdown, /do not fork/i);
  });

  it("docs stay aligned with the contract module", () => {
    const doc = readFileSync(join(root, "docs", "remember-contract.md"), "utf8");
    assert.match(doc, /v1/);
    assert.match(doc, /amem_context/);
    assert.match(doc, /amem_remember/);
    assert.match(doc, /amem_recipe/);
    assert.match(doc, /~\/\.amem/);
  });

  it("GET /api/recipe and MCP amem_recipe return the paste", async () => {
    await withAmemHome(async () => {
      const { handleApi } = await import("../dist/api/routes.js");
      const { dispatchMcp } = await import("../dist/mcp.js");
      const res = handleApi({
        method: "GET",
        pathname: "/api/recipe",
        searchParams: new URLSearchParams(),
        body: null,
        cwd: process.cwd(),
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.version, "1");
      assert.match(res.body.paste, /amem_remember/);

      const listed = dispatchMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const names = (listed.result.tools || []).map((t) => t.name);
      assert.ok(names.includes("amem_recipe"));
      assert.ok(names.includes("amem_remember"));

      const called = dispatchMcp({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "amem_recipe", arguments: {} },
      });
      const text = called.result.content[0].text;
      assert.match(text, /amem_context/);
      assert.match(text, /amem_remember/);
    });
  });
});

describe("vault + personal chrome APIs", () => {
  it("reports vault status, backs up, locks, and unlocks", async () => {
    await withAmemHome(async (home) => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo, closeDb, listRepos } = await import("../dist/db.js");
      const { handleApi } = await import("../dist/api/routes.js");
      const { dbPath } = await import("../dist/paths.js");

      upsertRepo(detectRepoIdentity(repoDir), "cursor");

      const before = handleApi({
        method: "GET",
        pathname: "/api/vault",
        searchParams: new URLSearchParams(),
        body: null,
        cwd: repoDir,
      });
      assert.equal(before.status, 200);
      assert.equal(before.body.encryptedAtRest, false);
      assert.equal(before.body.unlocked, true);

      const backup = handleApi({
        method: "POST",
        pathname: "/api/vault/backup",
        searchParams: new URLSearchParams(),
        body: { passphrase: "vault-test-pass", label: "phase-now" },
        cwd: repoDir,
      });
      assert.equal(backup.status, 200);
      assert.equal(backup.body.encrypted, true);
      assert.ok(existsSync(backup.body.path));
      assert.equal(backup.body.vault.backup.count >= 1, true);

      closeDb();
      const locked = handleApi({
        method: "POST",
        pathname: "/api/vault/lock",
        searchParams: new URLSearchParams(),
        body: { passphrase: "vault-test-pass" },
        cwd: repoDir,
      });
      assert.equal(locked.status, 200);
      assert.equal(locked.body.encryptedAtRest, true);
      assert.equal(existsSync(dbPath()), false);

      const stillVault = handleApi({
        method: "GET",
        pathname: "/api/vault",
        searchParams: new URLSearchParams(),
        body: null,
        cwd: repoDir,
      });
      assert.equal(stillVault.status, 200);
      assert.equal(stillVault.body.encryptedAtRest, true);

      const unlocked = handleApi({
        method: "POST",
        pathname: "/api/vault/unlock",
        searchParams: new URLSearchParams(),
        body: { passphrase: "vault-test-pass" },
        cwd: repoDir,
      });
      assert.equal(unlocked.status, 200);
      assert.equal(unlocked.body.encryptedAtRest, false);
      assert.ok(listRepos().length >= 1);
      void home;
    });
  });

  it("creates the personal workspace from the API", async () => {
    await withAmemHome(async () => {
      const { handleApi } = await import("../dist/api/routes.js");
      const { PERSONAL_SLUG } = await import("../dist/personal.js");
      const created = handleApi({
        method: "POST",
        pathname: "/api/workspaces/personal",
        searchParams: new URLSearchParams(),
        body: { platform: "app" },
        cwd: process.cwd(),
      });
      assert.equal(created.status, 200);
      assert.equal(created.body.workspace, PERSONAL_SLUG);
      assert.equal(created.body.repo.personal, true);
      assert.equal(created.body.repo.slug, PERSONAL_SLUG);
      assert.match(created.body.mcp.url, /workspace=personal/);

      const again = handleApi({
        method: "POST",
        pathname: "/api/workspaces/personal",
        searchParams: new URLSearchParams(),
        body: {},
        cwd: process.cwd(),
      });
      assert.equal(again.body.repo.id, created.body.repo.id);
    });
  });
});

describe("npx / publish readiness", () => {
  it("package files and metadata are pack-ready", async () => {
    const { assertPublishReady, REQUIRED_PACK_PATHS } = await import("../dist/publish.js");
    const info = assertPublishReady(root);
    assert.equal(info.ok, true);
    assert.equal(info.name, "amem");
    assert.ok(info.bin.includes("dist/cli.js"));
    assert.match(info.engines, /20/);
    for (const rel of REQUIRED_PACK_PATHS) {
      assert.ok(existsSync(join(root, rel)), `missing ${rel}`);
    }
    assert.ok(existsSync(join(root, ".github", "workflows", "ci.yml")));
    assert.ok(existsSync(join(root, ".github", "workflows", "release.yml")));
  });
});

describe("CLI recipe", () => {
  it("prints the pasteable host contract", () => {
    const out = execFileSync(process.execPath, [cli, "recipe"], {
      encoding: "utf8",
      env: { ...process.env },
    });
    assert.match(out, /remember contract/);
    assert.match(out, /amem_context/);
    assert.match(out, /amem_remember/);
  });
});
