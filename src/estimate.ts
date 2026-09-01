import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { ContextPacket } from "./context.js";

/** Rough chars→tokens. */
export function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Fallback cost of one file the agent did not have to open, used ONLY when the
 * file cannot be measured (missing, outside the repo, unreadable). Prefer
 * measureAnchorTokens(), which reads the real size off disk. This constant is a
 * guess and a total built from it is an upper bound, not a measurement.
 */
export const ASSUMED_TOKENS_PER_FILE = 4000;
export const ASSUMED_TOKENS_PER_CLAIM = 200;

/**
 * Ceiling on what one anchor may contribute. An agent that opens a 2 MB file
 * usually reads a slice of it, so crediting the whole thing would let a single
 * generated file dominate the headline. Conservative by design.
 */
export const MAX_TOKENS_PER_FILE = 25_000;

export type AnchorMeasurement = {
  /** Real token cost of the anchors, measured where possible. */
  anchorTokens: number;
  /** Anchors whose size was read off disk. */
  measuredFiles: number;
  /** Anchors that fell back to ASSUMED_TOKENS_PER_FILE. */
  assumedFiles: number;
};

/**
 * Measure what the anchored files actually cost to read, instead of assuming.
 * This is the half of the savings figure that can be made real without asking
 * anyone: file sizes are on disk right now. The other half — whether the agent
 * would have opened them at all — needs attestation.
 */
export function measureAnchorTokens(anchors: string[], rootPath?: string | null): AnchorMeasurement {
  let anchorTokens = 0;
  let measuredFiles = 0;
  let assumedFiles = 0;
  const seen = new Set<string>();
  for (const raw of anchors) {
    const anchor = String(raw || "").trim();
    if (!anchor || seen.has(anchor)) continue;
    seen.add(anchor);
    const full = isAbsolute(anchor) ? anchor : rootPath ? resolve(rootPath, anchor) : null;
    let tokens: number | null = null;
    if (full) {
      try {
        const st = statSync(full);
        // A directory anchor is not a file the agent would have read whole.
        if (st.isFile()) tokens = Math.ceil(st.size / 4);
      } catch {
        tokens = null;
      }
    }
    if (tokens == null) {
      assumedFiles += 1;
      anchorTokens += ASSUMED_TOKENS_PER_FILE;
    } else {
      measuredFiles += 1;
      anchorTokens += Math.min(tokens, MAX_TOKENS_PER_FILE);
    }
  }
  return { anchorTokens, measuredFiles, assumedFiles };
}

/**
 * Proxy for exploration avoided, net of what the packet itself cost:
 * anchor_tokens + claims_returned * 200 - packet_tokens
 *
 * `anchorTokens` should come from measureAnchorTokens() so the file half of the
 * figure is measured rather than assumed; passing only `anchorsCount` falls
 * back to the modelled constant and keeps the number an upper bound.
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
  /** Measured token cost of the anchors. Preferred over anchorsCount. */
  anchorTokens?: number;
}): number {
  const anchorTokens =
    input.anchorTokens != null ? input.anchorTokens : input.anchorsCount * ASSUMED_TOKENS_PER_FILE;
  return anchorTokens + input.claimsCount * ASSUMED_TOKENS_PER_CLAIM - input.packetTokens;
}

/**
 * Ground truth, computed from two observable things rather than asked for:
 * the real size of the anchors amem returned, and which of them the agent
 * actually had to open anyway. Anchors it opened were NOT saved — the read
 * happened. Only the unopened remainder counts, net of the packet's own cost.
 *
 * This is what makes a savings figure "measured": no constant is doing the
 * work, and an agent that opened everything correctly reports a loss.
 */
export function reportedTokensSavedFromAttestation(input: {
  anchorsReturned: string[];
  anchorsOpened: string[];
  claimsCount: number;
  packetTokens: number;
  rootPath?: string | null;
}): { reportedTokensSaved: number; anchorsUnopened: string[]; measurement: AnchorMeasurement } {
  const opened = new Set(input.anchorsOpened.map((a) => String(a || "").trim()).filter(Boolean));
  const anchorsUnopened = input.anchorsReturned
    .map((a) => String(a || "").trim())
    .filter((a) => a && !opened.has(a));
  const measurement = measureAnchorTokens(anchorsUnopened, input.rootPath);
  return {
    reportedTokensSaved:
      measurement.anchorTokens +
      input.claimsCount * ASSUMED_TOKENS_PER_CLAIM -
      input.packetTokens,
    anchorsUnopened,
    measurement,
  };
}

