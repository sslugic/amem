/**
 * Local memory hygiene: decay unused facts, find near-duplicates, review inbox.
 * Completely free and open — runs on-device, nothing uploaded.
 */
import {
  deleteClaim,
  getClaim,
  listClaims,
  listClaimsAll,
  listProposalDrafts,
  listRepos,
  listUsageEvents,
  setClaimStatus,
  type ClaimRow,
  type RepoRow,
} from "./db.js";
import { createBackup } from "./crypto.js";
import { applyProposal, applySupersedes } from "./proposal.js";
import { tokenJaccard } from "./search.js";
import { parseAnchors } from "./freshness.js";
import { nonFactReason } from "./kinds.js";
import {
  claimUtility,
  findAnchorRot,
  isUnhelpful,
  looksLikeFilePath,
  repoRootUsable,
} from "./utility.js";
import { isHygieneScheduleInstalled } from "./hygiene-schedule.js";

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
  /** Active claims with kind=session (chat noise indicator). */
  sessionCount: number;
  /** sessionCount / active, 0 when empty. */
  sessionRatio: number;
};

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

/** Shared heuristics behind both the preview and the full report. */
function computeHygiene(repoId: string, unusedDays = 90): HygieneReport {
  const claims = listClaims(repoId);
  const used = usedClaimIds(repoId, unusedDays);
  const usedSessions = usedClaimIds(repoId, SESSION_UNUSED_DAYS);
  const utility = claimUtility(repoId, unusedDays);
  // Anchors that all vanished: deterministic rot, independent of attestation.
  const rotted = new Set(findAnchorRot(repoId, claims).map((r) => r.claimId));
  const cutoff = Date.now() - unusedDays * 86_400_000;
  const sessionCutoff = Date.now() - SESSION_UNUSED_DAYS * 86_400_000;
  const stale = claims.filter((c) => {
    if (Number(c.pinned || 0) > 0) return false;
    // Every anchor is gone — the claim cannot be describing this tree any more.
    if (rotted.has(c.id)) return true;
    // Repeatedly handed over and the agent still had to explore. Being returned
    // used to make a claim immune here, which protected exactly the noise that
    // ranks well. Positive evidence of unhelpfulness now overrides that.
    if (isUnhelpful(utility.get(c.id))) return true;
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

function sessionStats(repoId: string): { sessionCount: number; sessionRatio: number; active: number } {
  const claims = listClaims(repoId);
  const active = claims.length;
  const sessionCount = claims.filter((c) => (c.kind || "").toLowerCase() === "session").length;
  const sessionRatio = active > 0 ? sessionCount / active : 0;
  return { sessionCount, sessionRatio, active };
}

/** Counts only, for banners and the Memory view. Never applies changes. */
export function hygienePreview(repoId: string, unusedDays = 90): HygienePreview {
  const report = computeHygiene(repoId, unusedDays);
  const { sessionCount, sessionRatio } = sessionStats(repoId);
  const staleCount = report.stale.length;
  const duplicateCount = report.duplicates.length;
  const removable = Math.min(report.active, staleCount + duplicateCount);
  const afterCleanup = Math.max(0, report.active - removable);
  return {
    active: report.active,
    staleCount,
    duplicateCount,
    pendingDrafts: report.pendingDrafts,
    afterCleanup,
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
  return {
    active,
    staleCount,
    duplicateCount,
    pendingDrafts,
    afterCleanup,
    sessionCount,
    sessionRatio,
  };
}

export function hygieneReport(repoId: string, unusedDays = 90): HygieneReport {
  return computeHygiene(repoId, unusedDays);
}

export function decayStaleClaims(repoId: string, unusedDays = 90): { decayed: string[] } {
  const decayed: string[] = [];
  for (const claim of computeHygiene(repoId, unusedDays).stale) {
    if (setClaimStatus(repoId, claim.id, "decayed")) decayed.push(claim.id);
  }
  return { decayed };
}

export function mergeDuplicate(repoId: string, keepId: string, dropId: string): { keepId: string; dropId: string } {
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

/** Decay unused + merge near-duplicates in one step. */
export function acceptSafeCleanups(
  repoId: string,
  unusedDays = 90,
): { decayed: string[]; merged: Array<{ keepId: string; dropId: string; similarity: number }> } {
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

/**
 * If clear junk is more than this share of a repo's claims, do not delete it
 * unattended. A heuristic that suddenly matches most of the corpus is far more
 * likely to be a broken heuristic than a genuinely rotten memory, and deletion
 * is only reversible from a backup.
 */
export const PURGE_SAFETY_FRACTION = 0.25;

export type ScheduledRepoResult = {
  repoId: string;
  name: string;
  purged: number;
  decayed: number;
  merged: number;
  /** Junk found but left alone because it tripped the safety fraction. */
  purgeHeld: number;
  error?: string;
};

/**
 * Scheduled job: clean every tracked repo without anyone asking.
 *
 * Order matters. Junk is deleted first so it cannot be merged into a good
 * claim, then decay retires rotted and unhelpful claims, then near-duplicates
 * are merged. A safety backup is taken before the first destructive step.
 */
export function runScheduledHygiene(unusedDays = 90): {
  skipped?: boolean;
  reason?: string;
  backup?: string | null;
  repos: ScheduledRepoResult[];
} {
  const repos: ScheduledRepoResult[] = [];
  let backup: string | null = null;
  // Deletion is not reversible from inside amem. Take a copy first, once, and
  // let the job continue if backups are unavailable rather than skipping
  // cleanup entirely.
  try {
    backup = createBackup({ label: "pre-hygiene" }).path;
  } catch {
    backup = null;
  }

  for (const repo of listRepos()) {
    try {
      const active = listClaims(repo.id).length;
      const junk = findNonFactClaims({ repoId: repo.id });
      const overCap = active > 0 && junk.length / active > PURGE_SAFETY_FRACTION;
      let purged = 0;
      if (junk.length && !overCap) {
        purged = purgeNonFactClaims({ repoId: repo.id, dryRun: false }).deleted;
      }
      const result = acceptSafeCleanups(repo.id, unusedDays);
      repos.push({
        repoId: repo.id,
        name: repo.repo_name,
        purged,
        decayed: result.decayed.length,
        merged: result.merged.length,
        purgeHeld: overCap ? junk.length : 0,
      });
    } catch (error) {
      repos.push({
        repoId: repo.id,
        name: repo.repo_name,
        purged: 0,
        decayed: 0,
        merged: 0,
        purgeHeld: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { backup, repos };
}

export type NonFactClaim = {
  repoId: string;
  repoName: string;
  id: string;
  kind: string;
  reason: string;
  preview: string;
};

/** Stored claims that are clear junk. Pinned claims are never included. */
export function findNonFactClaims(opts: { repoId?: string } = {}): NonFactClaim[] {
  const names = new Map(listRepos().map((r) => [r.id, r.repo_name]));
  const claims = opts.repoId ? listClaims(opts.repoId) : listClaimsAll();
  const out: NonFactClaim[] = [];
  for (const claim of claims) {
    if (claim.pinned) continue;
    const reason = nonFactReason(claim.text);
    if (!reason) continue;
    out.push({
      repoId: claim.repo_id,
      repoName: names.get(claim.repo_id) ?? claim.repo_id,
      id: claim.id,
      kind: claim.kind,
      reason,
      preview: claim.text.replace(/\s+/g, " ").slice(0, 120),
    });
  }
  return out;
}

/**
 * Delete clear-junk claims. Always run with dryRun first — deletion is not
 * reversible from inside amem, only from a backup.
 */
export function purgeNonFactClaims(
  opts: { repoId?: string; dryRun?: boolean } = {},
): { scanned: number; matched: NonFactClaim[]; deleted: number; dryRun: boolean } {
  const dryRun = opts.dryRun !== false;
  const scanned = (opts.repoId ? listClaims(opts.repoId) : listClaimsAll()).length;
  const matched = findNonFactClaims({ repoId: opts.repoId });
  let deleted = 0;
  if (!dryRun) {
    for (const row of matched) {
      if (deleteClaim(row.repoId, row.id)) deleted += 1;
    }
  }
  return { scanned, matched, deleted, dryRun };
}

export type CorpusIssue = {
  kind: "phantom-repo" | "duplicate-binding" | "schedule-off";
  /**
   * "fault" is broken state a user should fix; "advice" is a recommendation.
   * Only faults should fail `amem doctor` — an unscheduled machine is a normal
   * fresh install, not a broken one.
   */
  severity: "fault" | "advice";
  message: string;
};

/**
 * Structural problems that quietly ruin memory quality: a repo bound to a
 * directory with no source in it, the same project bound twice, and hygiene
 * never actually being scheduled. None of these show up as a bad claim — they
 * show up as a corpus that slowly stops matching reality.
 */
export function findCorpusIssues(): CorpusIssue[] {
  const issues: CorpusIssue[] = [];
  const repos = listRepos();
  const byName = new Map<string, RepoRow[]>();

  for (const repo of repos) {
    const claims = listClaims(repo.id);
    // A source-less workspace is legitimate — personal prefs live in one and
    // use tag anchors. It is only phantom when claims point at FILES that no
    // directory backs, which means those anchors can never be verified.
    const withFileAnchors = claims.filter((c) =>
      parseAnchors(c.code_anchors).some(looksLikeFilePath),
    ).length;
    if (withFileAnchors > 0 && !repoRootUsable(repo.root_path)) {
      issues.push({
        kind: "phantom-repo",
        severity: "fault",
        message: `Repo "${repo.repo_name}" holds ${withFileAnchors} claim(s) with file anchors but its root has no source: ${repo.root_path}. Those anchors are unverifiable — rebind it or move the memory.`,
      });
    }
    const list = byName.get(repo.repo_name) ?? [];
    list.push(repo);
    byName.set(repo.repo_name, list);
  }

  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const roots = list.map((r) => `${r.root_path} (${listClaims(r.id).length} claims)`).join(", ");
    issues.push({
      kind: "duplicate-binding",
      severity: "fault",
      message: `Project "${name}" is bound ${list.length} times: ${roots}. Memory is being split across them.`,
    });
  }

  if (!isHygieneScheduleInstalled()) {
    issues.push({
      kind: "schedule-off",
      severity: "advice",
      message: "Hygiene is not scheduled — memory will accumulate junk. Run `amem hygiene schedule`.",
    });
  }
  return issues;
}
