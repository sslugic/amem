import type { ContextPacket } from "./context.js";
import { uniqueAnchorPaths } from "./anchors.js";

/** Rough chars→tokens. */
export function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Proxy for exploration avoided:
 * anchors_returned * 4000 + claims_returned * 200 - packet_tokens
 */
export function estimateTokensSaved(input: {
  anchorsCount: number;
  claimsCount: number;
  packetTokens: number;
}): number {
  return Math.max(
    0,
    input.anchorsCount * 4000 + input.claimsCount * 200 - input.packetTokens,
  );
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
  return Math.max(0, (Number(tokens) / 1_000_000) * usdPerMillion);
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
      for (const path of uniqueAnchorPaths(anchors)) anchorSet.add(path);
    } catch {
      // ignore
    }
  }
  if (kind === "local_hit") {
    for (const component of packet.components) {
      if (component.code_anchor) {
        for (const path of uniqueAnchorPaths([component.code_anchor])) anchorSet.add(path);
      }
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
