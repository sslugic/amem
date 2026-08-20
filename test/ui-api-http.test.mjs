import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withAmemHome, makeGitRepo, root } from "./helpers.mjs";

const UI_APP = readFileSync(join(root, "ui-static", "app.js"), "utf8");
const ROUTES_SRC = readFileSync(join(root, "src", "api", "routes.ts"), "utf8");

/** Paths the local UI actually fetches. Keep in sync with ui-static/app.js. */
const UI_API_CALLS = [
  ["GET", "/api/repos"],
  ["GET", "/api/status"],
  ["GET", "/api/vault"],
  ["GET", "/api/recipe"],
  ["GET", "/api/license"],
  ["GET", "/api/shop"],
  ["POST", "/api/prefs"],
  ["GET", "/api/embed"],
  ["GET", "/api/scan"],
  ["GET", "/api/service"],
  ["GET", "/api/graph"],
  ["GET", "/api/usage"],
  ["GET", "/api/usage/export"],
  ["POST", "/api/workspaces"],
  ["POST", "/api/workspaces/personal"],
  ["POST", "/api/workspaces/rename"],
  ["POST", "/api/track"],
  ["POST", "/api/service"],
  ["POST", "/api/bootstrap"],
  ["POST", "/api/drafts/reject-noisy"],
  ["POST", "/api/drafts/apply"],
  ["POST", "/api/drafts/dismiss"],
  ["POST", "/api/claims/pin"],
  ["PATCH", "/api/claims"],
  ["DELETE", "/api/claims"],
  ["POST", "/api/vault/lock"],
  ["POST", "/api/vault/unlock"],
  ["POST", "/api/vault/backup"],
  ["POST", "/api/vault/backup/schedule"],
  ["POST", "/api/vault/backup/unschedule"],
  ["POST", "/api/vault/restore"],
  ["GET", "/api/hygiene"],
  ["POST", "/api/hygiene/decay"],
  ["POST", "/api/hygiene/merge"],
  ["POST", "/api/rules/sync"],
];

