import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("remember rejects trivial text", () => {
  it("API refuses test / ok / hi", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo("remember-guard");
      const { upsertRepo } = await import("../dist/db.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const { handleApi } = await import("../dist/api/routes.js");
      const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");
      for (const text of ["test", "ok", "hi"]) {
        const res = handleApi({
          method: "POST",
          pathname: "/api/remember",
          searchParams: new URLSearchParams({ repo: repo.id }),
          body: { text, kind: "session" },
          cwd: repoDir,
        });
        assert.equal(res.status, 400, text);
      }
      const ok = handleApi({
        method: "POST",
        pathname: "/api/remember",
        searchParams: new URLSearchParams({ repo: repo.id }),
        body: {
          text: "Auth mode must be checked in src/auth.ts before enabling Drive sync",
          kind: "constraint",
          anchors: ["src/auth.ts"],
        },
        cwd: repoDir,
      });
      assert.equal(ok.status, 200);
    });
  });
});
