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
  it("is modelled until real reported savings exist", async () => {
    const { savingsBasis } = await import("../dist/estimate.js");
    const cold = savingsBasis(0);
    assert.equal(cold.savingsBasis, "modelled");
    assert.equal(cold.calibrated, false);
    assert.equal(cold.assumedTokensPerFile, 4000);
    const warm = savingsBasis(12345);
    assert.equal(warm.savingsBasis, "measured");
    assert.equal(warm.calibrated, true);
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
