import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

/** Run fn with HOME (and the config dirs agents honour) pointed at a throwaway dir. */
async function withFakeHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "amem-agents-"));
  const keys = ["HOME", "USERPROFILE", "CODEX_HOME", "XDG_CONFIG_HOME"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CODEX_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    return await fn(home);
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe("command-line agent installers", () => {
  it("marks Codex, Gemini CLI, Qwen Code and OpenCode as installable", async () => {
    const { KNOWN_PLATFORMS, usesGenericMcp } = await import("../dist/platforms.js");
    for (const id of ["codex", "gemini", "qwen", "opencode"]) {
      assert.equal(KNOWN_PLATFORMS.find((p) => p.id === id)?.installs, "agent", id);
      assert.equal(usesGenericMcp(id), false, id);
    }
  });

  it("adds amem to Codex config.toml without touching other tables, and replaces its own", async () => {
    await withFakeHome(async (home) => {
      const { installAgent, codexConfigPath } = await import("../dist/install/agents.js");
      const path = codexConfigPath();
      assert.equal(path, join(home, ".codex", "config.toml"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        [
          'model = "gpt-5"',
          "",
          "[mcp_servers.amem]",
          'command = "/old/amem"',
          'args = ["mcp"]',
          "",
          "[mcp_servers.amem.env]",
          'STALE = "1"',
          "",
          "[mcp_servers.other]",
          'command = "/bin/true"',
          "",
        ].join("\n"),
        "utf8",
      );
      const first = installAgent("codex");
      assert.equal(first.mcp.status, "updated");
      const toml = readFileSync(path, "utf8");
      assert.match(toml, /^model = "gpt-5"$/m, "top-level keys kept");
      assert.match(toml, /\[mcp_servers\.other\]\ncommand = "\/bin\/true"/, "other server kept");
      assert.doesNotMatch(toml, /\/old\/amem/, "old amem entry replaced");
      assert.doesNotMatch(toml, /STALE/, "old amem sub-table removed");
      assert.equal((toml.match(/\[mcp_servers\.amem\]/g) ?? []).length, 1);
      assert.match(toml, /args = \[.*"mcp"\]/);
      assert.equal(installAgent("codex").mcp.status, "unchanged", "idempotent");
    });
  });

  it("merges mcpServers.amem into Gemini CLI and Qwen Code settings", async () => {
    await withFakeHome(async (home) => {
      const { installAgent } = await import("../dist/install/agents.js");
      for (const [id, dir] of [["gemini", ".gemini"], ["qwen", ".qwen"]]) {
        const path = join(home, dir, "settings.json");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }));
        const result = installAgent(id);
        assert.equal(result.mcp.status, "added", id);
        const json = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(json.theme, "dark", `${id} keeps settings`);
        assert.equal(json.mcpServers.other.command, "x", `${id} keeps other servers`);
        assert.ok(json.mcpServers.amem.command, `${id} has amem`);
        assert.ok(json.mcpServers.amem.args.includes("mcp"), `${id} runs amem mcp`);
      }
    });
  });

  it("writes OpenCode's local MCP shape under the mcp key", async () => {
    await withFakeHome(async (home) => {
      const { installAgent } = await import("../dist/install/agents.js");
      installAgent("opencode");
      const path = join(home, ".config", "opencode", "opencode.json");
      assert.ok(existsSync(path));
      const entry = JSON.parse(readFileSync(path, "utf8")).mcp.amem;
      assert.equal(entry.type, "local");
      assert.equal(entry.enabled, true);
      assert.ok(Array.isArray(entry.command) && entry.command.includes("mcp"));
    });
  });

  it("leaves an OpenCode config with comments alone instead of rewriting it", async () => {
    await withFakeHome(async (home) => {
      const { installAgent } = await import("../dist/install/agents.js");
      const path = join(home, ".config", "opencode", "opencode.json");
      mkdirSync(dirname(path), { recursive: true });
      const jsonc = '{\n  // my settings\n  "theme": "dark"\n}\n';
      writeFileSync(path, jsonc);
      assert.equal(installAgent("opencode").mcp.status, "skipped");
      assert.equal(readFileSync(path, "utf8"), jsonc);
    });
  });

  it("writes QWEN.md for Qwen Code and AGENTS.md for Codex and OpenCode", async () => {
    const { instructionTargets } = await import("../dist/instructions.js");
    assert.deepEqual(instructionTargets(["qwen"]).map((t) => t.path), ["QWEN.md"]);
    assert.deepEqual(instructionTargets(["codex", "opencode"]).map((t) => t.path), ["AGENTS.md"]);
  });
});

