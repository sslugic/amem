import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAnchors,
  assessClaimFreshness,
  freshnessScoreMultiplier,
} from "../dist/freshness.js";
import { claimFixture, makeGitRepo, touchFuture } from "./helpers.mjs";
import { rmSync } from "node:fs";
import { join } from "node:path";

describe("freshness", () => {
  it("parses anchors and ignores bad json", () => {
    assert.deepEqual(parseAnchors('["a.ts","b.ts"]'), ["a.ts", "b.ts"]);
    assert.deepEqual(parseAnchors("not-json"), []);
    assert.deepEqual(parseAnchors('{"x":1}'), []);
  });

  it("marks unanchored and unknown", () => {
    const bare = claimFixture({ code_anchors: "[]" });
    assert.equal(assessClaimFreshness("/tmp", bare).status, "unanchored");
    const withAnchors = claimFixture();
    assert.equal(assessClaimFreshness(undefined, withAnchors).status, "unknown");
    assert.equal(
      assessClaimFreshness("/tmp", claimFixture({ updated_at: "not-a-date" })).status,
      "unknown",
    );
  });

  it("detects fresh vs stale vs missing", () => {
    const repo = makeGitRepo();
    try {
      const nowIso = new Date().toISOString();
      const claim = claimFixture({
        updated_at: nowIso,
        code_anchors: JSON.stringify(["src/api.ts"]),
      });
      assert.equal(assessClaimFreshness(repo, claim).status, "fresh");

      touchFuture(join(repo, "src", "api.ts"));
      const stale = assessClaimFreshness(repo, claim);
      assert.equal(stale.status, "stale");
      assert.ok(stale.staleAnchors.includes("src/api.ts"));

      const missing = assessClaimFreshness(
        repo,
        claimFixture({
          updated_at: nowIso,
          code_anchors: JSON.stringify(["src/does-not-exist.ts"]),
        }),
      );
      assert.equal(missing.status, "missing_anchor");

      const workspaceAnchor = assessClaimFreshness(
        repo,
        claimFixture({
          updated_at: nowIso,
          code_anchors: JSON.stringify(["luna-ai"]),
        }),
      );
      assert.equal(workspaceAnchor.status, "unanchored");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("score multipliers downrank stale/missing", () => {
    assert.equal(freshnessScoreMultiplier("fresh"), 1);
    assert.ok(freshnessScoreMultiplier("stale") < freshnessScoreMultiplier("fresh"));
    assert.ok(freshnessScoreMultiplier("missing_anchor") < 1);
  });
});
