/**
 * Local memory hygiene: decay unused facts, find near-duplicates, review inbox.
 * Apply/schedule is Pro/IT only. Preview counts are free (soft paywall).
 * Nothing is uploaded.
 */
import {
  getClaim,
  listClaims,
  listProposalDrafts,
  listRepos,
  listUsageEvents,
  setClaimStatus,
  type ClaimRow,
} from "./db.js";
import { FEATURE_HYGIENE, hasFeature, requireFeature } from "./license.js";
import { applyProposal, applySupersedes } from "./proposal.js";
import { tokenJaccard } from "./search.js";
import { parseAnchors } from "./freshness.js";
import { anchorsOverlap } from "./anchors.js";

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

export type HygienePreview = {
  active: number;
  staleCount: number;
  duplicateCount: number;
  pendingDrafts: number;
  /** Estimated active count after decay + merge */
  afterCleanup: number;
  softPaywall: boolean;
  /** Active claims with kind=session (chat noise indicator). */
  sessionCount: number;
  /** sessionCount / active, 0 when empty. */
  sessionRatio: number;
};

export const SOFT_PAYWALL_FACTS = 200;
export const SOFT_PAYWALL_NOISE = 15;
/** Soft-paywall when session chat takeaways dominate the graph. */
export const SOFT_PAYWALL_SESSION_RATIO = 0.55;
export const SOFT_PAYWALL_SESSION_MIN = 25;
/** Unused unpinned session claims become decay candidates sooner than durable kinds. */
export const SESSION_UNUSED_DAYS = 14;

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

/** Shared heuristics — no license gate (used by free preview + Pro report). */
function computeHygiene(repoId: string, unusedDays = 90): HygieneReport {
  const claims = listClaims(repoId);
  const used = usedClaimIds(repoId, unusedDays);
  const usedSessions = usedClaimIds(repoId, SESSION_UNUSED_DAYS);
  const cutoff = Date.now() - unusedDays * 86_400_000;
  const sessionCutoff = Date.now() - SESSION_UNUSED_DAYS * 86_400_000;
  const stale = claims.filter((c) => {
    if (Number(c.pinned || 0) > 0) return false;
    const updated = Date.parse(c.updated_at);
    if (!Number.isFinite(updated)) return false;
    const isSession = (c.kind || "").toLowerCase() === "session";
    if (isSession) {
      if (usedSessions.has(c.id)) return false;
      return updated < sessionCutoff;
    }
    if (used.has(c.id)) return false;
    return updated < cutoff;
  });

  const duplicates: HygieneDuplicate[] = [];
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i]!;
      const b = claims[j]!;
      const sim = tokenJaccard(a.text, b.text);
      if (sim < 0.72) continue;
      const aAnchors = parseAnchors(a.code_anchors);
      const bAnchors = parseAnchors(b.code_anchors);
      const share = anchorsOverlap(aAnchors, bAnchors);
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

function sessionStats(repoId: string): { sessionCount: number; sessionRatio: number; active: number } {
  const claims = listClaims(repoId);
  const active = claims.length;
  const sessionCount = claims.filter((c) => (c.kind || "").toLowerCase() === "session").length;
  const sessionRatio = active > 0 ? sessionCount / active : 0;
  return { sessionCount, sessionRatio, active };
}

function softPaywallFrom(preview: {
  active: number;
  staleCount: number;
  duplicateCount: number;
  sessionCount: number;
  sessionRatio: number;
}): boolean {
  if (hasFeature(FEATURE_HYGIENE)) return false;
  const noise = preview.staleCount + preview.duplicateCount;
  if (preview.active >= SOFT_PAYWALL_FACTS || noise >= SOFT_PAYWALL_NOISE) return true;
  if (
    preview.sessionCount >= SOFT_PAYWALL_SESSION_MIN &&
    preview.sessionRatio >= SOFT_PAYWALL_SESSION_RATIO
  ) {
    return true;
  }
  return false;
}

