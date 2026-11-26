/**
 * FTS5/BM25 search over facts, skills and tasks; global vs project scope and
 * amem_bootstrap; max_tokens budgets; skill triggers; supersession + TTL; import/export;
 * and the API routes the UI and MCP use for all of it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { withAmemHome, makeGitRepo, root } from "./helpers.mjs";

const cli = join(root, "dist", "cli.js");

async function api(method, pathname, { qs = "", body = null, cwd = process.cwd() } = {}) {
  const { handleApi } = await import("../dist/api/routes.js");
  const res = handleApi({ method, pathname, searchParams: new URLSearchParams(qs), body, cwd });
  return { status: res.status, body: res.body };
}

async function bindRepo(dir) {
  const { upsertRepo } = await import("../dist/db.js");
  const { detectRepoIdentity } = await import("../dist/repo-identity.js");
  return upsertRepo(detectRepoIdentity(dir), "claude");
}

async function remember(dir, text, extra = {}) {
  const res = await api("POST", "/api/remember", { cwd: dir, body: { text, kind: "constraint", ...extra } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

function writeSkill(home, name, frontmatter, body = "# Steps\n\n1. Do it.\n") {
  const dir = join(home, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n${frontmatter}\n---\n${body}`);
}

async function mcp(name, args) {
  const { dispatchMcp } = await import("../dist/mcp.js");
  const res = dispatchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return { text: res.result.content.map((c) => c.text).join(""), isError: res.result.isError };
}

describe("hybrid search (FTS5 + BM25)", () => {
  it("ranks facts, skills and tasks together and expands natural phrasing", async () => {
    await withAmemHome(async (home) => {
      const dir = makeGitRepo();
      const repo = await bindRepo(dir);
      await remember(dir, "The JWT login middleware validates the session token on every API request");
      await remember(dir, "Payment webhooks retry three times with exponential backoff before alerting");
      const { insertTask, deleteTask } = await import("../dist/db.js");
      const task = insertTask({ repoId: repo.id, title: "Fix OAuth redirect loop after logout", source: "test" });
      writeSkill(home, "rotate-tokens", "description: Rotate signing keys for authentication services\ntags: [security]");

      const { searchMemory } = await import("../dist/recall.js");
      const res = searchMemory({ query: "auth flow", repo });
      assert.equal(res.engine, "fts5");
      const types = new Set(res.items.map((i) => i.type));
      assert.deepEqual([...types].sort(), ["claim", "skill", "task"]);
      assert.match(res.items.find((i) => i.type === "claim").text, /JWT login middleware/);
      assert.ok(!res.items.some((i) => /webhooks/.test(i.text)), "unrelated fact stays out");

      const onlyTasks = searchMemory({ query: "oauth", repo, types: ["task"] });
      assert.deepEqual(onlyTasks.items.map((i) => i.id), [task.id]);

      // Deleting a task removes it from the index.
      deleteTask(repo.id, task.id);
      assert.equal(searchMemory({ query: "oauth redirect", repo, types: ["task"] }).items.length, 0);

      // Structured filters: tags match kind/anchors/skill tags; status filters tasks.
      assert.equal(searchMemory({ query: "authentication", repo, types: ["skill"], tags: ["security"] }).items.length, 1);
      assert.equal(searchMemory({ query: "authentication", repo, types: ["skill"], tags: ["nope"] }).items.length, 0);
    });
  });

  it("falls back to keyword scoring when FTS5 is unavailable", async () => {
    const prev = process.env.AMEM_DISABLE_FTS;
    process.env.AMEM_DISABLE_FTS = "1";
    try {
      await withAmemHome(async () => {
        const dir = makeGitRepo();
        const repo = await bindRepo(dir);
        await remember(dir, "The JWT login middleware validates the session token on every API request");
        const { openDb } = await import("../dist/db.js");
        const tables = openDb().prepare(`SELECT name FROM sqlite_master WHERE name IN ('claims_fts','amem_fts')`).all();
        assert.equal(tables.length, 0, "no FTS tables are created");
        const { searchMemory } = await import("../dist/recall.js");
        const res = searchMemory({ query: "auth flow", repo });
        assert.equal(res.engine, "keyword");
        assert.match(res.items[0].text, /JWT/);
        const ctx = await api("POST", "/api/context", { cwd: dir, body: { query: "JWT middleware" } });
        assert.equal(ctx.status, 200);
        assert.match(ctx.body.markdown, /JWT login middleware/);
      });
    } finally {
      if (prev === undefined) delete process.env.AMEM_DISABLE_FTS;
      else process.env.AMEM_DISABLE_FTS = prev;
    }
  });
});

describe("scoping and amem_bootstrap", () => {
  it("resolves global and project scopes and keeps private personal facts out of projects", async () => {
    await withAmemHome(async () => {
      const dir = makeGitRepo();
      const repo = await bindRepo(dir);
      const { resolveScope, scopeOf, searchMemory } = await import("../dist/recall.js");
      const global = resolveScope("global");
      assert.equal(scopeOf(global), "global");
      assert.equal(resolveScope(`project:${dir}`).id, repo.id);
      assert.equal(resolveScope(undefined, dir).id, repo.id);
      assert.equal(scopeOf(repo), `project:${repo.root_path}`);

      const { applyProposal } = await import("../dist/proposal.js");
      applyProposal(global.id, {
        claims: [
          { id: "claim.g_rule", kind: "constraint", text: "Always squash merge pull requests once CI is green", code_anchors: ["personal"] },
          { id: "claim.g_private", kind: "private", text: "Dentist appointment and merge of family calendars", code_anchors: ["personal"] },
        ],
      });
      const res = searchMemory({ query: "merge", repo });
      assert.ok(res.items.some((i) => i.id === "claim.g_rule" && i.scope === "global"));
      assert.ok(!res.items.some((i) => i.id === "claim.g_private"), "private personal fact stays out of a project");
      assert.equal(searchMemory({ query: "merge", repo, includeGlobal: false }).items.length, 0);
    });
  });

  it("returns a compact startup payload: rules, active tasks, facts, skill hints", async () => {
    await withAmemHome(async (home) => {
      const dir = makeGitRepo();
      writeFileSync(join(dir, "Package.swift"), "// swift\n");
      const repo = await bindRepo(dir);
      const { resolveScope } = await import("../dist/recall.js");
      const { applyProposal } = await import("../dist/proposal.js");
      applyProposal(resolveScope("global").id, {
        claims: [{ id: "claim.g1", kind: "constraint", text: "Never force-push to shared branches", code_anchors: ["personal"] }],
      });
      for (let i = 0; i < 12; i += 1) {
        await remember(dir, `Service module ${i} owns the billing reconciliation step number ${i} for invoices`);
      }
      const { insertTask } = await import("../dist/db.js");
      insertTask({ repoId: repo.id, title: "Backlog chore", status: "backlog" });
      insertTask({ repoId: repo.id, title: "Ship the refund flow", status: "doing" });
      writeSkill(home, "ios-release", 'description: Build and ship the iOS app\nfiles: ["*.swift", "Package.swift"]');

      const { workspaceIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo } = await import("../dist/db.js");
      upsertRepo(workspaceIdentity("boot-ws", mkdtempSync(join(tmpdir(), "amem-boot-ws-"))), "claude");
      const res = await mcp("amem_bootstrap", { workspace: "boot-ws" });
      assert.equal(res.isError, false, res.text);
      assert.match(res.text, /# amem bootstrap · boot-ws/);
      assert.match(res.text, /Never force-push/, "global rules reach every project");
      const boot = await api("POST", "/api/session-bootstrap", { cwd: dir, body: {} });
      assert.equal(boot.status, 200);
      const b = boot.body;
      assert.ok(b.tokens <= b.maxTokens, `${b.tokens} <= ${b.maxTokens}`);
      assert.ok(b.maxTokens <= 400);
      assert.match(b.markdown, /Never force-push/);
      assert.match(b.markdown, /\[doing\] Ship the refund flow/);
      assert.ok(b.markdown.indexOf("[doing]") < b.markdown.indexOf("[backlog]") || !b.markdown.includes("[backlog]"));
      assert.match(b.markdown, /\*\*ios-release\*\* \(file \*\.swift/);
      assert.equal(b.scope, `project:${repo.root_path}`);

      const tiny = await api("POST", "/api/session-bootstrap", { cwd: dir, body: { max_tokens: 120 } });
      assert.ok(tiny.body.tokens <= 120 + 10, `tiny budget respected (${tiny.body.tokens})`);
      assert.match(tiny.body.markdown, /Trimmed to ~120 tokens/);
    });
  });
});

describe("token-budgeted retrieval", () => {
  it("packs by score, never cuts mid-item, and reports truncation", async () => {
    const { packToBudget } = await import("../dist/recall.js");
    const items = [{ tokens: 50 }, { tokens: 80 }, { tokens: 30 }];
    const r = packToBudget(items, 90);
    assert.deepEqual(r.kept.map((i) => i.tokens), [50, 30]);
    assert.equal(r.usedTokens, 80);
    assert.equal(r.truncated, true);
    assert.equal(packToBudget(items, undefined).truncated, false);
  });

  it("search and context honour max_tokens", async () => {
    await withAmemHome(async () => {
      const dir = makeGitRepo();
      const repo = await bindRepo(dir);
      for (let i = 0; i < 10; i += 1) {
        await remember(dir, `Deploy step ${i}: the release pipeline promotes build ${i} to staging after smoke tests pass`);
      }
      const { searchMemory } = await import("../dist/recall.js");
      const full = searchMemory({ query: "deploy release", repo });
      const capped = searchMemory({ query: "deploy release", repo, maxTokens: 80 });
      assert.ok(full.items.length > capped.items.length);
      assert.ok(capped.usedTokens <= 80);
      assert.equal(capped.truncated, true);
      assert.ok(capped.omitted > 0);
      // Highest-scored items survive.
      assert.equal(capped.items[0].id, full.items[0].id);

      const ctx = await api("POST", "/api/context", { cwd: dir, body: { query: "deploy release pipeline", max_tokens: 150 } });
      assert.equal(ctx.status, 200);
      assert.equal(ctx.body.truncated, true);
      assert.ok(ctx.body.tokens <= 150, `${ctx.body.tokens}`);
      assert.match(ctx.body.markdown, /Truncated to fit max_tokens=150/);
      assert.match(ctx.body.markdown, /### claim\./, "the best claim always stays");

      const roomy = await api("POST", "/api/context", { cwd: dir, body: { query: "deploy release pipeline", max_tokens: 50000 } });
      assert.equal(roomy.body.truncated, false);

      const searched = await api("POST", "/api/search", { cwd: dir, body: { query: "deploy", max_tokens: 60 } });
      assert.equal(searched.status, 200);
      assert.ok(searched.body.usedTokens <= 60);
    });
  });
});

describe("skill triggers", () => {
  it("matches globs and keywords and returns one-line hints, not bodies", async () => {
    const { matchGlob, matchSkillTriggers, parseFrontmatter } = await import("../dist/skills.js");
    assert.ok(matchGlob("Sources/App/View.swift", "*.swift"));
    assert.ok(matchGlob("Package.swift", "Package.swift"));
    assert.ok(!matchGlob("Package.swift.bak", "Package.swift"));
    assert.ok(matchGlob("db/migrations/001_init.sql", "db/migrations/*.sql"));
    assert.ok(matchGlob("src/a/b/c.ts", "src/**/*.ts"));
    assert.ok(!matchGlob("lib/c.ts", "src/**/*.ts"));
    // Nested `triggers:` keys flatten to files / keywords.
    const fm = parseFrontmatter('---\nname: x\ntriggers:\n  files: ["*.tf"]\n  keywords: [terraform, plan]\n---\nbody');
    assert.deepEqual(fm.meta.files, ["*.tf"]);
    const skills = [
      { name: "tf", description: "Terraform plan and apply", files: ["*.tf"], keywords: ["terraform"] },
      { name: "deploy", description: "Ship to prod", files: [], keywords: ["deploy", "migration"] },
    ];
    assert.deepEqual(matchSkillTriggers(skills, { files: ["infra/main.tf"] }).map((h) => h.name), ["tf"]);
    const kw = matchSkillTriggers(skills, { text: "run the database migration tonight" });
    assert.equal(kw[0].name, "deploy");
    assert.match(kw[0].match, /keyword "migration"/);
    assert.ok(!("body" in kw[0]));
  });

  it("surfaces hints through the skills API and saves triggers from MCP", async () => {
    await withAmemHome(async (home) => {
      writeSkill(home, "swift-build", 'description: Build the Swift package\nfiles: ["*.swift"]\nkeywords: [xcode]', "# Long body that must not appear in hints\n");
      const res = await api("GET", "/api/skills", { qs: "files=App/Main.swift" });
      assert.equal(res.status, 200);
      assert.equal(res.body.hints[0].name, "swift-build");
      assert.ok(!JSON.stringify(res.body.hints).includes("Long body"));

      const listed = await mcp("amem_skill_list", { files: ["Main.swift"] });
      assert.match(listed.text, /"hints"/);

      const saved = await mcp("amem_skill_save", {
        name: "db-migrate",
        description: "Run schema migrations safely",
        content: "# Migrate\n\n1. Back up.\n",
        files: ["db/migrations/*.sql"],
        keywords: ["migration"],
      });
      assert.equal(saved.isError, false, saved.text);
      const md = readFileSync(join(home, "skills", "db-migrate", "SKILL.md"), "utf8");
      assert.match(md, /files: \["db\/migrations\/\*\.sql"\]/);
      assert.match(md, /keywords: \[migration\]/);
      const { searchMemory } = await import("../dist/recall.js");
      assert.ok(searchMemory({ query: "migration", repo: null, types: ["skill"] }).items.some((i) => i.id === "db-migrate"));
    });
  });
});

