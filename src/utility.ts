import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { getRepoById, listUsageEvents, type ClaimRow, type UsageEventRow } from "./db.js";

/**
 * Whether a claim earns its place in retrieval.
 *
 * The original hygiene pass treated "was returned in a packet" as proof a claim
 * was useful, which had it exactly backwards: a noisy claim that ranks well is
 * returned constantly, so being noise made it permanently immune from cleanup.
 * 91% of the corpus was protected that way and hygiene reported "decayed 0"
 * nine runs in a row.
 *
 * Utility here is judged on attested outcomes instead — did the packet the
 * claim appeared in actually answer the question. A claim can only be condemned
 * on positive evidence of unhelpfulness, never on missing evidence.
 */

/** Attested appearances required before utility may condemn a claim. */
export const MIN_UTILITY_SAMPLES = 3;

export type ClaimUtility = {
  claimId: string;
  /** Times the claim appeared in any packet. */
  returns: number;
  /** Times it appeared in a packet the agent attested. */
  attestedReturns: number;
  /** Attested appearances where the packet answered the question. */
  helpful: number;
  /** Attested appearances where the agent had to explore anyway. */
  unhelpful: number;
};

function parseIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/** Per-claim utility ledger built from attested usage events. */
export function claimUtility(repoId: string, days = 90): Map<string, ClaimUtility> {
  const ledger = new Map<string, ClaimUtility>();
  const bump = (id: string): ClaimUtility => {
    let row = ledger.get(id);
    if (!row) {
      row = { claimId: id, returns: 0, attestedReturns: 0, helpful: 0, unhelpful: 0 };
      ledger.set(id, row);
    }
    return row;
  };
  for (const event of listUsageEvents({ repoId, days })) {
    const attested = event.attested_at != null;
    const answered = Number(event.answered ?? 0) > 0;
    for (const id of parseIds(event.claim_ids)) {
      if (!id) continue;
      const row = bump(id);
      row.returns += 1;
      if (!attested) continue;
      row.attestedReturns += 1;
      if (answered) row.helpful += 1;
      else row.unhelpful += 1;
    }
  }
  return ledger;
}

/**
 * A claim is condemned only when agents have repeatedly been handed it and
 * still had to go exploring. Absence of attestation is never held against a
 * claim — that would decay the whole corpus the moment this shipped.
 */
export function isUnhelpful(utility: ClaimUtility | undefined): boolean {
  if (!utility) return false;
  return utility.attestedReturns >= MIN_UTILITY_SAMPLES && utility.helpful === 0;
}

/**
 * A claim still counts as protected when it has been returned recently AND
 * nothing contradicts it. This is the replacement for the old blanket
 * "returned ⇒ immune" rule.
 */
export function isProtected(utility: ClaimUtility | undefined): boolean {
  if (!utility || utility.returns === 0) return false;
  return !isUnhelpful(utility);
}

/**
 * Does a repo root look like real source, or like an empty scratch directory?
 * A misconfigured binding must not be mistaken for mass anchor rot — if the
 * repo itself is missing, the claims are fine and the binding is broken.
 */
export function repoRootUsable(rootPath: string | null | undefined): boolean {
  if (!rootPath || !existsSync(rootPath)) return false;
  try {
    if (!statSync(rootPath).isDirectory()) return false;
    return readdirSync(rootPath).some((entry) => !entry.startsWith("."));
  } catch {
    return false;
  }
}

/**
 * Anchors are not always file paths — workspaces use tag-like anchors
 * ("luna-ai", "august-2026") that will never exist on disk. Only path-shaped
 * anchors can rot, and treating a tag as a missing file would decay perfectly
 * good memory.
 */
export function looksLikeFilePath(anchor: string): boolean {
  const a = anchor.trim();
  if (!a) return false;
  if (a.includes("/") || a.includes("\\")) return true;
  return /\.[A-Za-z0-9]{1,8}$/.test(a);
}

export type AnchorRot = {
  claimId: string;
  anchors: string[];
};

/**
 * Claims whose every anchor has vanished from disk. Deterministic, needs no
 * attestation, and is the strongest cheap staleness signal available: a claim
 * that points only at files which no longer exist cannot be describing the
 * current tree.
 *
 * Returns nothing when the repo root itself is missing or empty — that is a
 * broken binding, not rotten memory, and mass-decaying on it would be wrong.
 */
export function findAnchorRot(repoId: string, claims: ClaimRow[]): AnchorRot[] {
  const root = getRepoById(repoId)?.root_path ?? null;
  if (!repoRootUsable(root)) return [];
  const out: AnchorRot[] = [];
  for (const claim of claims) {
    if (Number(claim.pinned || 0) > 0) continue;
    const anchors = parseIds(claim.code_anchors).filter(Boolean).filter(looksLikeFilePath);
    // No file anchors: nothing here can rot. Tag-only claims and anchorless
    // claims are a different problem (non-fact detection covers those).
    if (!anchors.length) continue;
    const alive = anchors.some((anchor) => {
      const full = isAbsolute(anchor) ? anchor : resolve(root!, anchor);
      return existsSync(full);
    });
    if (!alive) out.push({ claimId: claim.id, anchors });
  }
  return out;
}

/** Convenience for callers that already hold the events. */
export function attestedEventCount(events: UsageEventRow[]): number {
  return events.filter((e) => e.attested_at != null).length;
}
