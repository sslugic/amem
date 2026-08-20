import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
  validateProposal,
  findConflictWarnings,
  collectSupersedeTargets,
  applyProposal,
} from "../dist/proposal.js";
import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("proposal validate / supersede / conflict", () => {
  it("rejects empty and incomplete claims", () => {
    const empty = validateProposal({});
    assert.equal(empty.ok, false);
    assert.ok(empty.errors.some((e) => /empty/i.test(e)));

    const bad = validateProposal({
      claims: [{ id: "claim.x", kind: "", text: "", code_anchors: [] }],
    });
    assert.equal(bad.ok, false);
  });

  it("rejects self-supersede", () => {
    const result = validateProposal({
      claims: [
        {
          id: "claim.x",
          kind: "structure",
          text: "hello world fact",
          code_anchors: ["src/api.ts"],
          supersedes: ["claim.x"],
        },
      ],
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /cannot supersede itself/i.test(e)));
  });

  it("collects supersedes from claims and edges", () => {
    const map = collectSupersedeTargets({
      claims: [{ id: "claim.new", kind: "x", text: "t", supersedes: ["claim.old"] }],
      edges: [
        {
          from_id: "claim.newer",
          from_type: "claim",
          to_id: "claim.older",
          to_type: "claim",
          kind: "supersedes",
        },
      ],
    });
    assert.equal(map.get("claim.old"), "claim.new");
    assert.equal(map.get("claim.older"), "claim.newer");
  });

  it("warns on shared-anchor text conflicts", () => {
    const existing = [
      {
        repo_id: "r",
        id: "claim.a",
        kind: "structure",
        text: "API entrypoint lives in src/api.ts",
        code_anchors: JSON.stringify(["src/api.ts"]),
        source_ref: null,
        created_at: "2020-01-01T00:00:00.000Z",
        updated_at: "2020-01-01T00:00:00.000Z",
        status: "active",
        superseded_by: null,
        pinned: 0,
      },
    ];
    const warnings = findConflictWarnings(
      {
        claims: [
          {
            id: "claim.b",
            kind: "structure",
            text: "API entrypoint lives in src/api.ts (copy)",
            code_anchors: ["src/api.ts"],
          },
        ],
      },
      existing,
    );
    assert.ok(warnings.some((w) => /conflict/i.test(w)));
  });

  it("does not warn when supersedes is set", () => {
    const existing = [
      {
        repo_id: "r",
        id: "claim.a",
        kind: "structure",
        text: "API entrypoint lives in src/api.ts",
        code_anchors: JSON.stringify(["src/api.ts"]),
        source_ref: null,
        created_at: "2020-01-01T00:00:00.000Z",
        updated_at: "2020-01-01T00:00:00.000Z",
        status: "active",
        superseded_by: null,
        pinned: 0,
      },
    ];
    const warnings = findConflictWarnings(
      {
        claims: [
          {
            id: "claim.b",
            kind: "structure",
            text: "API entrypoint lives in src/api.ts (copy)",
            code_anchors: ["src/api.ts"],
            supersedes: ["claim.a"],
          },
        ],
      },
      existing,
    );
    assert.equal(warnings.length, 0);
  });

  it("applyProposal marks superseded and keeps winner active", async () => {
    await withAmemHome(async () => {
      const repoDir = makeGitRepo();
      try {
        const { detectRepoIdentity } = await import("../dist/repo-identity.js");
        const { upsertRepo, listClaims } = await import("../dist/db.js");
        const repo = upsertRepo(detectRepoIdentity(repoDir), "cursor");

        applyProposal(repo.id, {
          claims: [
            {
              id: "claim.v1",
              kind: "structure",
              text: "API entrypoint lives in src/api.ts",
              code_anchors: ["src/api.ts"],
            },
          ],
        });
        assert.equal(listClaims(repo.id).length, 1);

        const result = applyProposal(repo.id, {
          claims: [
            {
              id: "claim.v2",
              kind: "structure",
              text: "API entrypoint lives in src/api.ts (v2)",
              code_anchors: ["src/api.ts"],
              supersedes: ["claim.v1"],
            },
          ],
        });
        assert.equal(result.superseded, 1);
        const active = listClaims(repo.id);
        assert.equal(active.length, 1);
        assert.equal(active[0].id, "claim.v2");
        const all = listClaims(repo.id, { includeSuperseded: true });
        assert.equal(all.length, 2);
        const old = all.find((c) => c.id === "claim.v1");
        assert.equal(old.status, "superseded");
        assert.equal(old.superseded_by, "claim.v2");
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});
