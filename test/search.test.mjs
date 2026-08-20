import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tokenize,
  buildFtsMatchQuery,
  tokenJaccard,
  ftsBoostFromBm25,
  keywordScoreClaim,
} from "../dist/search.js";
import { claimFixture } from "./helpers.mjs";

describe("search helpers", () => {
  it("tokenizes paths and words", () => {
    const tokens = tokenize("API boot_order in src/api.ts");
    assert.ok(tokens.includes("api"));
    assert.ok(tokens.includes("boot_order") || tokens.includes("boot"));
    assert.ok(tokens.some((t) => t.includes("api.ts") || t === "ts"));
  });

  it("builds safe FTS OR queries and rejects empty", () => {
    assert.equal(buildFtsMatchQuery("   "), null);
    assert.equal(buildFtsMatchQuery("!!!"), null);
    const q = buildFtsMatchQuery('boot "weird" api');
    assert.match(q, /"boot"/);
    assert.match(q, /"api"/);
    assert.ok(!q.includes('""'));
  });

  it("computes jaccard similarity", () => {
    assert.equal(tokenJaccard("", "x"), 0);
    assert.ok(tokenJaccard("api boot order", "api boot flow") > 0.3);
    assert.ok(tokenJaccard("completely different", "zz qq") < 0.2);
  });

  it("converts bm25 to positive boost", () => {
    assert.ok(ftsBoostFromBm25(-2) > ftsBoostFromBm25(-10));
    assert.ok(ftsBoostFromBm25(0) > 0);
  });

  it("keyword-scores claim fields", () => {
    const claim = claimFixture({
      id: "claim.webhook_retry",
      text: "Stripe webhooks retry on 5xx",
      code_anchors: JSON.stringify(["src/webhooks/stripe.ts"]),
    });
    assert.ok(keywordScoreClaim(claim, ["webhook", "stripe"]) > 0);
    assert.equal(keywordScoreClaim(claim, ["zzzzz"]), 0);
  });
});
