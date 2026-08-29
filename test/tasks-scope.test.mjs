/**
 * Agents file tasks against whatever repo they were working in. If the UI only ever asks
 * for the launch folder's tasks, everything an agent parked elsewhere is invisible — which
 * is exactly what happened to a board full of real tasks.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withAmemHome, makeGitRepo, root } from "./helpers.mjs";

function call(method, pathname, { qs = "", body = null, cwd = process.cwd() } = {}) {
  return import("../dist/api/routes.js").then(({ handleApi }) => {
    const res = handleApi({
      method,
      pathname,
      searchParams: new URLSearchParams(qs),
      body,
      cwd,
    });
    return { status: res.status, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
  });
}

async function makeRepo(name, cwdDir) {
  const { upsertRepo } = await import("../dist/db.js");
  const { detectRepoIdentity } = await import("../dist/repo-identity.js");
  return upsertRepo(detectRepoIdentity(cwdDir), "cursor");
}

describe("tasks across memories", () => {
  it("finds tasks filed against another memory only in all scope", async () => {
    await withAmemHome(async () => {
      const hereDir = makeGitRepo("tasks-here");
      const otherDir = makeGitRepo("tasks-other");
      const here = await makeRepo("here", hereDir);
      const other = await makeRepo("other", otherDir);
      const { insertTask } = await import("../dist/db.js");

      insertTask({ repoId: other.id, title: "3C-01 Stored invalid individual tax", source: "mcp" });
      insertTask({ repoId: other.id, title: "3C-02 Stored invalid business ID", source: "mcp" });
      insertTask({ repoId: here.id, title: "local task", source: "ui" });

      // The launch folder's board: only its own task, which is why the others "vanished".
      const scoped = await call("GET", "/api/tasks", { qs: "include_done=1", cwd: hereDir });
      assert.equal(scoped.status, 200);
      assert.equal(scoped.body.scope, "current");
      assert.deepEqual(
        scoped.body.tasks.map((t) => t.title),
        ["local task"],
      );

      const all = await call("GET", "/api/tasks", { qs: "include_done=1&scope=all", cwd: hereDir });
      assert.equal(all.status, 200);
      assert.equal(all.body.scope, "all");
      const titles = all.body.tasks.map((t) => t.title);
      assert.equal(titles.length, 3);
      for (const t of ["3C-01 Stored invalid individual tax", "3C-02 Stored invalid business ID"]) {
        assert.ok(titles.includes(t), `all scope must surface "${t}"`);
      }
      assert.equal(all.body.counts.open, 3, "counts must follow the same scope as the list");
    });
  });

  it("names the owning memory so cross-memory cards are not ambiguous", async () => {
    await withAmemHome(async () => {
      const hereDir = makeGitRepo("tasks-label-here");
      const otherDir = makeGitRepo("tasks-label-other");
      await makeRepo("here", hereDir);
      const other = await makeRepo("other", otherDir);
      const { insertTask } = await import("../dist/db.js");
      insertTask({ repoId: other.id, title: "filed elsewhere", source: "mcp" });

      const all = await call("GET", "/api/tasks", { qs: "scope=all", cwd: hereDir });
      const card = all.body.tasks.find((t) => t.title === "filed elsewhere");
      assert.ok(card, "task must be present");
      assert.equal(card.repo_id, other.id);
      assert.ok(card.repo_name, "all scope must label the owning memory");
    });
  });

  it("can move, complete, and delete a task that lives in another memory", async () => {
    await withAmemHome(async () => {
      const hereDir = makeGitRepo("tasks-edit-here");
      const otherDir = makeGitRepo("tasks-edit-other");
      await makeRepo("here", hereDir);
      const other = await makeRepo("other", otherDir);
      const { insertTask, getTask } = await import("../dist/db.js");

      const moved = insertTask({ repoId: other.id, title: "move me", source: "mcp" });
      const done = insertTask({ repoId: other.id, title: "finish me", source: "mcp" });
      const gone = insertTask({ repoId: other.id, title: "delete me", source: "mcp" });

      const patch = await call("PATCH", "/api/tasks", {
        qs: "scope=all",
        body: { id: moved.id, status: "doing" },
        cwd: hereDir,
      });
      assert.equal(patch.status, 200);
      assert.equal(patch.body.task.status, "doing");
      assert.equal(getTask(other.id, moved.id).status, "doing");

      const complete = await call("POST", "/api/tasks/complete", {
        qs: "scope=all",
        body: { id: done.id },
        cwd: hereDir,
      });
      assert.equal(complete.status, 200);
      assert.equal(getTask(other.id, done.id).status, "done");

      const del = await call("DELETE", "/api/tasks", {
        qs: `scope=all&id=${gone.id}`,
        cwd: hereDir,
      });
      assert.equal(del.status, 200);
      assert.equal(getTask(other.id, gone.id), null);
    });
  });

  it("refuses to touch another memory's task from a scoped board", async () => {
    await withAmemHome(async () => {
      const hereDir = makeGitRepo("tasks-guard-here");
      const otherDir = makeGitRepo("tasks-guard-other");
      await makeRepo("here", hereDir);
      const other = await makeRepo("other", otherDir);
      const { insertTask, getTask } = await import("../dist/db.js");
      const foreign = insertTask({ repoId: other.id, title: "not yours", source: "mcp" });

      // Without scope=all the board is one memory; it must not reach across.
      for (const [method, path, opts] of [
        ["PATCH", "/api/tasks", { body: { id: foreign.id, status: "doing" } }],
        ["POST", "/api/tasks/complete", { body: { id: foreign.id } }],
        ["DELETE", "/api/tasks", { qs: `id=${foreign.id}` }],
      ]) {
        const res = await call(method, path, { ...opts, cwd: hereDir });
        assert.equal(res.status, 404, `${method} ${path} must not cross memories when scoped`);
      }
      assert.equal(getTask(other.id, foreign.id).status, "backlog", "foreign task untouched");
    });
  });

  it("still creates new tasks in the current memory", async () => {
    await withAmemHome(async () => {
      const hereDir = makeGitRepo("tasks-create");
      const here = await makeRepo("here", hereDir);

      const res = await call("POST", "/api/tasks", {
        qs: "scope=all",
        body: { title: "brand new", status: "backlog", source: "ui" },
        cwd: hereDir,
      });
      assert.equal(res.status, 200);
      // An all-memory board still has to file new work somewhere concrete.
      assert.equal(res.body.task.repo_id, here.id);
    });
  });
});

describe("tasks UI scope wiring", () => {
  const app = readFileSync(join(root, "ui-static", "app.js"), "utf8");

  it("opens the Tasks tab across all memory", () => {
    assert.match(
      app,
      /tab === "tasks"[\s\S]{0,320}state\.brainAll = true/,
      "the Tasks tab must default to all memory or agent-filed tasks stay hidden",
    );
  });

  it("shows the owning memory and offers a scope toggle", () => {
    assert.match(app, /tasks-card-repo/, "cards need a memory badge in all scope");
    assert.match(app, /tasksScope/, "the board needs a scope toggle");
    assert.match(app, /Show this folder only|Show all memory/);
  });

  it("styles the memory badge", () => {
    const css = readFileSync(join(root, "ui-static", "styles.css"), "utf8");
    assert.match(css, /\.tasks-card-repo\s*\{/, "the badge needs styling or it renders raw");
  });
});
