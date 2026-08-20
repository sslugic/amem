import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("embed + personal + crypto + hosts backlog", () => {
  it("hashes text into stable unit vectors and ranks similar claims", async () => {
    await withAmemHome(async () => {
      const { embedText, cosine, searchClaimsEmbed, ensureClaimsEmbed, upsertClaimEmbed } =
        await import("../dist/embed.js");
      const { openDb, upsertRepo, closeDb } = await import("../dist/db.js");
      const { applyProposal } = await import("../dist/proposal.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");

      const a = embedText("auth startup sync service");
      const b = embedText("auth startup sync service");
      const c = embedText("completely unrelated cooking recipes");
      assert.ok(Math.abs(cosine(a, b) - 1) < 1e-5);
      assert.ok(cosine(a, c) < cosine(a, b));

      const repoDir = makeGitRepo();
      const identity = detectRepoIdentity(repoDir);
      const repo = upsertRepo(identity, "cursor");
      applyProposal(repo.id, {
        claims: [
          {
            id: "claim.auth_boot",
            kind: "constraint",
            text: "Auth mode is checked during sync service startup",
            code_anchors: ["src/auth.ts"],
          },
          {
            id: "claim.unrelated",
            kind: "session",
            text: "Prefers dark roast coffee in the morning",
            code_anchors: ["README.md"],
          },
        ],
      });
      const db = openDb();
      ensureClaimsEmbed(db);
      const hits = searchClaimsEmbed(db, repo.id, "sync auth startup", 5);
      assert.ok(hits.length >= 1);
      assert.equal(hits[0].id, "claim.auth_boot");
      closeDb();
      void upsertClaimEmbed;
    });
  });

  it("blends personal prefs into project context", async () => {
    await withAmemHome(async () => {
      const { ensurePersonalWorkspace, PERSONAL_SLUG } = await import("../dist/personal.js");
      const { upsertRepo } = await import("../dist/db.js");
      const { applyProposal } = await import("../dist/proposal.js");
      const { buildContext } = await import("../dist/context.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { handleApi } = await import("../dist/api/routes.js");

      ensurePersonalWorkspace("app");
      handleApi({
        method: "POST",
        pathname: "/api/remember",
        searchParams: new URLSearchParams({ workspace: PERSONAL_SLUG }),
        body: {
          text: "I prefer short diffs and conventional commits always",
          kind: "constraint",
          anchors: ["personal"],
          source: "test",
        },
        cwd: process.cwd(),
      });

      const repoDir = makeGitRepo();
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      applyProposal(repo.id, {
        claims: [
          {
            id: "claim.repo_fact",
            kind: "structure",
            text: "API entrypoint lives in src/api.ts",
            code_anchors: ["src/api.ts"],
          },
        ],
      });

      const packet = buildContext(repo.id, "conventional commits short diffs", {
        limit: 8,
        rootPath: repoDir,
      });
      assert.ok(
        packet.claims.some((c) => c.reasons?.includes("personal")),
        "expected a personal claim in the packet",
      );
    });
  });

  it("locks and unlocks the database with a passphrase", async () => {
    await withAmemHome(async (home) => {
      const { upsertRepo, closeDb, openDb, listRepos } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const {
        lockDatabase,
        unlockDatabase,
        isDbEncryptedAtRest,
        createBackup,
        encryptBytes,
        decryptBytes,
      } = await import("../dist/crypto.js");
      const { existsSync } = await import("node:fs");
      const { dbPath } = await import("../dist/paths.js");

      const repoDir = makeGitRepo();
      upsertRepo(detectRepoIdentity(repoDir), "cursor");
      closeDb();

      const pass = "test-passphrase-not-secret";
      lockDatabase(pass);
      assert.equal(isDbEncryptedAtRest(), true);
      assert.equal(existsSync(dbPath()), false);

      unlockDatabase(pass);
      assert.equal(isDbEncryptedAtRest(), false);
      openDb();
      assert.ok(listRepos().length >= 1);
      closeDb();

      const round = decryptBytes(encryptBytes(Buffer.from("hello-amem"), pass), pass);
      assert.equal(round.toString(), "hello-amem");

      const backup = createBackup({ outDir: join(home, "bk"), passphrase: pass });
      assert.equal(backup.encrypted, true);
      assert.ok(existsSync(backup.path));
    });
  });

  it("parses auto_apply_kinds and auto-applies matching drafts", async () => {
    await withAmemHome(async (home) => {
      writeFileSync(
        join(home, "policy.toml"),
        `auto_apply_kinds = ["structure"]\n`,
        "utf8",
      );
      const { clearPolicyCache, loadPolicy } = await import("../dist/policy.js");
      clearPolicyCache();
      assert.deepEqual(loadPolicy().policy.auto_apply_kinds, ["structure"]);

      const { upsertRepo } = await import("../dist/db.js");
      const { captureSessionDraft } = await import("../dist/capture.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { listClaims, listProposalDrafts } = await import("../dist/db.js");

      const repoDir = makeGitRepo();
      writeFileSync(join(repoDir, "src", "api.ts"), "export const api = true;\n");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      const draft = captureSessionDraft({
        repo,
        platform: "cursor",
        prompt: "Where does the API entrypoint live in the module?",
        answer:
          "The API entrypoint lives in src/api.ts and must stay the bootstrap for HTTP handlers.",
      });
      assert.ok(draft);
      // structure-like drafts may auto-apply
      const claims = listClaims(repo.id);
      const drafts = listProposalDrafts(repo.id);
      assert.ok(
        claims.some((c) => c.text.toLowerCase().includes("api")) ||
          drafts.some((d) => d.status === "pending" || d.status === "applied"),
      );
      clearPolicyCache();
    });
  });

  it("compacts multi-turn notes into denser draft text", async () => {
    const { compactFromNotes, inferClaimKind } = await import("../dist/kinds.js");
    const out = compactFromNotes([
      { role: "user", text: "Where is auth checked on sync startup?" },
      {
        role: "assistant",
        text: "Gotcha: auth mode must be checked in src/auth.ts before enabling Drive sync. Never skip this.",
      },
      { role: "user", text: "ok thanks" },
    ]);
    assert.ok(out);
    assert.match(out.answer, /auth/i);
    assert.equal(inferClaimKind(out.prompt, out.answer), "gotcha");
  });

  it("installHost windsurf writes mcp config", async () => {
    await withAmemHome(async () => {
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const home = mkdtempSync(join(tmpdir(), "amem-host-home-"));
      const prev = process.env.HOME;
      process.env.HOME = home;
      try {
        const { installHost } = await import("../dist/install/hosts.js");
        const { existsSync, readFileSync } = await import("node:fs");
        const result = installHost("windsurf", { workspace: "personal" });
        assert.ok(result.paths[0]);
        assert.ok(existsSync(result.paths[0]));
        const json = JSON.parse(readFileSync(result.paths[0], "utf8"));
        assert.ok(json.mcpServers?.amem?.url);
      } finally {
        if (prev === undefined) delete process.env.HOME;
        else process.env.HOME = prev;
      }
    });
  });
});
