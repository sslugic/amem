import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ASSUMED_TOKENS_PER_FILE,
  ASSUMED_TOKENS_PER_CLAIM,
  MAX_TOKENS_PER_FILE,
  calibrationRatio,
  estimateTokensSaved,
  MIN_CALIBRATION_EVENTS,
  measureAnchorTokens,
  reportedTokensSavedFromAttestation,
} from "../dist/estimate.js";

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "amem-calib-"));
  mkdirSync(join(root, "src"), { recursive: true });
  // 400 bytes -> 100 tokens. Nothing like the assumed 4000.
  writeFileSync(join(root, "src/small.ts"), "x".repeat(400));
  writeFileSync(join(root, "src/big.ts"), "y".repeat(40_000)); // 10k tokens
  return root;
}

describe("anchor measurement", () => {
  it("measures real file sizes instead of assuming a flat cost", () => {
    const root = fixtureRepo();
    const m = measureAnchorTokens(["src/small.ts", "src/big.ts"], root);
    assert.equal(m.measuredFiles, 2);
    assert.equal(m.assumedFiles, 0);
    assert.equal(m.anchorTokens, 100 + 10_000);
    // The whole point: the measured figure disagrees with 2 * 4000.
    assert.notEqual(m.anchorTokens, 2 * ASSUMED_TOKENS_PER_FILE);
  });

  it("falls back to the modelled constant only when a file cannot be read", () => {
    const root = fixtureRepo();
    const m = measureAnchorTokens(["src/small.ts", "src/gone.ts"], root);
    assert.equal(m.measuredFiles, 1);
    assert.equal(m.assumedFiles, 1);
    assert.equal(m.anchorTokens, 100 + ASSUMED_TOKENS_PER_FILE);
  });

  it("caps one file so a generated blob cannot carry the headline", () => {
    const root = mkdtempSync(join(tmpdir(), "amem-calib-big-"));
    writeFileSync(join(root, "huge.json"), "z".repeat(4_000_000)); // 1M tokens raw
    const m = measureAnchorTokens(["huge.json"], root);
    assert.equal(m.anchorTokens, MAX_TOKENS_PER_FILE);
  });

  it("counts a repeated anchor once and ignores directories", () => {
    const root = fixtureRepo();
    const m = measureAnchorTokens(["src/small.ts", "src/small.ts", "src"], root);
    assert.equal(m.measuredFiles, 1);
    // "src" is a directory: not a file the agent would have read whole.
    assert.equal(m.assumedFiles, 1);
    assert.equal(m.anchorTokens, 100 + ASSUMED_TOKENS_PER_FILE);
  });

  it("prefers measured anchor tokens over the count when both are given", () => {
    const measured = estimateTokensSaved({
      anchorsCount: 2,
      anchorTokens: 250,
      claimsCount: 0,
      packetTokens: 50,
    });
    assert.equal(measured, 200);
    const modelled = estimateTokensSaved({ anchorsCount: 2, claimsCount: 0, packetTokens: 50 });
    assert.equal(modelled, 2 * ASSUMED_TOKENS_PER_FILE - 50);
  });
});

describe("attestation", () => {
  it("credits only the anchors the agent did not have to open", () => {
    const root = fixtureRepo();
    const r = reportedTokensSavedFromAttestation({
      anchorsReturned: ["src/small.ts", "src/big.ts"],
      anchorsOpened: ["src/big.ts"],
      claimsCount: 1,
      packetTokens: 50,
      rootPath: root,
    });
    assert.deepEqual(r.anchorsUnopened, ["src/small.ts"]);
    // Only small.ts counts: big.ts was read, so that cost was actually paid.
    assert.equal(r.reportedTokensSaved, 100 + ASSUMED_TOKENS_PER_CLAIM - 50);
  });

  it("reports a loss when the agent opened everything anyway", () => {
    const root = fixtureRepo();
    const r = reportedTokensSavedFromAttestation({
      anchorsReturned: ["src/small.ts", "src/big.ts"],
      anchorsOpened: ["src/small.ts", "src/big.ts"],
      claimsCount: 0,
      packetTokens: 900,
      rootPath: root,
    });
    assert.equal(r.anchorsUnopened.length, 0);
    // The packet cost input tokens and avoided no reads. That is a net loss and
    // the metric has to be able to say so.
    assert.equal(r.reportedTokensSaved, -900);
  });
});

describe("calibration ratio", () => {
  it("is null until something has been attested", () => {
    assert.equal(
      calibrationRatio({
        attestedEstimatedTokens: 0,
        attestedReportedTokens: 0,
        attestedEvents: 0,
      }),
      null,
    );
  });

  it("reports the model running hot when agents opened the files anyway", () => {
    const ratio = calibrationRatio({
      attestedEstimatedTokens: 10_000,
      attestedReportedTokens: 2_500,
      attestedEvents: MIN_CALIBRATION_EVENTS,
    });
    assert.equal(ratio, 0.25);
  });

  it("survives an attested set that nets out negative", () => {
    const ratio = calibrationRatio({
      attestedEstimatedTokens: 10_000,
      attestedReportedTokens: -2_000,
      attestedEvents: MIN_CALIBRATION_EVENTS,
    });
    assert.equal(ratio, -0.2);
  });
});
