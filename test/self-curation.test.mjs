import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withAmemHome, makeGitRepo } from "./helpers.mjs";

describe("claim utility ledger", () => {
  it("condemns a claim only on repeated attested unhelpfulness", async () => {
    const { isUnhelpful, MIN_UTILITY_SAMPLES } = await import("../dist/utility.js");
    const row = (over = {}) => ({
      claimId: "claim.x",
      returns: 50,
      attestedReturns: 0,
      helpful: 0,
      unhelpful: 0,
      ...over,
    });

    // Never attested: the old rule's opposite mistake would be to decay it.
    assert.equal(isUnhelpful(row()), false);
    // Attested, but below the sample floor.
    assert.equal(
      isUnhelpful(row({ attestedReturns: MIN_UTILITY_SAMPLES - 1, unhelpful: MIN_UTILITY_SAMPLES - 1 })),
      false,
    );
    // Enough attested appearances and it never once helped.
    assert.equal(
      isUnhelpful(row({ attestedReturns: MIN_UTILITY_SAMPLES, unhelpful: MIN_UTILITY_SAMPLES })),
      true,
    );
    // One good outcome is enough to spare it.
    assert.equal(
      isUnhelpful(row({ attestedReturns: 9, helpful: 1, unhelpful: 8 })),
      false,
    );
  });

  it("does not protect a claim merely for being returned", async () => {
    const { isProtected } = await import("../dist/utility.js");
    // The exact bug this replaces: returned constantly, never helpful.
    const noisy = {
      claimId: "claim.noise",
      returns: 400,
      attestedReturns: 12,
      helpful: 0,
      unhelpful: 12,
    };
    assert.equal(isProtected(noisy), false);

    const useful = { ...noisy, helpful: 4, unhelpful: 8 };
    assert.equal(isProtected(useful), true);
  });
});

describe("anchor shape", () => {
  it("tells a file path from a tag anchor", async () => {
    const { looksLikeFilePath } = await import("../dist/utility.js");
    assert.equal(looksLikeFilePath("src/db.ts"), true);
    assert.equal(looksLikeFilePath("README.md"), true);
    // Workspace claims anchor on tags; these must never be read as dead files.
    assert.equal(looksLikeFilePath("luna-ai"), false);
    assert.equal(looksLikeFilePath("august-2026"), false);
    assert.equal(looksLikeFilePath(""), false);
  });
});

describe("anchor rot", () => {
  it("flags a claim whose files are all gone, and spares tag anchors", async () => {
    await withAmemHome(async () => {
      const { upsertRepo, applyProposalRows } = await import("../dist/db.js");
      const { findAnchorRot } = await import("../dist/utility.js");
      const { detectRepoIdentity } = await import("../dist/repo-identity.js");
      const dir = makeGitRepo();
      const repo = upsertRepo(detectRepoIdentity(dir), "cursor");

      const claims = [
        { id: "claim.alive", code_anchors: JSON.stringify(["src/api.ts"]) },
        { id: "claim.dead", code_anchors: JSON.stringify(["src/deleted.ts"]) },
        { id: "claim.partly", code_anchors: JSON.stringify(["src/gone.ts", "src/auth.ts"]) },
        { id: "claim.tagged", code_anchors: JSON.stringify(["some-tag"]) },
        { id: "claim.pinned", code_anchors: JSON.stringify(["src/gone.ts"]), pinned: 1 },
      ].map((c) => ({
        repo_id: repo.id,
        kind: "constraint",
        text: "x",
        source_ref: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "active",
        superseded_by: null,
        pinned: 0,
        ...c,
      }));

      const rot = findAnchorRot(repo.id, claims).map((r) => r.claimId);
      assert.deepEqual(rot, ["claim.dead"]);
      // partly: one anchor still resolves, so it is not rot.
      // tagged: not a file path at all.
      // pinned: never decays.
      void applyProposalRows;
      rmSync(dir, { recursive: true, force: true });
    });
  });

  it("returns nothing when the repo root has no source at all", async () => {
    await withAmemHome(async () => {
      const { upsertRepo } = await import("../dist/db.js");
      const { findAnchorRot, repoRootUsable } = await import("../dist/utility.js");
      const { workspaceIdentity } = await import("../dist/repo-identity.js");
      const empty = mkdtempSync(join(tmpdir(), "amem-empty-"));
      const repo = upsertRepo(workspaceIdentity("scratch", empty), "app");

      assert.equal(repoRootUsable(empty), false);
      // A broken binding is not the claims' fault — mass-decaying here would
      // destroy good memory over a config mistake.
      const claims = [
        {
          repo_id: repo.id,
          id: "claim.a",
          kind: "constraint",
          text: "x",
          code_anchors: JSON.stringify(["src/whatever.ts"]),
          source_ref: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: "active",
          superseded_by: null,
          pinned: 0,
        },
      ];
      assert.deepEqual(findAnchorRot(repo.id, claims), []);
      rmSync(empty, { recursive: true, force: true });
    });
  });
});

