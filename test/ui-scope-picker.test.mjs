import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildScopeEntries,
  friendlyScopeLabel,
  groupScopeEntries,
  isTemporaryRepo,
  scopeSection,
} from "../ui-static/scope.js";

const repo = (repo_name, root_path, extra = {}) => ({ id: `${repo_name}:${root_path}`, repo_name, root_path, counts: { claims: 1 }, ...extra });
const ws = (slug, name = slug) =>
  repo(name, `/Users/me/.amem/workspaces/${slug}`, { kind: "workspace", slug, remote_url: `amem://workspace/${slug}` });

describe("scope picker classification", () => {
  it("puts scratch, temp and hash-named folders in Temporary", () => {
    for (const r of [
      repo("scratch-2026-11-20-cb6f91", "/Users/me/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-2026-11-20-cb6f91"),
      repo("tmp", "/private/tmp"),
      repo("data", "/tmp/x/data"),
      repo("T", "/private/var/folders/9q/abc/T"),
      repo("docketly-cursor-workspace", "/var/folders/9q/abc/T/docketly-cursor-workspace"),
      repo("ef19bdd79e44447a", "/Users/me/Library/Application Support/Undertone/workspaces/ef19bdd79e44447a"),
      repo("stashly", "/Users/me/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-2026-11-07-350179/stashly"),
      repo("scratchpad", "/private/tmp/claude-504/x/scratchpad"),
    ]) {
      assert.equal(isTemporaryRepo(r), true, r.root_path);
      assert.equal(scopeSection(r), "temporary", r.root_path);
    }
  });

  it("keeps real projects, workspaces and personal out of Temporary", () => {
    assert.equal(scopeSection(repo("amem", "/Users/me/GitHub/amem")), "projects");
    assert.equal(scopeSection(ws("stashly")), "workspaces");
    assert.equal(scopeSection(ws("personal", "Personal prefs")), "personal");
  });

  it("gives friendly labels to path-derived and hash-suffixed names", () => {
    assert.equal(friendlyScopeLabel({ ...ws("users-me-github-docklio"), root_path: "/Users/me/.amem/workspaces/users/me/github/docklio" }), "docklio");
    assert.equal(friendlyScopeLabel(ws("meetings-ef19bdd79e44447a")), "meetings");
    assert.equal(friendlyScopeLabel(ws("personal", "Personal prefs")), "Personal");
  });

  it("tells duplicate names apart", () => {
    const entries = buildScopeEntries([ws("stashly"), repo("stashly", "/Users/me/code/stashly")]);
    const hints = entries.map((e) => e.hint);
    assert.ok(hints.every(Boolean), "each duplicate gets a hint");
    assert.notEqual(hints[0], hints[1]);
  });

  it("groups into sections, pinned first, and filters by query", () => {
    const repos = [repo("amem", "/Users/me/GitHub/amem"), repo("pulse", "/Users/me/pulse"), ws("stashly"), repo("tmp", "/private/tmp")];
    const entries = buildScopeEntries(repos, { pinned: [repos[1].id] });
    const groups = groupScopeEntries(entries);
    const keys = groups.map((g) => g.key);
    assert.deepEqual(keys, ["personal", "pinned", "projects", "workspaces", "temporary"]);
    assert.deepEqual(groups[1].items.map((e) => e.label), ["pulse"]);
    assert.deepEqual(groups[2].items.map((e) => e.label), ["amem"]);
    assert.equal(groups[4].collapsible, true);
    const filtered = groupScopeEntries(entries, "stash");
    assert.deepEqual(filtered.flatMap((g) => g.items.map((e) => e.label)), ["stashly"]);
  });
});

describe("tab names", () => {
  const js = readFileSync(new URL("../ui-static/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../ui-static/index.html", import.meta.url), "utf8");
  it("uses one name per page and keeps old URLs working", () => {
    for (const t of ["memory", "insights", "settings", "activity", "dashboard", "tasks", "skills"]) {
      assert.match(html, new RegExp(`data-tab="${t}"`), t);
    }
    for (const old of ["brain", "analytics", "setup"]) assert.doesNotMatch(html, new RegExp(`data-tab="${old}"`));
    assert.match(js, /brain: "memory", setup: "settings", analytics: "insights", stats: "insights"/);
    assert.doesNotMatch(js, /<h1>Analytics<\/h1>/);
  });
  it("groups the sidebar and drops duplicate cross-links", () => {
    assert.match(html, /side-group-label">Overview/);
    assert.match(html, /side-group-label">Knowledge/);
    assert.doesNotMatch(js, />Open Memory</);
    assert.doesNotMatch(js, /data-go="dashboard">Dashboard</);
  });
});
