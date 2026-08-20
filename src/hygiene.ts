/**
 * Local memory hygiene: decay unused facts, find near-duplicates, review inbox.
 * Pro/IT only. Nothing is uploaded.
 */
import {
  getClaim,
  listClaims,
  listProposalDrafts,
  listUsageEvents,
  setClaimStatus,
  type ClaimRow,
} from "./db.js";
import { FEATURE_HYGIENE, requireFeature } from "./license.js";
import { applyProposal, applySupersedes } from "./proposal.js";
import { tokenJaccard } from "./search.js";
import { parseAnchors } from "./freshness.js";

export type HygieneDuplicate = {
  keepId: string;
  dropId: string;
  similarity: number;
};

export type HygieneReport = {
  stale: ClaimRow[];
  duplicates: HygieneDuplicate[];
  pendingDrafts: number;
  active: number;
};

function usedClaimIds(repoId: string, days: number): Set<string> {
  const ids = new Set<string>();
  for (const event of listUsageEvents({ repoId, days })) {
    try {
      for (const id of JSON.parse(event.claim_ids || "[]") as string[]) {
        if (id) ids.add(id);
      }
    } catch {
      // ignore
    }
  }
  return ids;
}

export function hygieneReport(repoId: string, unusedDays = 90): HygieneReport {
  requireFeature(FEATURE_HYGIENE, "Memory hygiene");
  const claims = listClaims(repoId);
  const used = usedClaimIds(repoId, unusedDays);
  const cutoff = Date.now() - unusedDays * 86_400_000;
  const stale = claims.filter((c) => {
    if (Number(c.pinned || 0) > 0) return false;
    if (used.has(c.id)) return false;
    const updated = Date.parse(c.updated_at);
    return Number.isFinite(updated) && updated < cutoff;
  });

  const duplicates: HygieneDuplicate[] = [];
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i]!;
      const b = claims[j]!;
      const sim = tokenJaccard(a.text, b.text);
      if (sim < 0.72) continue;
      const aAnchors = new Set(parseAnchors(a.code_anchors));
      const bAnchors = parseAnchors(b.code_anchors);
      const share = bAnchors.some((p) => aAnchors.has(p));
      if (!share && sim < 0.85) continue;
      const keep =
        Number(a.pinned || 0) >= Number(b.pinned || 0) && a.text.length >= b.text.length ? a : b;
      const drop = keep.id === a.id ? b : a;
      duplicates.push({ keepId: keep.id, dropId: drop.id, similarity: sim });
    }
  }

  return {
    stale,
    duplicates: duplicates.slice(0, 40),
    pendingDrafts: listProposalDrafts(repoId, { status: "pending" }).length,
    active: claims.length,
  };
}

export function decayStaleClaims(repoId: string, unusedDays = 90): { decayed: string[] } {
  requireFeature(FEATURE_HYGIENE, "Memory hygiene");
  const decayed: string[] = [];
  for (const claim of hygieneReport(repoId, unusedDays).stale) {
    if (setClaimStatus(repoId, claim.id, "decayed")) decayed.push(claim.id);
  }
  return { decayed };
}

export function mergeDuplicate(repoId: string, keepId: string, dropId: string): { keepId: string; dropId: string } {
  requireFeature(FEATURE_HYGIENE, "Memory hygiene");
  const keep = getClaim(repoId, keepId);
  const drop = getClaim(repoId, dropId);
  if (!keep || !drop) throw new Error("Both claims must exist to merge");
  if (keep.id === drop.id) throw new Error("Cannot merge a claim into itself");
  const anchors = [...new Set([...parseAnchors(keep.code_anchors), ...parseAnchors(drop.code_anchors)])];
  const proposal = applySupersedes(
    {
      claims: [
        {
          id: keep.id,
          kind: keep.kind,
          text: keep.text,
          code_anchors: anchors,
          supersedes: [drop.id],
        },
      ],
    },
    [drop.id],
  );
  applyProposal(repoId, proposal);
  return { keepId: keep.id, dropId: drop.id };
}