/**
 * Ratio of what attested events actually saved to what the model predicted for
 * those same events. Applied to unattested events, it corrects the headline
 * toward observed behaviour instead of leaving it at the model's guess.
 * Returns null until there is something to calibrate against.
 */
/**
 * Attested events required before the ratio may move the headline. One honest
 * sample is evidence that the loop works, not grounds to restate 1,598 events —
 * and attestation is plausibly biased toward sessions that went well.
 */
export const MIN_CALIBRATION_EVENTS = 30;

export function calibrationRatio(input: {
  attestedEstimatedTokens: number;
  attestedReportedTokens: number;
  attestedEvents: number;
}): number | null {
  if (input.attestedEvents < MIN_CALIBRATION_EVENTS) return null;
  if (!Number.isFinite(input.attestedEstimatedTokens) || input.attestedEstimatedTokens === 0) {
    return null;
  }
  return input.attestedReportedTokens / input.attestedEstimatedTokens;
}

/**
 * How a savings figure should be presented. "measured" only once agents have
 * actually attested to what they did and did not open; until then the number is
 * a model and must be labelled as one.
 *
 * Keyed on the COUNT of attested events, not on the sum being positive. A run
 * of honest attestations that nets out negative is still measured — treating
 * only positive totals as real would rig the label toward good news.
 */
export function savingsBasis(input: {
  attestedEvents: number;
  totalEvents?: number;
  calibrationRatio?: number | null;
}): {
  savingsBasis: "measured" | "partially-measured" | "modelled";
  calibrated: boolean;
  calibrationMinEvents: number;
  attestedEvents: number;
  attestedShare: number;
  calibrationRatio: number | null;
  assumedTokensPerFile: number;
  assumedTokensPerClaim: number;
} {
  const attestedEvents = Math.max(0, Number(input.attestedEvents) || 0);
  const totalEvents = Math.max(0, Number(input.totalEvents ?? 0) || 0);
  // "Calibrated" means evidence is actually moving the headline, which only
  // happens past the minimum sample. A handful of attestations is progress,
  // not calibration, and the label should not overclaim.
  const calibrated = attestedEvents >= MIN_CALIBRATION_EVENTS;
  const attestedShare = totalEvents > 0 ? attestedEvents / totalEvents : 0;
  return {
    // Distinct from pricing.basis ("input"), which is about which side of the
    // token bill is being priced, not about how trustworthy the figure is.
    savingsBasis: !calibrated ? "modelled" : attestedShare >= 1 ? "measured" : "partially-measured",
    calibrated,
    calibrationMinEvents: MIN_CALIBRATION_EVENTS,
    attestedEvents,
    attestedShare,
    calibrationRatio: input.calibrationRatio ?? null,
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

export function metricsFromPacket(
  packet: ContextPacket,
  markdown: string,
  rootPath?: string | null,
): {
  claimIds: string[];
  anchors: string[];
  anchorsCount: number;
  anchorTokens: number;
  measuredFiles: number;
  assumedFiles: number;
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
  const anchors = [...anchorSet];
  const anchorsCount = anchors.length;
  const claimsCount = scored.length;
  const packetTokens = estimateTokensFromText(markdown);
  // Measure what those files actually cost rather than assuming 4k apiece.
  const measurement = measureAnchorTokens(anchors, rootPath);
  const estimatedTokensSaved =
    kind === "local_hit"
      ? estimateTokensSaved({
          anchorsCount,
          anchorTokens: measurement.anchorTokens,
          claimsCount,
          packetTokens,
        })
      : 0;
  const estimatedMsSaved = kind === "local_hit" ? estimateMsSaved({ anchorsCount, claimsCount }) : 0;
  return {
    claimIds,
    anchors,
    anchorsCount,
    anchorTokens: measurement.anchorTokens,
    measuredFiles: measurement.measuredFiles,
    assumedFiles: measurement.assumedFiles,
    claimsCount,
    packetTokens,
    estimatedTokensSaved,
    estimatedMsSaved,
    kind,
  };
}
