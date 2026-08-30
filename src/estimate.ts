import type { ContextPacket } from "./context.js";

/** Rough chars→tokens. */
export function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Assumed cost of one file the agent did not have to open. This is a MODELLED
 * constant, not a measurement: it credits a saving whether or not the agent
 * would actually have read that file. It dominates the headline number, so
 * treat any total built from it as an upper bound until calibrated against
 * real reported savings (`amem usage report --saved <n>`).
 */
export const ASSUMED_TOKENS_PER_FILE = 4000;
export const ASSUMED_TOKENS_PER_CLAIM = 200;

/**
 * Proxy for exploration avoided, net of what the packet itself cost:
 * anchors_returned * 4000 + claims_returned * 200 - packet_tokens
 *
 * Deliberately NOT clamped at zero. A packet that returns little and still
 * costs input tokens is a net loss, and the metric has to be able to say so —
 * clamping made the dashboard structurally incapable of reporting that amem
 * ever cost anything, which is not a property you want in your own numbers.
 */
export function estimateTokensSaved(input: {
  anchorsCount: number;
  claimsCount: number;
  packetTokens: number;
}): number {
  return (
    input.anchorsCount * ASSUMED_TOKENS_PER_FILE +
    input.claimsCount * ASSUMED_TOKENS_PER_CLAIM -
    input.packetTokens
  );
}

/**
 * How a savings figure should be presented. "measured" only once real reported
 * savings exist; until then the number is a model and must be labelled as one.
 */
export function savingsBasis(reportedTokensSaved: number): {
  savingsBasis: "measured" | "modelled";
  calibrated: boolean;
  assumedTokensPerFile: number;
  assumedTokensPerClaim: number;
} {
  const calibrated = Number(reportedTokensSaved) > 0;
  return {
    // Distinct from pricing.basis ("input"), which is about which side of the
    // token bill is being priced, not about how trustworthy the figure is.
    savingsBasis: calibrated ? "measured" : "modelled",
    calibrated,
    assumedTokensPerFile: ASSUMED_TOKENS_PER_FILE,
    assumedTokensPerClaim: ASSUMED_TOKENS_PER_CLAIM,
  };
}

/** Typical Cursor/Claude tool round-trip to read a file (~1.2s) plus a little per claim. */
export const MS_PER_FILE_ROUNDTRIP = 1200;
export const MS_PER_CLAIM = 80;

export function estimateMsSaved(input: { anchorsCount: number; claimsCount: number }): number {
  return Math.max(0, input.anchorsCount * MS_PER_FILE_ROUNDTRIP + input.claimsCount * MS_PER_CLAIM);
}

/** Mid-range frontier *input* $/1M tokens (Sonnet-class). Avoided exploration is input-side. Not a bill. */
export const USD_PER_MILLION_INPUT_TOKENS = 3;

export function estimateUsdSaved(
  tokens: number,
  usdPerMillion = USD_PER_MILLION_INPUT_TOKENS,
): number {
  // Unclamped for the same reason as estimateTokensSaved: a negative here is
  // real information, not an error to be hidden.
  return (Number(tokens) / 1_000_000) * usdPerMillion;
}

export function eventKind(claimsCount: number, notesCount = 0): "local_hit" | "server_trip" {
  return claimsCount > 0 || notesCount > 0 ? "local_hit" : "server_trip";
}

export function metricsFromPacket(packet: ContextPacket, markdown: string): {
  claimIds: string[];
  anchorsCount: number;
  claimsCount: number;
  packetTokens: number;
  estimatedTokensSaved: number;
  estimatedMsSaved: number;
  kind: "local_hit" | "server_trip";
} {
  const matchedClaims = packet.claims.filter((c) => c.score > 0);
  const matchedNotes = packet.notes.filter((n) => n.score > 0);
  const kind: "local_hit" | "server_trip" =
    matchedClaims.length > 0 || matchedNotes.length > 0 ? "local_hit" : "server_trip";
  const scored = kind === "local_hit" ? matchedClaims : [];
  const claimIds = packet.claims.map((c) => c.id);
  const anchorSet = new Set<string>();
  for (const claim of scored) {
    try {
      const anchors = JSON.parse(claim.code_anchors) as string[];
      for (const a of anchors) anchorSet.add(a);
    } catch {
      // ignore
    }
  }
  if (kind === "local_hit") {
    for (const component of packet.components) {
      if (component.code_anchor) anchorSet.add(component.code_anchor);
    }
  }
  const anchorsCount = anchorSet.size;
  const claimsCount = scored.length;
  const packetTokens = estimateTokensFromText(markdown);
  const estimatedTokensSaved =
    kind === "local_hit"
      ? estimateTokensSaved({
          anchorsCount,
          claimsCount,
          packetTokens,
        })
      : 0;
  const estimatedMsSaved = kind === "local_hit" ? estimateMsSaved({ anchorsCount, claimsCount }) : 0;
  return {
    claimIds,
    anchorsCount,
    claimsCount,
    packetTokens,
    estimatedTokensSaved,
    estimatedMsSaved,
    kind,
  };
}
