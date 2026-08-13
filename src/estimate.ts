import type { ContextPacket } from "./context.js";

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

export function metricsFromPacket(packet: ContextPacket, markdown: string): {
  claimIds: string[];
  anchorsCount: number;
  claimsCount: number;
  packetTokens: number;
  estimatedTokensSaved: number;
} {
  const claimIds = packet.claims.map((c) => c.id);
  const anchorSet = new Set<string>();
  for (const claim of packet.claims) {
    try {
      const anchors = JSON.parse(claim.code_anchors) as string[];
      for (const a of anchors) anchorSet.add(a);
    } catch {
      // ignore
    }
  }
  for (const component of packet.components) {
    if (component.code_anchor) anchorSet.add(component.code_anchor);
  }
  const anchorsCount = anchorSet.size;
  const claimsCount = packet.claims.length;
  const packetTokens = estimateTokensFromText(markdown);
  const estimatedTokensSaved = estimateTokensSaved({
    anchorsCount,
    claimsCount,
    packetTokens,
  });
  return { claimIds, anchorsCount, claimsCount, packetTokens, estimatedTokensSaved };
}