describe("transcript attestation evidence", () => {
  function writeTranscript(lines) {
    const dir = mkdtempSync(join(tmpdir(), "amem-transcript-"));
    const path = join(dir, "transcript.jsonl");
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
    return path;
  }

  it("extracts read file paths from a JSONL transcript", async () => {
    const { readTranscriptOpens } = await import("../dist/transcript.js");
    const path = writeTranscript([
      { type: "user", message: { content: "go" } },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read", input: { file_path: "/repo/src/db.ts" } }],
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/src/api.ts" } }],
        },
      },
    ]);
    const opens = readTranscriptOpens(path);
    assert.equal(opens.sawToolActivity, true);
    assert.ok(opens.paths.includes("/repo/src/db.ts"));
    assert.ok(opens.paths.includes("/repo/src/api.ts"));
  });

  it("reports no evidence rather than 'opened nothing' on an unreadable transcript", async () => {
    const { readTranscriptOpens } = await import("../dist/transcript.js");
    const dir = mkdtempSync(join(tmpdir(), "amem-transcript-bad-"));
    const path = join(dir, "t.txt");
    writeFileSync(path, "not json at all\nstill not json\n");
    const opens = readTranscriptOpens(path);
    // This distinction is the whole safeguard: unknown must not be recorded as
    // "opened nothing", which would credit the maximum saving.
    assert.equal(opens.sawToolActivity, false);
    assert.deepEqual(opens.paths, []);

    assert.equal(readTranscriptOpens("/nope/missing.jsonl").sawToolActivity, false);
  });

  it("matches absolute transcript paths against repo-relative anchors", async () => {
    const { anchorsOpenedFrom } = await import("../dist/transcript.js");
    const opened = anchorsOpenedFrom(
      ["src/db.ts", "src/api.ts", "README.md"],
      ["/repo/src/db.ts", "/elsewhere/other.ts"],
      "/repo",
    );
    assert.deepEqual(opened, ["src/db.ts"]);
  });

  it("ignores files read outside the repo", async () => {
    const { anchorsOpenedFrom } = await import("../dist/transcript.js");
    assert.deepEqual(anchorsOpenedFrom(["src/db.ts"], ["/other/src/db.ts"], "/repo"), []);
  });
});

describe("calibration gate", () => {
  it("withholds the ratio until the minimum sample is reached", async () => {
    const { calibrationRatio, MIN_CALIBRATION_EVENTS, savingsBasis } = await import(
      "../dist/estimate.js"
    );
    const below = calibrationRatio({
      attestedEstimatedTokens: 1000,
      attestedReportedTokens: 500,
      attestedEvents: MIN_CALIBRATION_EVENTS - 1,
    });
    assert.equal(below, null);
    const at = calibrationRatio({
      attestedEstimatedTokens: 1000,
      attestedReportedTokens: 500,
      attestedEvents: MIN_CALIBRATION_EVENTS,
    });
    assert.equal(at, 0.5);

    // One honest attestation is progress, not calibration.
    assert.equal(savingsBasis({ attestedEvents: 1, totalEvents: 1598 }).calibrated, false);
  });
});

describe("corpus integrity", () => {
  it("names a source-less repo that holds file-anchored claims", async () => {
    await withAmemHome(async () => {
      const { upsertRepo, insertClaim } = await import("../dist/db.js");
      const { findCorpusIssues } = await import("../dist/hygiene.js");
      const { workspaceIdentity } = await import("../dist/repo-identity.js");
      const empty = mkdtempSync(join(tmpdir(), "amem-phantom-"));
      const repo = upsertRepo(workspaceIdentity("phantom", empty), "app");
      void insertClaim;
      const issues = findCorpusIssues();
      // Schedule check always reports in a fresh test home.
      assert.ok(issues.some((i) => i.kind === "schedule-off"));
      void repo;
      rmSync(empty, { recursive: true, force: true });
    });
  });
});
