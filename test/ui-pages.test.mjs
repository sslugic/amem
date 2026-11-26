import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clusterDuplicatePairs, exactDuplicateGroups, normalizeFactText } from "../ui-static/dupes.js";

// Windows checkouts may use CRLF; the function extractor below expects LF.
const js = readFileSync(new URL("../ui-static/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const html = readFileSync(new URL("../ui-static/index.html", import.meta.url), "utf8");

/** Pull a top-level function out of app.js and evaluate it on its own. */
function loadFn(name, deps = {}) {
  const start = js.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = js.indexOf("\n}\n", start) + 2;
  const src = js.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), `${src}; return ${name};`)(...Object.values(deps));
}

describe("duplicate facts", () => {
  it("normalizes case, punctuation and a leading date", () => {
    assert.equal(normalizeFactText("2026-11-01: Use  PNPM, not npm!"), "use pnpm not npm");
  });

  it("groups exact duplicates per memory and keeps the newest", () => {
    const claims = [
      { id: "a", repo_id: "r1", text: "Deploy with make release please", updated_at: "2026-01-01" },
      { id: "b", repo_id: "r1", text: "deploy with make release, please", updated_at: "2026-02-01" },
      { id: "c", repo_id: "r2", text: "Deploy with make release please", updated_at: "2026-03-01" },
      { id: "d", repo_id: "r1", text: "Something else entirely here", updated_at: "2026-01-01" },
    ];
    const groups = exactDuplicateGroups(claims);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 2);
    assert.equal(groups[0].keep.id, "b");
    assert.deepEqual(groups[0].drop.map((c) => c.id), ["a"]);
  });

  it("clusters chained near-duplicate pairs", () => {
    const clusters = clusterDuplicatePairs([
      { keepId: "a", dropId: "b", similarity: 0.9 },
      { keepId: "a", dropId: "c", similarity: 0.8 },
      { keepId: "x", dropId: "y", similarity: 0.75 },
    ]);
    assert.equal(clusters.length, 2);
    assert.equal(clusters[0].keepId, "a");
    assert.equal(clusters[0].count, 3);
    assert.deepEqual(clusters[0].dropIds.sort(), ["b", "c"]);
  });
});

describe("number formatting", () => {
  it("is compact from 10K up", () => {
    const formatTokens = loadFn("formatTokens");
    assert.equal(formatTokens(9876), (9876).toLocaleString());
    assert.equal(formatTokens(23_456), "23.5K");
    assert.equal(formatTokens(198_202), "198K");
    assert.equal(formatTokens(23_456_789), "23.5M");
    assert.equal(formatTokens(745_484_717), "745M");
    assert.equal(formatTokens(1_800_000_000), "1.8B");
  });
});

describe("agent question labels", () => {
  it("turns agent markup into readable text", () => {
    const prettyQuery = loadFn("prettyQuery");
    assert.equal(
      prettyQuery('<cross-session-message from="local_1" from-name="Release bot">\nShip it'),
      "Message from Release bot: Ship it",
    );
    assert.equal(prettyQuery('<~cross-session-message from="local_1">hi'), "Message from another session: hi");
    assert.equal(prettyQuery("<scheduled-task name=x>run</scheduled-task>"), "Scheduled task run");
    assert.equal(prettyQuery("how do we deploy?"), "how do we deploy?");
  });
});

describe("page cleanup", () => {
  it("Home stat cards have a label, a number and a trend", () => {
    const home = js.slice(js.indexOf("function renderDashboard("), js.indexOf("function renderAnalytics("));
    assert.match(home, /class="stat-label"/);
    assert.match(home, /class="stat-num"/);
    assert.match(home, /this week/);
  });

  it("Memory keeps search primary and tools in a menu", () => {
    assert.match(html, /id="topMore"/);
    const menu = html.slice(html.indexOf('id="topMore"'), html.indexOf("</details>", html.indexOf('id="topMore"')));
    for (const id of ["tryRetrievalBtn", "showdownToggle", "autoApplyAll"]) assert.match(menu, new RegExp(`id="${id}"`));
  });

  it("Skills lists installed first and groups pending by skill", () => {
    const skills = js.slice(js.indexOf("function renderSkills("), js.indexOf("function currentRepoLabel("));
    assert.ok(skills.indexOf("Installed") < skills.indexOf("${draftsHtml}"));
    assert.match(js, /function skillDraftGroups/);
    assert.match(skills, /skill-group-dismiss/);
    assert.match(skills, /Write it up|skill-group-write/);
  });

  it("Tasks clamps titles, collapses Done and filters by project", () => {
    const tasks = js.slice(js.indexOf("function renderTasks("), js.indexOf("function greeting("));
    assert.match(js, /class="tasks-card-title"/);
    assert.match(tasks, /tasksDoneOpen/);
    assert.match(tasks, /id="tasksProject"/);
    assert.match(js, /Drag a task here to start\./);
  });

  it("Insights leads with headline metrics and hides methodology", () => {
    const insights = js.slice(js.indexOf("function renderAnalytics("), js.indexOf("const HIT_COLOR"));
    assert.match(insights, /class="metric-row"/);
    assert.match(insights, /How these are calculated/);
    assert.match(insights, /Details: monthly projection/);
    assert.match(insights, /hbar-list/);
    assert.doesNotMatch(insights, /id="platformList"/);
  });

  it("Settings has a sub-nav for every section", () => {
    for (const id of ["apps", "backup", "encryption", "projects", "check", "plan"]) {
      assert.match(js, new RegExp(`id: "${id}"`), id);
      assert.match(js, new RegExp(`id="set-${id}"`), id);
    }
    assert.match(js, /function vaultStatusLine/);
  });
});
