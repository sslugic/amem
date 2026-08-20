import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("repo-identity helpers", () => {
  it("normalizes ssh/https remotes to a shared key form", async () => {
    const { normalizeRemoteUrl, slugifyWorkspace, parseWorkspaceSlug, workspaceIdentity, newId } =
      await import("../dist/repo-identity.js");
    assert.equal(
      normalizeRemoteUrl("git@github.com:Org/Repo.git"),
      "https://github.com/org/repo",
    );
    assert.equal(
      normalizeRemoteUrl("https://user:token@github.com/Org/Repo.git/"),
      "https://github.com/org/repo",
    );
    assert.equal(
      normalizeRemoteUrl("https://github.com/Org/Repo.git/"),
      normalizeRemoteUrl("git@github.com:Org/Repo.git"),
    );
    assert.equal(slugifyWorkspace("My Cool App!"), "my-cool-app");
    assert.throws(() => slugifyWorkspace("!!!"), /letters or numbers/);
    const id = workspaceIdentity("luna", "/tmp/luna-root");
    assert.equal(parseWorkspaceSlug(id.remoteUrl), "luna");
    assert.match(newId("claim"), /^claim_/);
  });
});

describe("platforms", () => {
  it("normalizes known platforms and exposes host installers", async () => {
    const { normalizePlatforms, isKnownPlatform, HOST_INSTALL_IDS, KNOWN_PLATFORMS } =
      await import("../dist/platforms.js");
    assert.equal(isKnownPlatform("cursor"), true);
    assert.equal(isKnownPlatform("nope"), false);
    assert.deepEqual(normalizePlatforms(["Cursor", "cursor", "zed", "bogus", 1]), [
      "cursor",
      "zed",
    ]);
    assert.ok(HOST_INSTALL_IDS.has("windsurf"));
    assert.ok(HOST_INSTALL_IDS.has("continue"));
    assert.ok(HOST_INSTALL_IDS.has("aider"));
    assert.ok(HOST_INSTALL_IDS.has("zed"));
    assert.ok(KNOWN_PLATFORMS.length >= 8);
  });
});

describe("policy loading + asserts", () => {
  it("parses toml, merges env overlay, and hard-stops telemetry/ui_bind", async () => {
    await withAmemHome(async (home) => {
      const { parsePolicyToml, clearPolicyCache, loadPolicy, assertPlatformAllowed, assertExportAllowed, assertUiAllowed, assertRemoteAllowed, telemetryEnabled } =
        await import("../dist/policy.js");

      const partial = parsePolicyToml(`
telemetry = true
ui_enabled = true
ui_bind = "0.0.0.0"
allow_export = false
allowed_platforms = ["cursor"]
allowed_remote_hosts = ["github.com/acme"]
deny_claim_patterns = ["customer[_-]?ssn"]
auto_apply_kinds = ["structure", "howto"]
`);
      assert.equal(partial.telemetry, true);
      assert.deepEqual(partial.auto_apply_kinds, ["structure", "howto"]);

      writeFileSync(join(home, "policy.toml"), `allow_export = true\nallowed_platforms = ["cursor", "claude"]\n`, "utf8");
      const envPath = join(home, "env-policy.toml");
      writeFileSync(
        envPath,
        `allow_export = false\nui_bind = "10.0.0.1"\ntelemetry = true\nauto_apply_kinds = ["gotcha"]\nallowed_platforms = ["cursor"]\nallowed_remote_hosts = ["github.com/acme"]\n`,
        "utf8",
      );
      const prev = process.env.AMEM_POLICY_PATH;
      process.env.AMEM_POLICY_PATH = envPath;
      try {
        clearPolicyCache();
        const loaded = loadPolicy(true);
        assert.equal(loaded.policy.allow_export, false);
        assert.equal(loaded.policy.ui_bind, "127.0.0.1");
        assert.equal(loaded.policy.telemetry, false);
        assert.deepEqual(loaded.policy.auto_apply_kinds, ["gotcha"]);
        assert.equal(telemetryEnabled(loaded.policy), false);
        assert.throws(() => assertExportAllowed(loaded.policy), /export/i);
        assert.doesNotThrow(() => assertUiAllowed(loaded.policy));
        assert.throws(() => assertPlatformAllowed("windsurf", loaded.policy), /blocked/i);
        assert.throws(
          () => assertRemoteAllowed("https://gitlab.com/other/repo", loaded.policy),
          /remote/i,
        );
      } finally {
        if (prev === undefined) delete process.env.AMEM_POLICY_PATH;
        else process.env.AMEM_POLICY_PATH = prev;
        clearPolicyCache();
      }
    });
  });

  it("rejects invalid policy toml keys and arrays", async () => {
    const { parsePolicyToml } = await import("../dist/policy.js");
    assert.throws(() => parsePolicyToml(`unknown = true\n`), /Unknown policy key/);
    assert.throws(() => parsePolicyToml(`allow_export = maybe\n`), /true or false/);
    assert.throws(() => parsePolicyToml(`allowed_platforms = [nope]\n`), /string array|quoted/);
  });
});

