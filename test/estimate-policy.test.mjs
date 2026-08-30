import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokensFromText,
  estimateTokensSaved,
  estimateMsSaved,
  eventKind,
  metricsFromPacket,
  MS_PER_FILE_ROUNDTRIP,
} from "../dist/estimate.js";
import { checkProposalAgainstPolicy } from "../dist/proposal.js";
import { loadPolicy, DEFAULT_POLICY } from "../dist/policy.js";

describe("estimate", () => {
  it("estimates tokens and reports a net loss instead of flooring at zero", () => {
    assert.equal(estimateTokensFromText(""), 1);
    assert.ok(estimateTokensFromText("abcd") >= 1);
    // A packet that returns nothing still costs input tokens. That is a loss,
    // and the metric must be able to report it rather than clamping to 0.
    assert.equal(
      estimateTokensSaved({ anchorsCount: 0, claimsCount: 0, packetTokens: 999 }),
      -999,
    );
    assert.ok(
      estimateTokensSaved({ anchorsCount: 1, claimsCount: 1, packetTokens: 10 }) >
        4000,
    );
    assert.equal(estimateMsSaved({ anchorsCount: 1, claimsCount: 0 }), MS_PER_FILE_ROUNDTRIP);
  });

  it("classifies hit vs miss", () => {
    assert.equal(eventKind(0, 0), "server_trip");
    assert.equal(eventKind(1, 0), "local_hit");
    assert.equal(eventKind(0, 2), "local_hit");
  });

  it("metricsFromPacket aggregates anchors", () => {
    const packet = {
      query: "x",
      claims: [
        {
          id: "claim.a",
          score: 4,
          code_anchors: JSON.stringify(["src/a.ts", "src/b.ts"]),
        },
        {
          id: "claim.b",
          score: 2,
          code_anchors: JSON.stringify(["src/a.ts"]),
        },
      ],
      components: [{ code_anchor: "src/c.ts" }],
      flows: [],
      notes: [],
    };
    const m = metricsFromPacket(packet, "hello world");
    assert.equal(m.claimsCount, 2);
    assert.equal(m.anchorsCount, 3);
    assert.equal(m.kind, "local_hit");
  });
});

describe("policy deny patterns", () => {
  it("blocks secret-like claim text via builtin/policy patterns", () => {
    const { policy } = loadPolicy();
    const errors = checkProposalAgainstPolicy(
      {
        claims: [
          {
            id: "claim.leak",
            kind: "constraint",
            text: "token is sk_live_example_secret_value_here",
            code_anchors: ["src/api.ts"],
          },
        ],
      },
      {
        ...DEFAULT_POLICY,
        deny_claim_patterns: ["sk_live_"],
      },
    );
    assert.ok(errors.length >= 1);
    void policy;
  });
});