describe("supersession and TTL", () => {
  it("supersedes with lineage and excludes expired facts from recall", async () => {
    await withAmemHome(async () => {
      const dir = makeGitRepo();
      const repo = await bindRepo(dir);
      const old = await remember(dir, "We deploy the API with Heroku pipelines and manual promotion");
      const next = await remember(dir, "We deploy the API with Fly.io machines and automatic promotion", { supersedes: [old.claimId] });
      const { getClaim, listClaims, expireDueClaims } = await import("../dist/db.js");
      const prior = getClaim(repo.id, old.claimId);
      assert.equal(prior.status, "superseded");
      assert.equal(prior.superseded_by, next.claimId);
      const { searchMemory } = await import("../dist/recall.js");
      assert.ok(!searchMemory({ query: "deploy heroku", repo }).items.some((i) => i.id === old.claimId));
      assert.ok(searchMemory({ query: "deploy heroku", repo, status: "all" }).items.some((i) => i.id === old.claimId));

      const temp = await remember(dir, "Debugging note: the staging queue consumer is paused for the incident", { ttl_days: 1 });
      assert.ok(temp.expiresAt);
      assert.ok(listClaims(repo.id).some((c) => c.id === temp.claimId));
      const past = await remember(dir, "Debugging note: feature flag beta-checkout forced on in staging for tests", {
        expires_at: "2020-01-01T00:00:00Z",
      });
      assert.ok(!listClaims(repo.id).some((c) => c.id === past.claimId), "past expiry is not served");
      assert.ok(!searchMemory({ query: "beta-checkout flag", repo }).items.some((i) => i.id === past.claimId));
      const ctx = await api("POST", "/api/context", { cwd: dir, body: { query: "beta-checkout feature flag" } });
      assert.ok(!ctx.body.markdown.includes(past.claimId));

      assert.equal(expireDueClaims(), 1);
      assert.equal(getClaim(repo.id, past.claimId).status, "expired", "kept as history");
      // A day later the TTL note expires too.
      assert.equal(expireDueClaims(new Date(Date.now() + 2 * 86_400_000).toISOString()), 1);

      const bad = await api("POST", "/api/remember", { cwd: dir, body: { text: "Something durable about the build cache layout", ttl_days: -3 } });
      assert.equal(bad.status, 400);
      const mcpBad = await mcp("amem_remember", { text: "x", ttl_days: 5 });
      assert.equal(mcpBad.isError, true);
    });
  });

  it("re-remembering without a TTL makes the fact permanent again", async () => {
    await withAmemHome(async () => {
      const dir = makeGitRepo();
      const repo = await bindRepo(dir);
      const text = "Release freeze is in effect for the payments service this sprint";
      const first = await remember(dir, text, { ttl_days: 2 });
      const { getClaim } = await import("../dist/db.js");
      assert.ok(getClaim(repo.id, first.claimId).expires_at);
      await remember(dir, text);
      assert.equal(getClaim(repo.id, first.claimId).expires_at, null);
    });
  });
});

