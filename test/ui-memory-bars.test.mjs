import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileRows, isStaleClaim, memoryRows } from "../ui-static/memory-bars.js";

const now = Date.parse("2026-11-26T12:00:00Z");
const repos = [
  { id: "p", repo_name: "Personal prefs", slug: "personal", kind: "workspace", personal: true, root_path: "/Users/me/.amem/workspaces/personal", remote_url: "amem://workspace/personal" },
  { id: "a", repo_name: "amem", root_path: "/Users/me/GitHub/amem" },
  { id: "b", repo_name: "pulse", root_path: "/Users/me/pulse" },
  { id: "w", repo_name: "stashly", slug: "stashly", kind: "workspace", root_path: "/Users/me/.amem/workspaces/stashly", remote_url: "amem://workspace/stashly" },
  { id: "t", repo_name: "scratch-2026-11-20-cb6f91", root_path: "/Users/me/Library/Application Support/Claude/scratch-workspaces/x/scratch-2026-11-20-cb6f91" },
];
const fact = (id, repo_id, extra = {}) => ({ id, repo_id, text: id, updated_at: "2026-11-20T00:00:00Z", code_anchors: "[]", ...extra });

describe("memory overview", () => {
  it("one row per memory, grouped like the scope picker, temporary collapsible", () => {
    const claims = [fact("1", "a"), fact("2", "a"), fact("3", "b"), fact("4", "p"), fact("5", "w"), fact("6", "t")];
    const { sections, max } = memoryRows(claims, repos, { now });
    assert.deepEqual(sections.map((s) => s.key), ["personal", "projects", "workspaces", "temporary"]);
    assert.equal(max, 2);
    assert.deepEqual(sections[1].rows.map((r) => [r.label, r.facts]), [["amem", 2], ["pulse", 1]]);
    assert.equal(sections[0].rows[0].label, "Personal");
    assert.equal(sections[3].collapsible, true);
    assert.equal(sections[1].rows[0].path, "/Users/me/GitHub/amem");
  });

  it("counts pinned, stale and recent use, and sorts by recent activity", () => {
    const claims = [
      fact("1", "a", { pinned: 1 }),
      fact("2", "a", { updated_at: "2026-01-01T00:00:00Z" }),
      fact("3", "b", { updated_at: "2026-11-25T00:00:00Z" }),
    ];
    const { sections } = memoryRows(claims, repos, { hotIds: ["3"], now, sort: "recent" });
    const [first, second] = sections[0].rows;
    assert.equal(first.label, "pulse");
    assert.equal(first.used, true);
    assert.equal(second.pinned, 1);
    assert.equal(second.stale, 1);
  });

  it("stale skips pinned and recently used facts", () => {
    const old = { id: "x", updated_at: "2025-01-01T00:00:00Z" };
    assert.equal(isStaleClaim(old, new Set(), now), true);
    assert.equal(isStaleClaim({ ...old, pinned: 1 }, new Set(), now), false);
    assert.equal(isStaleClaim(old, new Set(["x"]), now), false);
  });

  it("level 2 lists anchored files with a row for facts without one", () => {
    const claims = [
      fact("1", "a", { code_anchors: JSON.stringify(["src/ui/server.ts", "README.md"]) }),
      fact("2", "a", { code_anchors: JSON.stringify(["src/ui/server.ts"]) }),
      fact("3", "a"),
    ];
    const { rows, max } = fileRows(claims, { now });
    assert.equal(max, 2);
    assert.deepEqual(rows.map((r) => [r.label, r.facts]), [["ui/server.ts", 2], ["(no file yet)", 1], ["README.md", 1]]);
  });
});