describe("crypto edge cases", () => {
  it("rejects wrong passphrase and refuses openDb while locked without env", async () => {
    await withAmemHome(async () => {
      const { upsertRepo, closeDb, openDb, listRepos } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const {
        lockDatabase,
        unlockDatabase,
        isDbEncryptedAtRest,
        encryptBytes,
        decryptBytes,
        resolvePassphrase,
        fingerprintPassphrase,
      } = await import("../dist/crypto.js");

      const repoDir = makeGitRepo();
      try {
        upsertRepo(detectRepoIdentity(repoDir), "cursor");
        closeDb();
        lockDatabase("correct-secret");
        assert.equal(isDbEncryptedAtRest(), true);
        assert.throws(() => decryptBytes(encryptBytes(Buffer.from("x"), "a"), "b"));
        assert.throws(() => unlockDatabase("wrong-secret"));
        assert.equal(isDbEncryptedAtRest(), true);

        const prev = process.env.AMEM_PASSPHRASE;
        delete process.env.AMEM_PASSPHRASE;
        try {
          assert.throws(() => openDb(), /encrypted at rest|Passphrase required/i);
        } finally {
          if (prev === undefined) delete process.env.AMEM_PASSPHRASE;
          else process.env.AMEM_PASSPHRASE = prev;
        }

        unlockDatabase("correct-secret");
        openDb();
        assert.ok(listRepos().length >= 1);
        closeDb();
        assert.equal(fingerprintPassphrase("abc").length, 12);
        assert.throws(() => resolvePassphrase(""), /Passphrase required/);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  it("createBackup copies encrypted blob and plaintext when asked", async () => {
    await withAmemHome(async (home) => {
      const { upsertRepo, closeDb } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { createBackup, lockDatabase, unlockDatabase } = await import("../dist/crypto.js");
      const repoDir = makeGitRepo();
      try {
        upsertRepo(detectRepoIdentity(repoDir), "cursor");
        closeDb();
        const plain = createBackup({ outDir: join(home, "b1"), label: "plain" });
        assert.equal(plain.encrypted, false);
        assert.ok(existsSync(plain.path));

        const enc = createBackup({
          outDir: join(home, "b2"),
          passphrase: "pw",
          label: "enc",
        });
        assert.equal(enc.encrypted, true);

        lockDatabase("pw");
        const lockedCopy = createBackup({ outDir: join(home, "b3") });
        assert.equal(lockedCopy.encrypted, true);
        unlockDatabase("pw");
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});

describe("backup schedule", () => {
  it("installs and uninstalls linux systemd timer + helper script", async () => {
    await withAmemHome(async (home) => {
      if (process.platform !== "linux") return;
      const {
        installBackupSchedule,
        uninstallBackupSchedule,
        isBackupScheduleInstalled,
        writeBackupHelperScript,
        backupSystemdTimerPath,
        backupSystemdServicePath,
      } = await import("../dist/backup-schedule.js");

      const out = join(home, "scheduled-backups");
      const result = installBackupSchedule({ outDir: out, hour: 4 });
      assert.equal(result.platform, "linux");
      assert.ok(existsSync(backupSystemdTimerPath()));
      assert.ok(existsSync(backupSystemdServicePath()));
      assert.equal(isBackupScheduleInstalled(), true);
      const body = readFileSync(backupSystemdTimerPath(), "utf8");
      assert.match(body, /04:15:00/);
      const helper = writeBackupHelperScript(out);
      assert.ok(existsSync(helper));
      assert.match(readFileSync(helper, "utf8"), /amem backup|--out/);
      uninstallBackupSchedule();
      assert.equal(isBackupScheduleInstalled(), false);
    });
  });
});

describe("host installers", () => {
  it("writes continue, aider, and zed configs", async () => {
    await withAmemHome(async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "amem-host-home-"));
      const prevHome = process.env.HOME;
      const prevXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome;
      process.env.XDG_CONFIG_HOME = join(fakeHome, ".config");
      try {
        const { installHost } = await import("../dist/install/hosts.js");
        const cont = installHost("continue", { workspace: "personal" });
        assert.ok(existsSync(cont.paths[0]));
        const contJson = JSON.parse(readFileSync(cont.paths[0], "utf8"));
        assert.ok(
          (contJson.experimental?.modelContextProtocolServers || []).some(
            (s) => s.name === "amem",
          ),
        );

        const repo = makeGitRepo();
        try {
          const aider = installHost("aider", { repoRoot: repo });
          assert.ok(existsSync(aider.paths[0]));
          assert.match(readFileSync(aider.paths[0], "utf8"), /amem context/);
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }

        const zed = installHost("zed", { workspace: "luna" });
        assert.ok(existsSync(zed.paths[0]));
        const zedJson = JSON.parse(readFileSync(zed.paths[0], "utf8"));
        assert.ok(zedJson.context_servers?.amem);
        assert.throws(() => installHost("nope"), /No thin installer/);
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });
  });
});

describe("hook pipeline", () => {
  it("normalizes Claude/Cursor event names", async () => {
    const { normalizeHookEvent } = await import("../dist/hook.js");
    assert.equal(normalizeHookEvent("UserPromptSubmit"), "beforeSubmitPrompt");
    assert.equal(normalizeHookEvent("Stop"), "stop");
    assert.equal(normalizeHookEvent("SessionStart"), "sessionStart");
    assert.equal(normalizeHookEvent("SessionEnd"), "sessionEnd");
    assert.equal(normalizeHookEvent("afterAgentResponse"), "afterAgentResponse");
  });

  it("sessionStart / prompt / response / stop flow stores notes and drafts", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo, listConversationNotes, listProposalDrafts } =
          await import("../dist/db.js");
        const { applyProposal } = await import("../dist/proposal.js");
        const { handleHookPayload } = await import("../dist/hook.js");

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        applyProposal(repo.id, {
          claims: [
            {
              id: "claim.seed",
              kind: "constraint",
              text: "Auth mode is checked during sync service startup",
              code_anchors: ["src/auth.ts"],
            },
          ],
        });

        const start = handleHookPayload(
          JSON.stringify({
            hook_event_name: "SessionStart",
            cwd: repoDir,
            session_id: "s1",
          }),
        );
        assert.equal(start.continue, true);
        assert.ok(typeof start.additional_context === "string");
        assert.match(start.additional_context, /amem local memory|Auth mode/i);

        const prompt = handleHookPayload(
          JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            cwd: repoDir,
            session_id: "s1",
            prompt: "How does auth startup work with the sync service?",
          }),
        );
        assert.ok(prompt.additional_context);

        handleHookPayload(
          JSON.stringify({
            hook_event_name: "afterAgentResponse",
            cwd: repoDir,
            session_id: "s1",
            text: "Auth mode must be checked in src/auth.ts before enabling Drive sync. Never skip this guard.",
          }),
        );
        const notes = listConversationNotes(repo.id, 20);
        assert.ok(notes.some((n) => n.role === "user"));
        assert.ok(notes.some((n) => n.role === "assistant"));

        handleHookPayload(
          JSON.stringify({
            hook_event_name: "Stop",
            cwd: repoDir,
            session_id: "s1",
          }),
        );
        const drafts = listProposalDrafts(repo.id);
        assert.ok(drafts.length >= 1);

        const bad = handleHookPayload("not-json");
        assert.deepEqual(bad, { continue: true });
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});

describe("MCP dispatch", () => {
  it("lists tools and runs context/remember/repos", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo } = await import("../dist/db.js");
        const { applyProposal } = await import("../dist/proposal.js");
        const { dispatchMcp, mcpClientConfig, isJsonRpcMessage } = await import("../dist/mcp.js");

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        applyProposal(repo.id, {
          claims: [
            {
              id: "claim.mcp",
              kind: "structure",
              text: "API entrypoint lives in src/api.ts",
              code_anchors: ["src/api.ts"],
            },
          ],
        });

        assert.equal(isJsonRpcMessage({ jsonrpc: "2.0", method: "x", id: 1 }), true);
        assert.equal(isJsonRpcMessage({ foo: 1 }), false);

        const init = dispatchMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        assert.ok(init?.result);

        const tools = dispatchMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        const names = (tools?.result?.tools || []).map((t) => t.name);
        assert.ok(names.includes("amem_context"));
        assert.ok(names.includes("amem_remember"));

        // MCP tools use cwd resolution — chdir into the repo
        const prev = process.cwd();
        process.chdir(repoDir);
        try {
          const ctx = dispatchMcp({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "amem_context", arguments: { query: "API entrypoint" } },
          });
          assert.ok(ctx?.result);
          const text = JSON.stringify(ctx.result);
          assert.match(text, /API entrypoint|src\/api\.ts/i);

          const rem = dispatchMcp({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: {
              name: "amem_remember",
              arguments: {
                text: "Prefer conventional commits in this repo",
                kind: "constraint",
                anchors: ["README.md"],
              },
            },
          });
          assert.ok(rem?.result);
          assert.equal(rem.error, undefined);

          const repos = dispatchMcp({
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: { name: "amem_repos", arguments: {} },
          });
          assert.ok(repos?.result);
        } finally {
          process.chdir(prev);
        }

        const cfg = mcpClientConfig("personal", 7843);
        assert.match(cfg.http.url, /7843/);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});

describe("personal workspace", () => {
  it("creates personal prefs and recognizes the repo", async () => {
    await withAmemHome(async () => {
      const {
        ensurePersonalWorkspace,
        isPersonalRepo,
        listPersonalClaims,
        PERSONAL_SLUG,
      } = await import("../dist/personal.js");
      const repo = ensurePersonalWorkspace("app");
      assert.equal(isPersonalRepo(repo), true);
      assert.ok(listPersonalClaims().some((c) => c.id === "claim.personal_scope"));
      const again = ensurePersonalWorkspace("app");
      assert.equal(again.id, repo.id);
      assert.equal(PERSONAL_SLUG, "personal");
    });
  });
});

describe("capture guards", () => {
  it("rejects trivial and secret-like text; extracts real anchors", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { isUsefulCaptureText, extractCaptureAnchors, captureSessionDraft } =
          await import("../dist/capture.js");
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo, listProposalDrafts } = await import("../dist/db.js");

        assert.equal(isUsefulCaptureText("ok"), false);
        assert.equal(isUsefulCaptureText("api_key = sk_live_xxx"), false);
        assert.equal(isUsefulCaptureText("Please explain the boot order carefully"), true);

        const anchors = extractCaptureAnchors("see src/api.ts and missing/nope.ts", repoDir);
        assert.deepEqual(anchors, ["src/api.ts"]);

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        const none = captureSessionDraft({
          repo,
          platform: "cursor",
          prompt: "thanks",
          answer: "sure",
        });
        assert.equal(none, null);
        assert.equal(listProposalDrafts(repo.id).length, 0);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});

describe("wipe clears search indexes", () => {
  it("removes FTS and embed rows when wiping a repo", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo, wipeRepo, openDb } = await import("../dist/db.js");
        const { applyProposal } = await import("../dist/proposal.js");
        const { searchClaimsFts } = await import("../dist/search.js");
        const { searchClaimsEmbed } = await import("../dist/embed.js");

        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
        applyProposal(repo.id, {
          claims: [
            {
              id: "claim.wipe_me",
              kind: "constraint",
              text: "Wipe target claim about unique_xyzzy_token boot",
              code_anchors: ["src/api.ts"],
            },
          ],
        });
        const db = openDb();
        assert.ok(searchClaimsFts(db, repo.id, "unique_xyzzy_token", 5).length >= 1);
        assert.ok(searchClaimsEmbed(db, repo.id, "unique_xyzzy_token boot", 5).length >= 1);
        wipeRepo(repo.id);
        assert.equal(searchClaimsFts(db, repo.id, "unique_xyzzy_token", 5).length, 0);
        assert.equal(searchClaimsEmbed(db, repo.id, "unique_xyzzy_token boot", 5).length, 0);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});

describe("attest + UI helpers", () => {
  it("builds an attest report and formats it", async () => {
    await withAmemHome(async () => {
      const { buildAttestReport, formatAttestHuman } = await import("../dist/attest.js");
      const report = buildAttestReport(process.cwd());
      assert.equal(typeof report.ok, "boolean");
      assert.ok(Array.isArray(report.issues));
      assert.equal(report.privacy.telemetry, false);
      assert.equal(report.privacy.network_egress, "none");
      const human = formatAttestHuman(report);
      assert.match(human, /amem attest/i);
    });
  });

  it("detects EADDRINUSE and builds landing URLs", async () => {
    const { isAddrInUse, buildUiLandingUrl } = await import("../dist/ui/server.js");
    assert.equal(isAddrInUse({ code: "EADDRINUSE" }), true);
    assert.equal(isAddrInUse(new Error("nope")), false);
    const url = buildUiLandingUrl(7843, "/tmp/project");
    assert.match(url, /^http:\/\/127\.0\.0\.1:7843/);
    assert.match(url, /tab=setup/);
    assert.match(url, /path=/);
  });
});

describe("workspace provision + rename", () => {
  it("seeds starter facts and renames without changing slug", async () => {
    await withAmemHome(async () => {
      const { workspaceIdentity, parseWorkspaceSlug } = await import("../dist/repo-identity.js");
      const { upsertRepo, renameWorkspace, listClaims, getRepoByName } = await import(
        "../dist/db.js"
      );
      const { provisionWorkspace } = await import("../dist/workspace-setup.js");
      const { amemHome } = await import("../dist/paths.js");

      const root = join(amemHome(), "workspaces", "luna");
      mkdirSync(root, { recursive: true });
      const identity = workspaceIdentity("luna", root);
      const repo = upsertRepo(identity, "luna");
      const ready = provisionWorkspace(repo, "luna");
      assert.ok(ready.checks.length >= 1);
      assert.ok(listClaims(repo.id).length >= 1);

      const renamed = renameWorkspace(repo.id, "Luna Client");
      assert.equal(renamed.repo_name, "Luna Client");
      assert.equal(parseWorkspaceSlug(renamed.remote_url), "luna");
      assert.ok(getRepoByName("luna"));
    });
  });
});

describe("API workspaces + status", () => {
  it("creates a workspace via API and returns status", async () => {
    await withAmemHome(async () => {
      const { handleApi } = await import("../dist/api/routes.js");
      const created = handleApi({
        method: "POST",
        pathname: "/api/workspaces",
        searchParams: new URLSearchParams(),
        body: { name: "demo-app", platform: "app" },
        cwd: process.cwd(),
      });
      assert.equal(created.status, 200);
      assert.ok(created.body.workspace || created.body.repo);

      const status = handleApi({
        method: "GET",
        pathname: "/api/status",
        searchParams: new URLSearchParams({ workspace: "demo-app" }),
        body: null,
        cwd: process.cwd(),
      });
      assert.equal(status.status, 200);
      assert.ok(status.body.repo || status.body.amemHome);
    });
  });
});

describe("embed vector codec", () => {
  it("round-trips vectors through blob encoding", async () => {
    const { embedText, vectorToBlob, blobToVector, cosine, EMBED_DIM } =
      await import("../dist/embed.js");
    const v = embedText("hello world vectors");
    assert.equal(v.length, EMBED_DIM);
    const back = blobToVector(vectorToBlob(v));
    assert.ok(Math.abs(cosine(v, back) - 1) < 1e-5);
    assert.equal(embedText("").every((x) => x === 0), true);
  });
});
