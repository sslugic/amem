import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("agent tasks kanban", () => {
  it("CRUD helpers create, list, move, complete, delete", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const {
        upsertRepo,
        insertTask,
        listTasks,
        updateTask,
        completeTask,
        deleteTask,
        getTask,
        countTasks,
        listOpenTasksForContext,
        closeDb,
      } = await import("../dist/db.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");

      const a = insertTask({
        repoId: repo.id,
        title: "Ship Tasks tab",
        body: "Kanban for deferred agent work",
        status: "backlog",
        anchors: ["src/db.ts"],
        source: "test",
      });
      assert.equal(a.status, "backlog");
      assert.match(a.id, /^task_/);

      insertTask({ repoId: repo.id, title: "Other", status: "next" });
      assert.equal(listTasks(repo.id).length, 2);
      assert.equal(countTasks(repo.id, { openOnly: true }), 2);

      const moved = updateTask(repo.id, a.id, { status: "doing" });
      assert.equal(moved.status, "doing");

      const open = listOpenTasksForContext(repo.id, 8);
      assert.ok(open.some((t) => t.id === a.id));
      assert.equal(open[0].status, "doing");

      const done = completeTask(repo.id, a.id);
      assert.equal(done.status, "done");
      assert.ok(done.completed_at);
      assert.equal(listTasks(repo.id).length, 1);
      assert.equal(listTasks(repo.id, { includeDone: true }).length, 2);

      assert.equal(deleteTask(repo.id, a.id), true);
      assert.equal(getTask(repo.id, a.id), null);
      closeDb();
    });
  });

  it("API routes list/create/patch/complete/delete and context injects open tasks", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo, closeDb } = await import("../dist/db.js");
      const { handleApi } = await import("../dist/api/routes.js");
      const { buildContext, renderContextMarkdown } = await import("../dist/context.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");

      const created = handleApi({
        method: "POST",
        pathname: "/api/tasks",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: { title: "Verify deploy", body: "check /admin", status: "next", source: "test" },
        cwd: repoDir,
      });
      assert.equal(created.status, 200);
      const id = created.body.task.id;

      const listed = handleApi({
        method: "GET",
        pathname: "/api/tasks",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: null,
        cwd: repoDir,
      });
      assert.equal(listed.status, 200);
      assert.equal(listed.body.tasks.length, 1);
      assert.equal(listed.body.counts.next, 1);

      const patched = handleApi({
        method: "PATCH",
        pathname: "/api/tasks",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: { id, status: "blocked" },
        cwd: repoDir,
      });
      assert.equal(patched.status, 200);
      assert.equal(patched.body.task.status, "blocked");

      const packet = buildContext(repo.id, "deploy admin", { rootPath: repoDir });
      assert.ok(packet.tasks.some((t) => t.id === id));
      const md = renderContextMarkdown(packet);
      assert.match(md, /Open tasks/);
      assert.match(md, /Verify deploy/);

      const completed = handleApi({
        method: "POST",
        pathname: "/api/tasks/complete",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: { id },
        cwd: repoDir,
      });
      assert.equal(completed.status, 200);
      assert.equal(completed.body.task.status, "done");

      const deleted = handleApi({
        method: "DELETE",
        pathname: "/api/tasks",
        searchParams: new URLSearchParams({ repo: repo.id, id }),
        body: null,
        cwd: repoDir,
      });
      assert.equal(deleted.status, 200);
      closeDb();
    });
  });

  it("context retrieval surfaces relevant completed tasks when queried", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { upsertRepo, insertTask, completeTask, closeDb } = await import("../dist/db.js");
      const { buildContext, renderContextMarkdown } = await import("../dist/context.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");

      const t1 = insertTask({ repoId: repo.id, title: "Configure Stripe webhooks", body: "payment integration", status: "doing" });
      const t2 = insertTask({ repoId: repo.id, title: "Refactor auth tokens", body: "JWT secret rotation", status: "doing" });
      completeTask(repo.id, t2.id);

      // Query about auth should surface the completed auth task
      const packet = buildContext(repo.id, "auth tokens", { rootPath: repoDir });
      assert.ok(packet.tasks.some((t) => t.id === t2.id && t.status === "done"));
      const md = renderContextMarkdown(packet);
      assert.match(md, /Refactor auth tokens/);
      assert.match(md, /\[done\]/);
      closeDb();
    });
  });

  it("bundles and copies amem-tasks skill to skills folder", async () => {
    await withAmemHome(async () => {
      const { copyBundledSkills } = await import("../dist/install/skills.js");
      const target = makeGitRepo("test-skills");
      const installed = copyBundledSkills(target);
      assert.ok(installed.some((p) => p.endsWith("amem-tasks")));
      assert.ok(installed.some((p) => p.endsWith("amem-bootstrap")));
      assert.ok(installed.some((p) => p.endsWith("amem-update-working-memory")));
    });
  });
});