function uiFetchedPaths() {
  return [
    ...UI_APP.matchAll(/["'`](\/api\/[a-z0-9/_-]+)/gi),
  ].map((m) => m[1].replace(/\/$/, ""));
}

function routedPaths() {
  return [...ROUTES_SRC.matchAll(/pathname === "(\/api\/[^"]+)"/g)].map((m) => m[1]);
}

async function jsonReq(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

describe("UI ↔ API contract", () => {
  it("every UI fetch path is registered on handleApi", () => {
    const routed = new Set(routedPaths());
    const fromUi = new Set(uiFetchedPaths());
    for (const path of fromUi) {
      assert.ok(
        routed.has(path) || [...routed].some((r) => path.startsWith(`${r}/`)),
        `ui-static/app.js calls ${path} but src/api/routes.ts has no matching pathname`,
      );
    }
    for (const [, path] of UI_API_CALLS) {
      assert.ok(fromUi.has(path) || path === "/api/health", `test contract lists ${path} but UI never fetches it`);
      assert.ok(routed.has(path), `UI contract path ${path} is missing from handleApi`);
    }
  });
});

describe("vault + header APIs over HTTP", () => {
  it("serves health, lock, backup, unlock, and does not treat vault POSTs as MCP", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo, closeDb } = await import("../dist/db.js");
      const { startUiServer } = await import("../dist/ui/server.js");
      upsertRepo(detectRepoIdentity(repoDir), "cursor");

      const server = await startUiServer({
        port: 0,
        cwd: repoDir,
        openBrowser: false,
      });
      const base = `http://127.0.0.1:${server.port}`;
      try {
        const health = await jsonReq(base, "GET", "/api/health");
        assert.equal(health.status, 200);
        assert.equal(health.data.ok, true);
        assert.ok(health.data.features.includes("vault"));

        const vault = await jsonReq(base, "GET", "/api/vault");
        assert.equal(vault.status, 200);
        assert.equal(vault.data.encryptedAtRest, false);

        const slash = await jsonReq(base, "GET", "/api/vault/");
        assert.equal(slash.status, 200);
        assert.equal(slash.data.encryptedAtRest, false);

        const missingPass = await jsonReq(base, "POST", "/api/vault/lock", {});
        assert.equal(missingPass.status, 400);
        assert.match(String(missingPass.data.error), /passphrase required/i);

        const stolen = await jsonReq(base, "POST", "/api/vault/lock", {
          jsonrpc: "2.0",
          method: "tools/call",
          id: 1,
        });
        assert.equal(stolen.status, 400);
        assert.match(String(stolen.data.error), /passphrase required/i);
        assert.equal(stolen.data.jsonrpc, undefined);

        const backup = await jsonReq(base, "POST", "/api/vault/backup", {
          passphrase: "http-vault-pass",
          label: "http-test",
        });
        assert.equal(backup.status, 200, backup.data.error);
        assert.equal(backup.data.encrypted, true);
        assert.ok(backup.data.path);

        closeDb();
        const locked = await jsonReq(base, "POST", "/api/vault/lock", {
          passphrase: "http-vault-pass",
        });
        assert.equal(locked.status, 200, locked.data.error);
        assert.equal(locked.data.encryptedAtRest, true);

        const unlocked = await jsonReq(base, "POST", "/api/vault/unlock", {
          passphrase: "http-vault-pass",
        });
        assert.equal(unlocked.status, 200, unlocked.data.error);
        assert.equal(unlocked.data.encryptedAtRest, false);

        const license = await jsonReq(base, "GET", "/api/license");
        assert.equal(license.status, 200);
        assert.ok(license.data.tier);

        const shop = await jsonReq(base, "GET", "/api/shop");
        assert.equal(shop.status, 200);
        assert.ok(shop.data.proUrl.includes("/buy/pro"));

        const embed = await jsonReq(base, "GET", "/api/embed");
        assert.equal(embed.status, 200);
        assert.ok(embed.data.backend);

        const recipe = await jsonReq(base, "GET", "/api/recipe");
        assert.equal(recipe.status, 200);
        assert.ok(recipe.data.tools);
      } finally {
        await server.close();
      }
    });
  });

  it("handleApi accepts every UI method+path without Unknown route", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo } = await import("../dist/db.js");
      const { handleApi } = await import("../dist/api/routes.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      const scoped = new URLSearchParams({ repo: repo.id });

      for (const [method, path] of UI_API_CALLS) {
        if (path.startsWith("/api/vault/backup/")) continue;
        const res = handleApi({
          method,
          pathname: path,
          searchParams: scoped,
          body: {},
          cwd: repoDir,
        });
        const message = res.body && typeof res.body === "object" ? res.body.error : "";
        assert.notEqual(
          message,
          `Unknown route ${method} ${path}`,
          `${method} ${path} is not wired`,
        );
      }
    });
  });
});

describe("UI setup stepper + brain defaults", () => {
  it("keeps Memory from going blank and shows setup as steps", () => {
    assert.match(UI_APP, /function emptyGraph/);
    assert.match(UI_APP, /let renderSeq/);
    assert.match(UI_APP, /if \(tab === "brain"\) \{\s*state\.brainAll = true/s);
    assert.match(UI_APP, /const hasTrackedRepo = Boolean\(initialUrl\.get\("repo"\)\)/);
    assert.match(UI_APP, /if \(fromUrl === "all" \|\| !hasTrackedRepo\) return true/);
    assert.match(UI_APP, /if \(!state\.brainAll\) opt\.selected = true/);
    assert.match(UI_APP, /function setupIsComplete/);
    assert.match(UI_APP, /You're set up/);
    assert.match(UI_APP, /data-setup-step/);
    assert.match(UI_APP, /id="editSetup"/);
    assert.match(UI_APP, /function shopBuyCardHtml/);
    assert.match(UI_APP, /Buy Pro/);
    assert.doesNotMatch(UI_APP, /Buy a signed file:/);
    assert.doesNotMatch(UI_APP, /All local repos/);
    assert.doesNotMatch(UI_APP, /This repo/);
    assert.match(UI_APP, /function statsScope/);
    assert.match(UI_APP, /function statsFocusLabel/);
  });
});