/** Free: counts only for soft paywall / banners. Never applies changes. */
export function hygienePreview(repoId: string, unusedDays = 90): HygienePreview {
  const report = computeHygiene(repoId, unusedDays);
  const { sessionCount, sessionRatio } = sessionStats(repoId);
  const staleCount = report.stale.length;
  const duplicateCount = report.duplicates.length;
  const removable = Math.min(report.active, staleCount + duplicateCount);
  const afterCleanup = Math.max(0, report.active - removable);
  const softPaywall = softPaywallFrom({
    active: report.active,
    staleCount,
    duplicateCount,
    sessionCount,
    sessionRatio,
  });
  return {
    active: report.active,
    staleCount,
    duplicateCount,
    pendingDrafts: report.pendingDrafts,
    afterCleanup,
    softPaywall,
    sessionCount,
    sessionRatio,
  };
}

/** Aggregate preview across all tracked repos (for All memory scope). */
export function hygienePreviewAll(unusedDays = 90): HygienePreview {
  let active = 0;
  let staleCount = 0;
  let duplicateCount = 0;
  let pendingDrafts = 0;
  let sessionCount = 0;
  for (const repo of listRepos()) {
    const p = hygienePreview(repo.id, unusedDays);
    active += p.active;
    staleCount += p.staleCount;
    duplicateCount += p.duplicateCount;
    pendingDrafts += p.pendingDrafts;
    sessionCount += p.sessionCount;
  }
  const removable = Math.min(active, staleCount + duplicateCount);
  const afterCleanup = Math.max(0, active - removable);
  const sessionRatio = active > 0 ? sessionCount / active : 0;
  const softPaywall = softPaywallFrom({
    active,
    staleCount,
    duplicateCount,
    sessionCount,
    sessionRatio,
  });
  return {
    active,
    staleCount,
    duplicateCount,
    pendingDrafts,
    afterCleanup,
    softPaywall,
    sessionCount,
    sessionRatio,
  };
}

export function hygieneReport(repoId: string, unusedDays = 90): HygieneReport {
  requireFeature(FEATURE_HYGIENE, "Memory hygiene");
  return computeHygiene(repoId, unusedDays);
}

export function decayStaleClaims(repoId: string, unusedDays = 90): { decayed: string[] } {
  requireFeature(FEATURE_HYGIENE, "Memory hygiene");
  const decayed: string[] = [];
  for (const claim of computeHygiene(repoId, unusedDays).stale) {
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

/** Decay unused + merge near-duplicates in one step (Pro/IT). */
export function acceptSafeCleanups(
  repoId: string,
  unusedDays = 90,
): { decayed: string[]; merged: Array<{ keepId: string; dropId: string; similarity: number }> } {
  requireFeature(FEATURE_HYGIENE, "Memory hygiene");
  const report = computeHygiene(repoId, unusedDays);
  const decayed: string[] = [];
  for (const claim of report.stale) {
    if (setClaimStatus(repoId, claim.id, "decayed")) decayed.push(claim.id);
  }
  const decayedSet = new Set(decayed);
  const gone = new Set<string>(decayed);
  const merged: Array<{ keepId: string; dropId: string; similarity: number }> = [];
  const ordered = [...report.duplicates].sort((a, b) => b.similarity - a.similarity);
  for (const d of ordered) {
    if (gone.has(d.keepId) || gone.has(d.dropId)) continue;
    if (decayedSet.has(d.keepId) || decayedSet.has(d.dropId)) continue;
    try {
      mergeDuplicate(repoId, d.keepId, d.dropId);
      merged.push(d);
      gone.add(d.dropId);
    } catch {
      // claim may have been removed mid-loop
    }
  }
  return { decayed, merged };
}

/** Scheduled job: clean every tracked repo when licensed. */
export function runScheduledHygiene(unusedDays = 90): {
  skipped?: boolean;
  reason?: string;
  repos: Array<{
    repoId: string;
    name: string;
    decayed: number;
    merged: number;
    error?: string;
  }>;
} {
  if (!hasFeature(FEATURE_HYGIENE)) {
    return { skipped: true, reason: "Pro/IT license required for hygiene", repos: [] };
  }
  const repos: Array<{
    repoId: string;
    name: string;
    decayed: number;
    merged: number;
    error?: string;
  }> = [];
  for (const repo of listRepos()) {
    try {
      const result = acceptSafeCleanups(repo.id, unusedDays);
      repos.push({
        repoId: repo.id,
        name: repo.repo_name,
        decayed: result.decayed.length,
        merged: result.merged.length,
      });
    } catch (error) {
      repos.push({
        repoId: repo.id,
        name: repo.repo_name,
        decayed: 0,
        merged: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { repos };
}
