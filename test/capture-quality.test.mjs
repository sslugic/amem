import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("claim text keeps identifiers", () => {
  it("preserves inline code spans and drops fenced blocks", async () => {
    const { compactClaimText } = await import("../dist/kinds.js");
    const out = compactClaimText(
      "where is it wired",
      "Wired via `package.json` `postinstall` and included in published `files` on install.",
    );
    for (const ident of ["package.json", "postinstall", "files"]) {
      assert.ok(out.includes(ident), `identifier ${ident} survived scrubbing`);
    }
    assert.ok(!out.includes("`"), "backticks themselves are removed");
    const fenced = compactClaimText(
      "show me",
      "The loader reads src/db.ts at startup and caches the handle for reuse.\n```js\nconst x = 1;\n```",
    );
    assert.ok(fenced.includes("src/db.ts"));
    assert.ok(!fenced.includes("const x"), "fenced code is still stripped");
  });
});

describe("isFactLike", () => {
  it("rejects questions even when they name real files", async () => {
    const { isFactLike } = await import("../dist/kinds.js");
    // Verbatim shapes that reached the real database as durable "facts".
    assert.equal(isFactLike("so use luna mcp to connect to amem and that will do the trick?"), false);
    assert.equal(isFactLike("can we expose amem data via mcp in src/mcp.ts so tools can query it"), false);
    assert.equal(isFactLike("im getting this from LUna: I will probe the amem MCP server now"), false);
  });

  it("rejects scrub residue with a dangling preposition", async () => {
    const { isFactLike } = await import("../dist/kinds.js");
    assert.equal(isFactLike("The matching public key lives in and is what every install uses."), false);
  });

  it("accepts real statements, including ones opening on an identifier", async () => {
    const { isFactLike } = await import("../dist/kinds.js");
    assert.equal(isFactLike("The sync service checks auth mode in src/auth.ts before enabling Drive sync."), true);
    assert.equal(isFactLike("src/mcp.ts dispatches every tool call through callTool and defaultWorkspace."), true);
  });

  it("rejects text too short to be a durable fact", async () => {
    const { isFactLike } = await import("../dist/kinds.js");
    assert.equal(isFactLike("Uses src/db.ts."), false);
  });
});

describe("savings basis", () => {
  it("is modelled until agents attest to what they opened", async () => {
    const { savingsBasis } = await import("../dist/estimate.js");
    const cold = savingsBasis({ attestedEvents: 0, totalEvents: 100 });
    assert.equal(cold.savingsBasis, "modelled");
    assert.equal(cold.calibrated, false);
    assert.equal(cold.assumedTokensPerFile, 4000);

    // Below the minimum sample, attestations are progress but not calibration.
    const early = savingsBasis({ attestedEvents: 5, totalEvents: 100 });
    assert.equal(early.savingsBasis, "modelled");
    assert.equal(early.calibrated, false);
    assert.equal(early.attestedEvents, 5);

    const partial = savingsBasis({ attestedEvents: 50, totalEvents: 100 });
    assert.equal(partial.savingsBasis, "partially-measured");
    assert.equal(partial.calibrated, true);
    assert.equal(partial.attestedShare, 0.5);

    const full = savingsBasis({ attestedEvents: 100, totalEvents: 100 });
    assert.equal(full.savingsBasis, "measured");
  });

  it("keys the label on attestation count, not on the total being positive", async () => {
    const { savingsBasis } = await import("../dist/estimate.js");
    // Honest attestations that net out negative are still measurements.
    // Labelling only good news as "measured" would rig the metric.
    const negative = savingsBasis({ attestedEvents: 40, totalEvents: 40, calibrationRatio: -0.2 });
    assert.equal(negative.savingsBasis, "measured");
    assert.equal(negative.calibrated, true);
  });

  it("usd tracks a negative token figure rather than hiding it", async () => {
    const { estimateUsdSaved } = await import("../dist/estimate.js");
    assert.ok(estimateUsdSaved(-1_000_000) < 0);
  });
});

describe("nonFactReason (deletion predicate)", () => {
  it("flags the junk shapes that reached the real database", async () => {
    const { nonFactReason } = await import("../dist/kinds.js");
    assert.equal(nonFactReason("so use luna mcp to connect to amem and that will do the trick?"), "question");
    assert.equal(nonFactReason("The matching public key lives in and is what every install uses."), "scrub-residue");
    assert.equal(nonFactReason("im getting this from LUna: I will probe the amem MCP server"), "chat-fragment");
    assert.equal(nonFactReason(""), "empty");
  });

  it("keeps real facts, including ones capture would now reject", async () => {
    const { nonFactReason, isFactLike } = await import("../dist/kinds.js");
    // Narrower than the admission gate on purpose: deleting is unrecoverable,
    // so a short claim is kept even though new capture would turn it away.
    const short = "Uses src/db.ts.";
    assert.equal(isFactLike(short), false, "capture would reject it");
    assert.equal(nonFactReason(short), null, "but we must not delete it");
    assert.equal(nonFactReason("The sync service checks auth mode in src/auth.ts before sync."), null);
  });
});

describe("nonFactReason catches what the first purge missed", () => {
  it("flags questions typed without a question mark", async () => {
    const { nonFactReason } = await import("../dist/kinds.js");
    // Both survived the first purge and were still ranking in real packets.
    assert.equal(nonFactReason("can we expose amem data, stats and repos via mcp so tools can query it"), "question");
    assert.equal(nonFactReason("can we also add more stats on how much faster the cursor response was"), "question");
  });

  it("flags residue where the deleted span sat at the end of a clause", async () => {
    const { nonFactReason } = await import("../dist/kinds.js");
    assert.equal(
      nonFactReason("After publish the intended installs are: that runs setup; memory still lives under ."),
      "scrub-residue",
    );
  });

  it("does not swallow declaratives that merely open with an interrogative word", async () => {
    const { nonFactReason } = await import("../dist/kinds.js");
    // "Is" opens the sentence but a subject does not follow in question order.
    assert.equal(nonFactReason("Is-a relationships are modelled in src/graph.ts as typed edges."), null);
    assert.equal(nonFactReason("What the loader caches is the handle returned by src/db.ts on startup."), null);
  });
});

describe("short-answer capture", () => {
  it("leads with the answer, not the question", async () => {
    const { compactClaimText, isFactLike } = await import("../dist/kinds.js");
    // A short answer used to be discarded in favour of the prompt, so the
    // stored "fact" was the question — the exact shape that filled the DB
    // with junk, and which the capture gate now (correctly) rejects.
    const text = compactClaimText(
      "What should I know about webhook retries in src/api.ts?",
      "Retry with backoff on 5xx",
    );
    assert.ok(text.startsWith("Retry with backoff on 5xx"), `answer leads: ${text}`);
    assert.ok(!text.includes("?"), "no question mark survives into the claim");
    assert.ok(text.includes("src/api.ts"), "prompt kept as context for the anchor");
    assert.equal(isFactLike(text), true, "so the capture is no longer dropped");
  });

  it("still refuses when there is no answer at all", async () => {
    const { compactClaimText, isFactLike } = await import("../dist/kinds.js");
    assert.equal(isFactLike(compactClaimText("so should we delete src/db.ts and start over?", "")), false);
  });
});
