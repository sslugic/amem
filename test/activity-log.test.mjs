import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withAmemHome, makeGitRepo, root } from "./helpers.mjs";

/** Every value stored anywhere in activity_events, as one string. */
async function dumpActivity() {
  const { openDb } = await import("../dist/db.js");
  return JSON.stringify(openDb().prepare("SELECT * FROM activity_events").all());
}

describe("activity log", () => {
  it("records MCP tool calls with the client from initialize, metadata only", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("act-mcp");
      const { upsertRepo } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { dispatchMcp } = await import("../dist/mcp.js");
      const { listActivity } = await import("../dist/activity-log.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");

      dispatchMcp({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", clientInfo: { name: "claude-code", version: "2.1" } },
      });
      const secret = "Billing retries back off for 30 minutes in src/billing.ts zebra-canary";
      dispatchMcp({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "amem_remember", arguments: { text: secret, workspace: repo.repo_name } },
      });
      dispatchMcp({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "amem_context", arguments: { query: "how do billing retries zebra-canary", workspace: repo.repo_name } },
      });
      dispatchMcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "not_a_tool", arguments: {} } });

      const events = listActivity({ limit: 10 }).reverse();
      assert.equal(events.length, 3);
      assert.deepEqual(
        events.map((e) => [e.client, e.channel, e.action, e.direction]),
        [
          ["claude-code", "mcp", "amem_remember", "in"],
          ["claude-code", "mcp", "amem_context", "out"],
          ["claude-code", "mcp", "unknown_tool", "out"],
        ],
      );
      assert.equal(events[2].ok, false);
      assert.ok(events[1].resultBytes > 0, "context packet size is recorded");
      assert.ok(events.every((e) => Number.isInteger(e.latencyMs) && e.latencyMs >= 0));

      const all = await dumpActivity();
      assert.doesNotMatch(all, /zebra-canary|Billing retries|billing\.ts/, "no memory text or query reaches the log");
    });
  });

  it("logs hooks with injected context size but never the prompt", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("act-hook");
      const { upsertRepo } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { handleApi } = await import("../dist/api/routes.js");
      const { handleHookPayload } = await import("../dist/hook.js");
      const { listActivity } = await import("../dist/activity-log.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");
      handleApi({
        method: "POST",
        pathname: "/api/remember",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: { text: "Billing retries live in src/billing.ts and back off for 30 minutes", kind: "constraint", anchors: ["README.md"] },
        cwd: repoDir,
      });
      const prev = process.env.CLAUDE_PROJECT_DIR;
      process.env.CLAUDE_PROJECT_DIR = repoDir;
      try {
        handleHookPayload(
          JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: repoDir, session_id: "s1", prompt: "How do billing retries back off? walrus-canary" }),
        );
        handleHookPayload(JSON.stringify({ hook_event_name: "Stop", cwd: repoDir, session_id: "s1" }));
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = prev;
      }
      const [stop, prompt] = listActivity({ limit: 10 });
      assert.equal(prompt.client, "claude-code");
      assert.equal(prompt.channel, "hook");
      assert.equal(prompt.action, "hook beforeSubmitPrompt");
      assert.equal(prompt.direction, "out");
      assert.ok(prompt.resultBytes > 0);
      assert.equal(stop.action, "hook stop");
      assert.equal(stop.direction, "in");
      assert.doesNotMatch(await dumpActivity(), /walrus-canary/);
    });
  });

  it("keeps CLI free text out of the action name", async () => {
    const { cliAction } = await import("../dist/activity-log.js");
    assert.deepEqual(cliAction(["remember", "my secret fact"]), { action: "remember", direction: "in" });
    assert.deepEqual(cliAction(["tasks", "add", "Ship the thing"]), { action: "tasks add", direction: "in" });
    assert.deepEqual(cliAction(["tasks", "list"]), { action: "tasks list", direction: "out" });
    assert.deepEqual(cliAction(["context", "where is auth"]), { action: "context", direction: "out" });
    assert.equal(cliAction(["hook"]), null);
    assert.equal(cliAction(["mcp"]), null);
    assert.equal(cliAction(["uninstall"]), null, "logging after uninstall would recreate the store");
    assert.equal(cliAction(["Not A Command!"]), null);
  });

  it("normalises client names", async () => {
    const { normalizeClient } = await import("../dist/activity-log.js");
    assert.equal(normalizeClient("claude-code"), "claude-code");
    assert.equal(normalizeClient("claude-ai"), "claude-desktop");
    assert.equal(normalizeClient("cursor-vscode"), "cursor");
    assert.equal(normalizeClient("codex-mcp-client"), "codex");
    assert.equal(normalizeClient("Visual Studio Code"), "vscode");
    assert.equal(normalizeClient(""), "unknown");
    assert.equal(normalizeClient("<script>alert(1)</script>"), "scriptalert1script");
    assert.ok(normalizeClient("x".repeat(200)).length <= 32);
  });

  it("caps rows and honours the off switch", async () => {
    await withAmemHome(async () => {
      const { recordActivity, pruneActivity, listActivity } = await import("../dist/activity-log.js");
      for (let i = 0; i < 30; i++) {
        recordActivity({ client: "cli", channel: "cli", action: "status", direction: "out" });
      }
      pruneActivity({ maxRows: 10 });
      const kept = listActivity({ limit: 100 });
      assert.equal(kept.length, 10);
      assert.equal(kept[0].id, 30, "the newest rows survive");

      process.env.AMEM_ACTIVITY = "off";
      try {
        recordActivity({ client: "cli", channel: "cli", action: "status", direction: "out" });
      } finally {
        delete process.env.AMEM_ACTIVITY;
      }
      assert.equal(listActivity({ limit: 100 }).length, 10);
    });
  });

  it("summarises per client and lane, with measured savings kept apart from the estimate", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("act-sum");
      const { upsertRepo, insertUsageEvent, setUsageAttestation } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { recordActivity, activitySummary } = await import("../dist/activity-log.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");
      recordActivity({ client: "claude-code", channel: "mcp", action: "amem_context", direction: "out", resultBytes: 1000, latencyMs: 10 });
      recordActivity({ client: "claude-code", channel: "mcp", action: "amem_remember", direction: "in", latencyMs: 20 });
      recordActivity({ client: "claude-code", channel: "hook", action: "hook sessionStart", direction: "out", resultBytes: 500 });
      recordActivity({ client: "cursor", channel: "mcp", action: "amem_context", direction: "out", ok: false });

      const attested = insertUsageEvent({
        repoId: repo.id,
        platform: "claude",
        query: "q",
        claimIds: [],
        anchorsCount: 3,
        claimsCount: 0,
        packetTokens: 100,
        estimatedTokensSaved: 5000,
        anchors: ["a.ts", "b.ts", "c.ts"],
      });
      setUsageAttestation(attested.id, { anchorsOpened: ["a.ts"], answered: true, reportedTokensSaved: 1200 });
      insertUsageEvent({
        repoId: repo.id,
        platform: "claude",
        query: "q2",
        claimIds: [],
        anchorsCount: 1,
        claimsCount: 0,
        packetTokens: 50,
        estimatedTokensSaved: 700,
      });

      const s = activitySummary({ hours: 24 });
      assert.equal(s.totals.calls, 4);
      assert.equal(s.totals.errors, 1);
      const cc = s.clients.find((c) => c.client === "claude-code" && c.channel === "mcp");
      assert.equal(cc.in, 1);
      assert.equal(cc.out, 1);
      assert.equal(cc.bytesOut, 1000);
      assert.equal(cc.avgLatencyMs, 15);
      assert.ok(s.clients.find((c) => c.client === "claude-code" && c.channel === "hook"));

      assert.equal(s.savings.packets, 2);
      assert.equal(s.savings.measured.attestedEvents, 1);
      assert.equal(s.savings.measured.tokensSaved, 1200);
      assert.equal(s.savings.measured.fileReadsAvoided, 2);
      assert.equal(s.savings.measured.fileReadsStillOpened, 1);
      assert.equal(s.savings.estimate.tokensSaved, 5700);
      assert.equal(s.savings.basis, "modelled", "one attested packet is not enough to call it measured");
      assert.doesNotMatch(JSON.stringify(s), /faster|percent/i, "no invented speed figure");
    });
  });

  it("serves the API, the page and a live stream from the UI server", async () => {
    await withAmemHome(async () => {
      const { startUiServer } = await import("../dist/ui/server.js");
      const { recordActivity } = await import("../dist/activity-log.js");
      const server = await startUiServer({ port: 0, openBrowser: false });
      const base = `http://127.0.0.1:${server.port}`;
      try {
        const health = await (await fetch(`${base}/api/health`)).json();
        assert.ok(health.features.includes("activity"));

        for (const path of ["/activity", "/activity/mini"]) {
          const page = await fetch(`${base}${path}`);
          assert.equal(page.status, 200);
          assert.match(await page.text(), /activity\.js/);
        }

        const ctrl = new AbortController();
        const res = await fetch(`${base}/api/activity/stream`, { signal: ctrl.signal });
        assert.match(res.headers.get("content-type"), /text\/event-stream/);
        assert.equal(res.headers.get("access-control-allow-origin"), null, "stream is same-origin only");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        const deadline = Date.now() + 5000;
        let wrote = false;
        while (!/event: activity/.test(text) && Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value);
          if (!wrote && /event: hello/.test(text)) {
            recordActivity({ client: "codex-mcp-client", channel: "mcp", action: "amem_context", direction: "out", resultBytes: 42 });
            wrote = true;
          }
        }
        ctrl.abort();
        assert.match(text, /event: activity/);
        const data = JSON.parse(/event: activity\ndata: (.*)\n/.exec(text)[1]);
        assert.equal(data.client, "codex");
        assert.equal(data.resultBytes, 42);

        const list = await (await fetch(`${base}/api/activity?limit=5`)).json();
        assert.equal(list.events.length, 1);
        const summary = await (await fetch(`${base}/api/activity/summary?hours=1`)).json();
        assert.equal(summary.totals.calls, 1);
      } finally {
        await server.close().catch(() => undefined);
      }
    });
  });

  it("the page escapes client-supplied names and has a compact mode", () => {
    const js = readFileSync(join(root, "ui-static", "activity.js"), "utf8");
    assert.match(js, /function esc\(/);
    assert.match(js, /\/mini/);
    assert.match(js, /compact/);
    const html = readFileSync(join(root, "ui-static", "activity.html"), "utf8");
    assert.match(html, /metadata only/);
  });
});
