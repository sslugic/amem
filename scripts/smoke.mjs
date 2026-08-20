#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const cli = join(root, "dist", "cli.js");
const amemHome = mkdtempSync(join(tmpdir(), "amem-smoke-home-"));
const repoDir = mkdtempSync(join(tmpdir(), "amem-smoke-repo-"));
const extraDirs = [];

function run(args, cwd = repoDir, envExtra = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      AMEM_HOME: amemHome,
      CURSOR_HOME: join(amemHome, "cursor-home"),
      CLAUDE_HOME: join(amemHome, "claude-home"),
      ...envExtra,
    },
  });
}

try {
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  writeFileSync(join(repoDir, "README.md"), "# smoke\n");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "api.ts"), "export const api = true;\n");

  console.log(run(["init", "--platform", "cursor"]));
  console.log(run(["status"]));

  const proposal = {
    components: [{ id: "component.api", name: "API", code_anchor: "src/api.ts" }],
    flows: [{ id: "flow.boot", name: "Boot" }],
    claims: [
      {
        id: "claim.api_entry",
        kind: "structure",
        text: "API entrypoint lives in src/api.ts",
        code_anchors: ["src/api.ts"],
      },
      {
        id: "claim.boot_order",
        kind: "constraint",
        text: "Boot flow initializes API before serving requests",
        code_anchors: ["src/api.ts"],
      },
    ],
    edges: [
      {
        from_id: "claim.api_entry",
        from_type: "claim",
        to_id: "flow.boot",
        to_type: "flow",
        kind: "about",
      },
      {
        from_id: "flow.boot",
        from_type: "flow",
        to_id: "component.api",
        to_type: "component",
        kind: "uses",
      },
    ],
  };
  const proposalPath = join(amemHome, "proposal.json");
  writeFileSync(proposalPath, JSON.stringify(proposal, null, 2));

  console.log(run(["propose", "validate", proposalPath]));
  console.log(run(["propose", "apply", proposalPath]));
  const context = run(["context", "api boot", "--platform", "cursor"]);
  console.log(context);

  if (!context.includes("claim.api_entry") || !context.includes("flow.boot")) {
    throw new Error("context packet missing expected claims/flows");
  }
  if (!context.includes("Usage logged")) {
    throw new Error("context did not log usage event");
  }

  console.log(run(["doctor"]));

  // Policy + attest
  const policyPath = join(amemHome, "enterprise-policy.toml");
  writeFileSync(
    policyPath,
    [
      "telemetry = false",
      'ui_bind = "127.0.0.1"',
      "allow_export = false",
      'allowed_platforms = ["cursor", "claude"]',
      'deny_claim_patterns = ["supersecretvalue"]',
      "",
    ].join("\n"),
  );

  const attest = run(["doctor", "--attest", "--json"], repoDir, {
    AMEM_POLICY_PATH: policyPath,
  });
  const attestJson = JSON.parse(attest);
  if (attestJson.privacy.network_egress !== "none") {
    throw new Error("attest missing network_egress none");
  }
  if (attestJson.privacy.telemetry !== false) {
    throw new Error("attest telemetry should be false");
  }
  if (attestJson.policy.effective.allow_export !== false) {
    throw new Error("attest did not pick up allow_export=false");
  }
  console.log("attest ok");

  const blockedProposal = {
    claims: [
      {
        id: "claim.leak",
        kind: "constraint",
        text: "token is supersecretvalue do not store",
        code_anchors: ["src/api.ts"],
      },
    ],
  };
  const blockedPath = join(amemHome, "blocked.json");
  writeFileSync(blockedPath, JSON.stringify(blockedProposal));
  let blockedFailed = false;
  try {
    run(["propose", "validate", blockedPath], repoDir, {
      AMEM_POLICY_PATH: policyPath,
    });
  } catch {
    blockedFailed = true;
  }
  if (!blockedFailed) {
    throw new Error("expected deny_claim_patterns to block proposal");
  }
  console.log("deny_claim_patterns ok");

  let exportBlocked = false;
  try {
    run(["export"], repoDir, { AMEM_POLICY_PATH: policyPath });
  } catch {
    exportBlocked = true;
  }
  if (!exportBlocked) {
    throw new Error("expected allow_export=false to block export");
  }
  console.log("export policy ok");

  // Exercise API layer used by UI
  const { handleApi } = await import(join(root, "dist", "api", "routes.js"));
  process.chdir(repoDir);
  process.env.AMEM_HOME = amemHome;

  const graph = handleApi({
    method: "GET",
    pathname: "/api/graph",
    searchParams: new URLSearchParams("days=30"),
    body: null,
    cwd: repoDir,
  });
  if (graph.status !== 200 || !graph.body.claims?.length) {
    throw new Error("api/graph failed");
  }
  const activityIds = (graph.body.activity?.nodes || []).map((n) => n.id);
  if (!activityIds.includes("amem.local") || !activityIds.includes("llm.cursor")) {
    throw new Error(`graph missing activity nodes: ${activityIds.join(",")}`);
  }

  const usage = handleApi({
    method: "GET",
    pathname: "/api/usage",
    searchParams: new URLSearchParams("repo=current&days=30"),
    body: null,
    cwd: repoDir,
  });
  if (usage.status !== 200 || !usage.body.events?.length) {
    throw new Error("api/usage missing events");
  }
  if (!(usage.body.aggregate.totals.estimatedTokensSaved > 0)) {
    throw new Error("expected estimated token savings");
  }
  if (!(usage.body.aggregate.totals.estimatedMsSaved > 0)) {
    throw new Error("expected estimated time savings");
  }
  if (!(usage.body.aggregate.totals.estimatedUsdSaved > 0)) {
    throw new Error("expected estimated money savings");
  }
  if (usage.body.aggregate.pricing?.usdPerMillionInputTokens !== 3) {
    throw new Error("expected $3/1M input pricing on stats");
  }
  if (usage.body.aggregate.totals.avgLocalMs == null) {
    throw new Error("expected measured local lookup ms");
  }
  if (!(usage.body.aggregate.monthly?.estimatedTokensSaved > 0)) {
    throw new Error("expected monthly token projection");
  }
  if (!(usage.body.aggregate.monthly?.queries > 0)) {
    throw new Error("expected monthly call projection");
  }
  if (!usage.body.events.some((e) => e.kind === "local_hit")) {
    throw new Error("expected a keyword hit for 'api boot'");
  }

  console.log(run(["context", "zzzzqwxnonmatchtoken999", "--platform", "cursor"]));
  const usageMiss = handleApi({
    method: "GET",
    pathname: "/api/usage",
    searchParams: new URLSearchParams("repo=current&days=30"),
    body: null,
    cwd: repoDir,
  });
  const miss = (usageMiss.body.events || []).find((e) => /zzzzqwxnonmatchtoken999/.test(e.query || ""));
  if (!miss || miss.kind !== "server_trip") {
    throw new Error(`unmatched query should be a miss: ${JSON.stringify(miss)}`);
  }
  if (!(usageMiss.body.aggregate.totals.serverTrips >= 1)) {
    throw new Error("unmatched query not counted as a miss");
  }
  if (usageMiss.body.aggregate.totals.hitRate >= 1) {
    throw new Error("hit rate still 100% after a miss");
  }

  const status = handleApi({
    method: "GET",
    pathname: "/api/status",
    searchParams: new URLSearchParams(),
    body: null,
    cwd: repoDir,
  });
  if (status.status !== 200 || !status.body.repo) {
    throw new Error("api/status failed");
  }
  if (!Array.isArray(status.body.repos) || status.body.repos.length < 1) {
    throw new Error("api/status missing repos list");
  }

  const repoDir2 = mkdtempSync(join(tmpdir(), "amem-smoke-repo2-"));
  extraDirs.push(repoDir2);
  execFileSync("git", ["init"], { cwd: repoDir2, stdio: "ignore" });
  writeFileSync(join(repoDir2, "README.md"), "# smoke-two\n");
  console.log(run(["init", "--platform", "cursor"], repoDir2));

  const statusByPath = handleApi({
    method: "GET",
    pathname: "/api/status",
    searchParams: new URLSearchParams({ path: repoDir2 }),
    body: null,
    cwd: repoDir,
  });
  if (statusByPath.status !== 200 || !statusByPath.body.repo) {
    throw new Error("api/status?path= failed to resolve second repo");
  }
  if (statusByPath.body.repos.length !== 2) {
    throw new Error(`expected 2 bound repos, got ${statusByPath.body.repos.length}`);
  }

  const graphByRepo = handleApi({
    method: "GET",
    pathname: "/api/graph",
    searchParams: new URLSearchParams({ repo: statusByPath.body.repo.id, days: "30" }),
    body: null,
    cwd: repoDir,
  });
  if (graphByRepo.status !== 200) {
    throw new Error("api/graph?repo= failed");
  }

  const scanRoot = mkdtempSync(join(tmpdir(), "amem-scan-root-"));
  extraDirs.push(scanRoot);
  const foundRepo = join(scanRoot, "found-app");
  mkdirSync(foundRepo);
  execFileSync("git", ["init"], { cwd: foundRepo, stdio: "ignore" });
  writeFileSync(join(foundRepo, "README.md"), "# found\n");
  process.env.AMEM_SCAN_ROOTS = scanRoot;

  const scanRes = handleApi({
    method: "GET",
    pathname: "/api/scan",
    searchParams: new URLSearchParams(),
    body: null,
    cwd: repoDir,
  });
  if (scanRes.status !== 200) {
    throw new Error("api/scan failed");
  }
  const scannedPaths = (scanRes.body.repos || []).map((r) => r.path);
  if (!scannedPaths.includes(foundRepo)) {
    throw new Error(`api/scan missed ${foundRepo}; got ${scannedPaths.join(", ")}`);
  }

  const trackRes = handleApi({
    method: "POST",
    pathname: "/api/track",
    searchParams: new URLSearchParams(),
    body: { paths: [foundRepo], platforms: ["cursor"] },
    cwd: repoDir,
  });
  if (trackRes.status !== 200 || !trackRes.body.tracked?.length) {
    throw new Error(`api/track failed: ${JSON.stringify(trackRes.body)}`);
  }
  const trackMulti = handleApi({
    method: "POST",
    pathname: "/api/track",
    searchParams: new URLSearchParams(),
    body: { paths: [foundRepo], platforms: ["cursor", "claude", "copilot"] },
    cwd: repoDir,
  });
  if (trackMulti.status !== 200) {
    throw new Error(`api/track multi-platform failed: ${JSON.stringify(trackMulti.body)}`);
  }
  const trackedId = trackMulti.body.tracked?.[0]?.id;
  const trackedStatus = handleApi({
    method: "GET",
    pathname: "/api/status",
    searchParams: new URLSearchParams(trackedId ? { repo: trackedId } : {}),
    body: null,
    cwd: foundRepo,
  });
  const savedPlatforms = JSON.parse(trackedStatus.body?.setup?.platforms || "[]");
  if (!savedPlatforms.includes("cursor") || !savedPlatforms.includes("claude") || !savedPlatforms.includes("copilot")) {
    throw new Error(`setup platforms not persisted: ${JSON.stringify(savedPlatforms)}`);
  }
  if (!Array.isArray(trackedStatus.body?.clients) || trackedStatus.body.clients.length < 5) {
    throw new Error("status missing LLM client catalog");
  }
  if (trackRes.body.repos.length < 3) {
    throw new Error(`expected at least 3 bound repos after track, got ${trackRes.body.repos.length}`);
  }

  const serviceRes = handleApi({
    method: "GET",
    pathname: "/api/service",
    searchParams: new URLSearchParams(),
    body: null,
    cwd: repoDir,
  });
  if (serviceRes.status !== 200 || typeof serviceRes.body.installed !== "boolean") {
    throw new Error("api/service failed");
  }
  if (serviceRes.body.supported !== true && process.platform === "linux") {
    throw new Error("linux should support login service");
  }

  const hookOut = execFileSync(process.execPath, [cli, "hook"], {
    cwd: repoDir,
    encoding: "utf8",
    input: JSON.stringify({
      hook_event_name: "beforeSubmitPrompt",
      prompt: "How does API boot order work in src/api.ts",
      workspace_roots: [repoDir],
      conversation_id: "smoke-conv",
    }),
    env: {
      ...process.env,
      AMEM_HOME: amemHome,
      CURSOR_HOME: join(amemHome, "cursor-home"),
      CLAUDE_HOME: join(amemHome, "claude-home"),
    },
  });
  const hookJson = JSON.parse(hookOut);
  if (!hookJson.additional_context || !hookJson.additional_context.includes("claim.api_entry")) {
    throw new Error(`hook did not inject memory: ${hookOut}`);
  }

  execFileSync(process.execPath, [cli, "hook"], {
    cwd: repoDir,
    encoding: "utf8",
    input: JSON.stringify({
      hook_event_name: "afterAgentResponse",
      text: "Boot flow initializes API before serving requests via src/api.ts",
      workspace_roots: [repoDir],
      conversation_id: "smoke-conv",
    }),
    env: {
      ...process.env,
      AMEM_HOME: amemHome,
      CURSOR_HOME: join(amemHome, "cursor-home"),
      CLAUDE_HOME: join(amemHome, "claude-home"),
    },
  });
  execFileSync(process.execPath, [cli, "hook"], {
    cwd: repoDir,
    encoding: "utf8",
    input: JSON.stringify({
      hook_event_name: "stop",
      workspace_roots: [repoDir],
      conversation_id: "smoke-conv",
    }),
    env: {
      ...process.env,
      AMEM_HOME: amemHome,
      CURSOR_HOME: join(amemHome, "cursor-home"),
      CLAUDE_HOME: join(amemHome, "claude-home"),
    },
  });

  const graphAfterStop = handleApi({
    method: "GET",
    pathname: "/api/graph",
    searchParams: new URLSearchParams(),
    body: null,
    cwd: repoDir,
  });
  const pendingDrafts = graphAfterStop.body?.drafts || [];
  if (!Array.isArray(pendingDrafts) || pendingDrafts.length < 1) {
    throw new Error("stop hook should create a pending draft for approval");
  }
  const draftId = pendingDrafts[0].id;
  if (!pendingDrafts[0].quality) {
    throw new Error("pending draft should include a quality score");
  }
  let applyDraft = handleApi({
    method: "POST",
    pathname: "/api/drafts/apply",
    searchParams: new URLSearchParams(),
    body: { id: draftId },
    cwd: repoDir,
  });
  if (applyDraft.status === 409) {
    applyDraft = handleApi({
      method: "POST",
      pathname: "/api/drafts/apply",
      searchParams: new URLSearchParams(),
      body: { id: draftId, resolve: "keep" },
      cwd: repoDir,
    });
  }
  if (applyDraft.status !== 200) {
    throw new Error(`draft apply failed: ${JSON.stringify(applyDraft.body)}`);
  }
  console.log("session-end draft capture + apply ok");

  const pinRes = handleApi({
    method: "POST",
    pathname: "/api/claims/pin",
    searchParams: new URLSearchParams(),
    body: { id: "claim.boot_order", pinned: true },
    cwd: repoDir,
  });
  if (pinRes.status !== 200 || !pinRes.body?.claim?.pinned) {
    throw new Error(`pin failed: ${JSON.stringify(pinRes.body)}`);
  }
  const pinnedCtx = run(["context", "unrelated query about nothing", "--platform", "cursor"]);
  if (!pinnedCtx.includes("claim.boot_order")) {
    throw new Error("pinned claim should still surface in weak queries");
  }
  console.log("pin boost ok");

  const editRes = handleApi({
    method: "PATCH",
    pathname: "/api/claims",
    searchParams: new URLSearchParams(),
    body: {
      id: "claim.boot_order",
      text: "Boot flow initializes API before serving requests (edited)",
      kind: "constraint",
      code_anchors: ["src/api.ts"],
    },
    cwd: repoDir,
  });
  if (editRes.status !== 200 || !String(editRes.body?.claim?.text || "").includes("edited")) {
    throw new Error(`claim edit failed: ${JSON.stringify(editRes.body)}`);
  }

  const delRes = handleApi({
    method: "DELETE",
    pathname: "/api/claims",
    searchParams: new URLSearchParams({ id: "claim.boot_order" }),
    body: null,
    cwd: repoDir,
  });
  if (delRes.status !== 200) {
    throw new Error(`claim delete failed: ${JSON.stringify(delRes.body)}`);
  }
  const afterDelete = run(["context", "boot order initializes", "--platform", "cursor"]);
  if (afterDelete.includes("### claim.boot_order")) {
    throw new Error("deleted claim should not appear in context");
  }
  // Restore for later FTS/staleness checks in this smoke run
  const restorePath = join(amemHome, "restore-boot.json");
  writeFileSync(
    restorePath,
    JSON.stringify({
      claims: [
        {
          id: "claim.boot_order",
          kind: "constraint",
          text: "Boot flow initializes API before serving requests",
          code_anchors: ["src/api.ts"],
        },
      ],
    }),
  );
  run(["propose", "apply", restorePath]);
  console.log("claim edit/delete ok");

  // Linux service unit install (best-effort file write; enable may no-op in CI)
  if (process.platform === "linux") {
    const before = run(["service", "status"]);
    if (!before.includes("supported: yes")) {
      throw new Error(`expected linux service support: ${before}`);
    }
  }

  const afterHook = run(["status"]);
  if (!afterHook.includes("claims:")) {
    throw new Error("status missing claims after hook");
  }

  console.log(run(["init", "--workspace", "luna", "--platform", "luna"]));
  const lunaStatus = run(["status", "--workspace", "luna"]);
  if (lunaStatus.includes("claims:   0")) {
    throw new Error("workspace init did not seed facts");
  }
  console.log(
    run([
      "remember",
      "Luna Client routes prompts through a local LLM client before the model call",
      "--workspace",
      "luna",
    ]),
  );
  const lunaCtx = run([
    "context",
    "How does Luna route prompts?",
    "--workspace",
    "luna",
    "--platform",
    "luna",
  ]);
  if (!lunaCtx.includes("Luna Client")) {
    throw new Error(`workspace context missed luna fact: ${lunaCtx}`);
  }
  const lunaApi = handleApi({
    method: "POST",
    pathname: "/api/context",
    searchParams: new URLSearchParams({ workspace: "luna" }),
    body: { query: "Luna routing", platform: "luna" },
    cwd: repoDir,
  });
  if (lunaApi.status !== 200 || !lunaApi.body.markdown) {
    throw new Error(`api/context?workspace=luna failed: ${JSON.stringify(lunaApi.body)}`);
  }

  const lunaBefore = handleApi({
    method: "GET",
    pathname: "/api/status",
    searchParams: new URLSearchParams({ workspace: "luna" }),
    body: null,
    cwd: repoDir,
  });
  const lunaRepoId = lunaBefore.body?.repo?.id;
  const lunaClaims = lunaBefore.body?.counts?.claims;
  if (!lunaRepoId || !lunaClaims) {
    throw new Error(`workspace status missing id/claims: ${JSON.stringify(lunaBefore.body)}`);
  }
  console.log(run(["rename", "Luna Client", "--workspace", "luna"]));
  const lunaRenamed = handleApi({
    method: "GET",
    pathname: "/api/status",
    searchParams: new URLSearchParams({ workspace: "luna" }),
    body: null,
    cwd: repoDir,
  });
  if (lunaRenamed.body?.repo?.id !== lunaRepoId) {
    throw new Error("rename changed workspace id");
  }
  if (lunaRenamed.body?.counts?.claims !== lunaClaims) {
    throw new Error("rename changed claim count");
  }
  if (lunaRenamed.body?.repo?.repo_name !== "Luna Client") {
    throw new Error(`rename did not update display name: ${lunaRenamed.body?.repo?.repo_name}`);
  }
  if (lunaRenamed.body?.slug !== "luna" || lunaRenamed.body?.kind !== "workspace") {
    throw new Error(`rename lost MCP slug: ${JSON.stringify({ slug: lunaRenamed.body?.slug, kind: lunaRenamed.body?.kind })}`);
  }
  const lunaAfterCtx = handleApi({
    method: "POST",
    pathname: "/api/context",
    searchParams: new URLSearchParams({ workspace: "luna" }),
    body: { query: "Luna routing", platform: "luna" },
    cwd: repoDir,
  });
  if (lunaAfterCtx.status !== 200 || !String(lunaAfterCtx.body.markdown || "").includes("Luna Client")) {
    throw new Error(`context after rename missed luna fact: ${JSON.stringify(lunaAfterCtx.body)}`);
  }
  const inventory = handleApi({
    method: "GET",
    pathname: "/api/repos",
    searchParams: new URLSearchParams(),
    body: null,
    cwd: repoDir,
  });
  const kinds = new Set((inventory.body?.repos || []).map((r) => r.kind));
  if (!kinds.has("git") || !kinds.has("workspace")) {
    throw new Error(`api/repos missing git/workspace kinds: ${JSON.stringify(inventory.body)}`);
  }

  function mcpRoundtrip(messages, framing, until) {
    const ready =
      until ??
      ((out) => out.includes("amem_context") && out.includes("amem_remember") && out.includes("amem_repos"));
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "mcp"], {
        cwd: repoDir,
        env: {
          ...process.env,
          AMEM_HOME: amemHome,
          AMEM_WORKSPACE: "luna",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`mcp ${framing} timeout: ${out.slice(0, 400)}`));
      }, 8000);
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else resolve(out);
      };
      child.stdout.on("data", (buf) => {
        out += buf.toString("utf8");
        const ok = typeof ready === "function" ? ready(out) : out.includes(ready);
        if (ok) finish();
      });
      child.stderr.on("data", (buf) => {
        out += buf.toString("utf8");
      });
      child.on("error", (err) => finish(err));
      for (const msg of messages) {
        const json = JSON.stringify(msg);
        if (framing === "ndjson") {
          child.stdin.write(`${json}\n`);
        } else {
          const payload = Buffer.from(json, "utf8");
          child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
          child.stdin.write(payload);
        }
      }
    });
  }

  const initAndList = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const ndjsonOut = await mcpRoundtrip(initAndList, "ndjson");
  if (!ndjsonOut.includes("amem_context") || !ndjsonOut.includes("amem_repos") || !ndjsonOut.includes("amem_stats")) {
    throw new Error(`ndjson mcp handshake failed: ${ndjsonOut}`);
  }
  const lspOut = await mcpRoundtrip(initAndList, "lsp");
  if (!lspOut.includes("amem_context")) {
    throw new Error(`lsp mcp handshake failed: ${lspOut}`);
  }

  const initMsg = initAndList[0];
  const inited = initAndList[1];
  const reposOut = await mcpRoundtrip(
    [
      initMsg,
      inited,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "amem_repos", arguments: {} },
      },
    ],
    "ndjson",
    "workspace",
  );
  if (!reposOut.includes("luna")) {
    throw new Error(`amem_repos missed workspace: ${reposOut}`);
  }
  const statsOut = await mcpRoundtrip(
    [
      initMsg,
      inited,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "amem_stats", arguments: { scope: "all" } },
      },
    ],
    "ndjson",
    "estimatedTokensSaved",
  );
  if (!statsOut.includes("estimatedTokensSaved")) {
    throw new Error(`amem_stats missing aggregate: ${statsOut}`);
  }

  const printed = run(["mcp", "--print-config", "--workspace", "luna"]);
  if (!printed.includes("/mcp?workspace=luna")) {
    throw new Error(`mcp --print-config missing http url: ${printed}`);
  }

  const apiAttest = handleApi({
    method: "GET",
    pathname: "/api/attest",
    searchParams: new URLSearchParams(),
    body: null,
    cwd: repoDir,
  });
  if (apiAttest.status !== 200 || apiAttest.body.tool !== "amem") {
    throw new Error("api/attest failed");
  }

  // Static UI present
  const { existsSync, utimesSync } = await import("node:fs");
  if (!existsSync(join(root, "ui-static", "index.html"))) {
    throw new Error("ui-static missing");
  }

  // --- FTS stemming: "booting" should still hit "Boot flow" ---
  const stemCtx = run(["context", "booting initializes", "--platform", "cursor"]);
  if (!stemCtx.includes("claim.boot_order")) {
    throw new Error("FTS/stem retrieval failed to find claim.boot_order for 'booting initializes'");
  }
  console.log("fts stem retrieval ok");

  // --- Staleness: advance anchor mtime past claim.updated_at ---
  const apiPath = join(repoDir, "src", "api.ts");
  const future = new Date(Date.now() + 120_000);
  utimesSync(apiPath, future, future);
  const staleCtx = run(["context", "api entry", "--platform", "cursor"]);
  if (!staleCtx.includes("Freshness: `stale`") && !staleCtx.includes("marked stale")) {
    throw new Error(`expected stale freshness marker in context, got:\n${staleCtx}`);
  }
  console.log("staleness ok");

  // --- Supersede: replace claim.api_entry, old id must leave retrieval ---
  const supersedeProposal = {
    claims: [
      {
        id: "claim.api_entry_v2",
        kind: "structure",
        text: "API entrypoint lives in src/api.ts (revised)",
        code_anchors: ["src/api.ts"],
        supersedes: ["claim.api_entry"],
      },
    ],
  };
  const supersedePath = join(amemHome, "supersede.json");
  writeFileSync(supersedePath, JSON.stringify(supersedeProposal, null, 2));
  const conflictValidate = run(["propose", "validate", supersedePath]);
  // v2 is intentional supersede — should be valid (warnings optional)
  if (!conflictValidate.includes("Proposal is valid")) {
    throw new Error(`supersede validate failed: ${conflictValidate}`);
  }
  const supersedeApply = run(["propose", "apply", supersedePath]);
  if (!supersedeApply.includes("superseded")) {
    throw new Error(`expected superseded count in apply output: ${supersedeApply}`);
  }
  const afterSupersede = run(["context", "API entrypoint", "--platform", "cursor"]);
  if (afterSupersede.includes("claim.api_entry\n") || afterSupersede.includes("### claim.api_entry\n")) {
    throw new Error("superseded claim.api_entry should not appear in context");
  }
  if (!afterSupersede.includes("claim.api_entry_v2")) {
    throw new Error("new claim.api_entry_v2 missing from context after supersede");
  }
  console.log("supersede ok");

  // Conflict warning without supersedes
  const conflictProposal = {
    claims: [
      {
        id: "claim.api_entry_alt",
        kind: "structure",
        text: "API entrypoint lives in src/api.ts (revised)",
        code_anchors: ["src/api.ts"],
      },
    ],
  };
  const conflictPath = join(amemHome, "conflict.json");
  writeFileSync(conflictPath, JSON.stringify(conflictProposal, null, 2));
  const conflictOut = run(["propose", "validate", conflictPath]);
  if (!conflictOut.includes("may conflict") && !conflictOut.includes("Warnings:")) {
    throw new Error(`expected conflict warning, got: ${conflictOut}`);
  }
  console.log("conflict warning ok");

  // Offboard wipe
  console.log(run(["wipe", "--all", "--yes"]));
  if (existsSync(amemHome)) {
    throw new Error("wipe --all should remove AMEM_HOME");
  }

  console.log("SMOKE OK");
} finally {
  rmSync(amemHome, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  for (const dir of extraDirs) rmSync(dir, { recursive: true, force: true });
}