function remember(handleApi, repo, repoDir, body) {
  return handleApi({
    method: "POST",
    pathname: "/api/remember",
    searchParams: new URLSearchParams({ repo: repo.id }),
    body,
    cwd: repoDir,
  });
}

describe("failure records", () => {
  it("stores approach, symptom, cause and retry condition as kind fail", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("fail-record");
      const { upsertRepo, listClaims } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { handleApi } = await import("../dist/api/routes.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");
      const res = remember(handleApi, repo, repoDir, {
        approach: "Mocking the auth client with nock in src/auth.ts tests",
        symptom: "Requests hang until the 30s test timeout",
        cause: "The client uses undici, which nock does not intercept",
        retry_when: "the client moves back to node:http",
        anchors: ["src/auth.ts"],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const claim = listClaims(repo.id).find((c) => c.id === res.body.claimId);
      assert.equal(claim.kind, "fail");
      assert.match(claim.text, /^Failed approach: Mocking the auth client/);
      assert.match(claim.text, /Symptom: Requests hang/);
      assert.match(claim.text, /Cause: The client uses undici/);
      assert.match(claim.text, /Retry only when: the client moves back to node:http\./);
    });
  });

  it("rejects a failure record without approach and symptom", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("fail-record-bad");
      const { upsertRepo } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { handleApi } = await import("../dist/api/routes.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");
      const res = remember(handleApi, repo, repoDir, { cause: "undici is not intercepted by nock" });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /approach and symptom/);
    });
  });

  it("ranks a failure as high as a gotcha", async () => {
    const { kindRankBoost } = await import("../dist/kinds.js");
    assert.equal(kindRankBoost("fail"), kindRankBoost("gotcha"));
  });
});

describe("cited evidence", () => {
  it("numbers matching memories with id, kind, anchors and freshness", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("evidence");
      const { upsertRepo } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { handleApi } = await import("../dist/api/routes.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");
      const saved = remember(handleApi, repo, repoDir, {
        text: "Drive sync must check the auth mode in src/auth.ts before it starts",
        kind: "constraint",
        anchors: ["src/auth.ts"],
      });
      assert.equal(saved.status, 200);
      const res = handleApi({
        method: "POST",
        pathname: "/api/evidence",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: { question: "When does Drive sync check the auth mode?" },
        cwd: repoDir,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const first = res.body.evidence[0];
      assert.equal(first.cite, "E1");
      assert.equal(first.id, saved.body.claimId);
      assert.equal(first.kind, "constraint");
      assert.deepEqual(first.anchors, ["src/auth.ts"]);
      assert.ok(first.freshness);
      assert.match(res.body.markdown, /\[E1\] \(constraint, /);
      assert.match(res.body.markdown, /cite each statement/);
    });
  });

  it("says plainly when nothing bears on the question", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("evidence-empty");
      const { upsertRepo } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { handleApi } = await import("../dist/api/routes.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");
      const res = handleApi({
        method: "POST",
        pathname: "/api/evidence",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: { question: "How is the billing ledger reconciled?" },
        cwd: repoDir,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.evidence.length, 0);
      assert.match(res.body.markdown, /No stored memory bears on this question/);
    });
  });
});