describe("import and export", () => {
  const RULES = [
    "---",
    "alwaysApply: true",
    "---",
    "# Team rules",
    "",
    "## Testing",
    "- Always run the unit tests before pushing to main",
    "- Never skip a failing test; mark it as a known bug",
    "  - link the ticket key in the reason",
    "",
    "```bash",
    "- not a rule inside a code block",
    "```",
    "",
    "Prefer small pull requests with one concern each over large batches.",
    "",
    "## Todo",
    "- [ ] Add coverage for refund webhooks",
    "- [x] Remove the legacy login page",
  ].join("\n");

  it("parses rules files into facts and tasks", async () => {
    const { parseImportFile } = await import("../dist/import-export.js");
    const p = parseImportFile("/x/.cursor/rules/team.mdc", RULES);
    const texts = p.claims.map((c) => c.text);
    assert.deepEqual(texts, [
      "Team rules › Testing: Always run the unit tests before pushing to main",
      "Team rules › Testing: Never skip a failing test; mark it as a known bug; link the ticket key in the reason",
      "Team rules › Testing: Prefer small pull requests with one concern each over large batches.",
    ]);
    assert.ok(!texts.some((t) => t.includes("code block")));
    assert.deepEqual(p.tasks.map((t) => [t.title, t.status]), [
      ["Add coverage for refund webhooks", "backlog"],
      ["Remove the legacy login page", "done"],
    ]);
    assert.deepEqual(p.claims[0].anchors, ["team.mdc"]);
  });

  it("imports without duplicates, supports dry runs and global scope", async () => {
    await withAmemHome(async () => {
      const dir = makeGitRepo();
      const repo = await bindRepo(dir);
      const { importIntoRepo, parseImportFile } = await import("../dist/import-export.js");
      const parsed = parseImportFile(join(dir, "CLAUDE.md"), RULES);
      const dry = importIntoRepo(repo, parsed, { dryRun: true });
      assert.equal(dry.claims.added, 3);
      const { listClaims, listTasks } = await import("../dist/db.js");
      assert.equal(listClaims(repo.id).length, 0, "dry run writes nothing");

      const first = importIntoRepo(repo, parsed);
      assert.deepEqual([first.claims.added, first.tasks.added], [3, 2]);
      const again = importIntoRepo(repo, parsed);
      assert.deepEqual([again.claims.added, again.claims.skipped, again.tasks.added], [0, 3, 0]);
      assert.equal(listClaims(repo.id).length, 3);
      assert.equal(listTasks(repo.id, { includeDone: true }).length, 2);

      const viaApi = await api("POST", "/api/import", { cwd: dir, body: { scope: "global", filename: "AGENTS.md", content: RULES } });
      assert.equal(viaApi.status, 200);
      assert.equal(viaApi.body.scope, "global");
      assert.equal(viaApi.body.claims.added, 3);
    });
  });

  it("round-trips JSON (with lineage, TTL, pins) and Markdown exports", async () => {
    await withAmemHome(async () => {
      const dir = makeGitRepo();
      const repo = await bindRepo(dir);
      const old = await remember(dir, "Staging database lives on the shared Postgres cluster in us-east");
      const cur = await remember(dir, "Staging database moved to a dedicated Postgres instance in eu-west", { supersedes: [old.claimId] });
      await remember(dir, "Temporary: the nightly regression suite is muted during the migration window", { ttl_days: 3 });
      const { setClaimPinned, insertTask } = await import("../dist/db.js");
      setClaimPinned(repo.id, cur.claimId, true);
      insertTask({ repoId: repo.id, title: "Decommission the shared cluster", status: "next" });

      const exp = await api("GET", "/api/export", { cwd: dir });
      assert.equal(exp.status, 200);
      assert.equal(exp.body.version, 2);
      const json = JSON.stringify(exp.body);

      const other = makeGitRepo();
      const target = await bindRepo(other);
      const imp = await api("POST", "/api/import", { cwd: other, body: { filename: "export.json", content: json } });
      assert.equal(imp.status, 200, JSON.stringify(imp.body));
      assert.equal(imp.body.claims.added, 3);
      assert.equal(imp.body.tasks.added, 1);
      const { getClaim, listTasks } = await import("../dist/db.js");
      const oldCopy = getClaim(target.id, old.claimId);
      assert.equal(oldCopy.status, "superseded");
      assert.equal(oldCopy.superseded_by, cur.claimId);
      assert.equal(getClaim(target.id, cur.claimId).pinned, 1);
      assert.equal(listTasks(target.id)[0].status, "next");
      const ttl = (await api("POST", "/api/import", { cwd: other, body: { filename: "export.json", content: json } })).body;
      assert.equal(ttl.claims.added, 0, "second import adds nothing");

      const md = await api("GET", "/api/export", { cwd: dir, qs: "format=md" });
      assert.match(md.body.markdown, /^# amem export/);
      assert.match(md.body.markdown, /### History \(superseded \/ expired\)/);
      // Markdown re-import into the same project adds nothing new.
      const back = await api("POST", "/api/import", { cwd: dir, body: { filename: "export.md", content: md.body.markdown } });
      assert.equal(back.body.claims.added, 0, JSON.stringify(back.body));
      assert.equal(back.body.tasks.added, 0);
    });
  });

  it("CLI: import a project dir, export md/json, search and bootstrap", () => {
    const home = mkdtempSync(join(tmpdir(), "amem-cli-recall-"));
    const repo = makeGitRepo();
    const env = { ...process.env, HOME: home, AMEM_HOME: join(home, ".amem") };
    delete env.AMEM_WORKSPACE;
    const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: "utf8" });
    try {
      run("init", "--platform", "claude");
      writeFileSync(join(repo, "CLAUDE.md"), "# Repo\n\n- Use pnpm, never npm, for installs in this monorepo\n");
      writeFileSync(join(repo, ".cursorrules"), "Prefer server components in the Next.js app directory.\n");
      const out = run("import", ".");
      assert.match(out, /CLAUDE\.md .*facts \+1/);
      assert.match(out, /\.cursorrules .*facts \+1/);
      assert.match(run("import", "."), /facts \+0 \(1 already there\)/);
      assert.match(run("search", "pnpm installs"), /pnpm/);
      const boot = JSON.parse(run("bootstrap", "--json"));
      assert.ok(boot.tokens <= boot.maxTokens);
      assert.match(run("export", "--format", "md"), /Use pnpm/);
      const all = JSON.parse(run("export", "--all"));
      assert.ok(Array.isArray(all.repos));
      assert.match(run("remember", "Temporary note about the flaky checkout test today", "--ttl-days", "1"), /Expires: /);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("MCP tools and schema upgrade", () => {
  it("lists the new tools with concise schemas and serves search", async () => {
    await withAmemHome(async () => {
      const { dispatchMcp } = await import("../dist/mcp.js");
      const tools = dispatchMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }).result.tools;
      const names = tools.map((t) => t.name);
      assert.ok(names.includes("amem_bootstrap"));
      assert.ok(names.includes("amem_search"));
      for (const t of tools.filter((x) => x.name === "amem_bootstrap" || x.name === "amem_search")) {
        assert.ok(JSON.stringify(t).length < 1400, `${t.name} schema stays small`);
      }
      assert.ok(tools.find((t) => t.name === "amem_context").inputSchema.properties.max_tokens);
      assert.ok(tools.find((t) => t.name === "amem_remember").inputSchema.properties.ttl_days);
      const empty = await mcp("amem_search", {});
      assert.equal(empty.isError, true);
    });
  });

  it("upgrades a version-4 database: adds expires_at and indexes existing tasks", async () => {
    await withAmemHome(async (home) => {
      const dir = makeGitRepo();
      const repo = await bindRepo(dir);
      const { insertTask, closeDb, openDb, SCHEMA_VERSION } = await import("../dist/db.js");
      insertTask({ repoId: repo.id, title: "Rotate the webhook signing secret", source: "test" });
      closeDb();
      // Roll the file back to how a 0.8.0 install left it.
      const raw = new Database(join(home, "graph.db"));
      raw.exec("DROP TABLE amem_fts");
      raw.exec("DROP INDEX IF EXISTS claims_expires_idx");
      raw.exec("ALTER TABLE claims DROP COLUMN expires_at");
      raw.pragma("user_version = 4");
      raw.close();

      openDb();
      const db = openDb();
      assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      assert.ok(db.prepare("PRAGMA table_info(claims)").all().some((c) => c.name === "expires_at"));
      const { searchMemory } = await import("../dist/recall.js");
      assert.equal(searchMemory({ query: "webhook secret", repo, types: ["task"] }).items.length, 1);
    });
  });
});
