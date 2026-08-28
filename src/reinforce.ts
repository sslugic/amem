import type Database from "better-sqlite3";
import {
  listUsageEvents,
  openDb,
  type ClaimRow,
} from "./db.js";
import { tokenize, tokenJaccard } from "./search.js";

const FEEDBACK_TABLE = "claim_feedback";
const ASSOC_TABLE = "query_claim_assoc";

/** Stable key from a query: top distinctive tokens, sorted. */
export function queryKey(query: string, maxTokens = 6): string {
  const tokens = tokenize(query)
    .filter((t) => t.length > 2)
    .slice(0, 16);
  const ranked = [...tokens].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const top = ranked.slice(0, maxTokens).sort();
  return top.join(" ") || tokenize(query).slice(0, maxTokens).sort().join(" ");
}

export function ensureReinforceTables(db: Database.Database = openDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${FEEDBACK_TABLE} (
      repo_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      last_hit_at TEXT NOT NULL,
      PRIMARY KEY (repo_id, claim_id)
    );
    CREATE TABLE IF NOT EXISTS ${ASSOC_TABLE} (
      repo_id TEXT NOT NULL,
      query_key TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      last_hit_at TEXT NOT NULL,
      PRIMARY KEY (repo_id, query_key, claim_id)
    );
    CREATE INDEX IF NOT EXISTS claim_feedback_repo_idx ON ${FEEDBACK_TABLE}(repo_id);
    CREATE INDEX IF NOT EXISTS query_claim_assoc_repo_idx ON ${ASSOC_TABLE}(repo_id, query_key);
  `);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Record that these claims helped answer a query (local_hit).
 * Silently no-ops on empty claim lists.
 */
export function recordClaimHelpful(
  repoId: string,
  query: string,
  claimIds: string[],
): void {
  const ids = [...new Set(claimIds.filter((id) => id && id.trim()))];
  if (ids.length === 0) return;
  const db = openDb();
  ensureReinforceTables(db);
  const ts = nowIso();
  const key = queryKey(query);
  const bumpFeedback = db.prepare(`
    INSERT INTO ${FEEDBACK_TABLE} (repo_id, claim_id, hit_count, last_hit_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(repo_id, claim_id) DO UPDATE SET
      hit_count = hit_count + 1,
      last_hit_at = excluded.last_hit_at
  `);
  const bumpAssoc = db.prepare(`
    INSERT INTO ${ASSOC_TABLE} (repo_id, query_key, claim_id, hit_count, last_hit_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(repo_id, query_key, claim_id) DO UPDATE SET
      hit_count = hit_count + 1,
      last_hit_at = excluded.last_hit_at
  `);
  const tx = db.transaction(() => {
    for (const id of ids) {
      bumpFeedback.run(repoId, id, ts);
      if (key) bumpAssoc.run(repoId, key, id, ts);
    }
  });
  tx();
}

export type ClaimHitStats = { claimId: string; hitCount: number; lastHitAt: string };

export function listClaimFeedback(repoId: string): ClaimHitStats[] {
  ensureReinforceTables();
  return openDb()
    .prepare(
      `SELECT claim_id AS claimId, hit_count AS hitCount, last_hit_at AS lastHitAt
       FROM ${FEEDBACK_TABLE} WHERE repo_id = ? ORDER BY hit_count DESC`,
    )
    .all(repoId) as ClaimHitStats[];
}

export function claimHitCountMap(repoId: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of listClaimFeedback(repoId)) {
    map.set(row.claimId, row.hitCount);
  }
  return map;
}

/** Assoc hits for this query key (and close neighbors via shared tokens). */
export function assocBoostMap(repoId: string, query: string): Map<string, number> {
  ensureReinforceTables();
  const key = queryKey(query);
  const map = new Map<string, number>();
  if (!key) return map;
  const db = openDb();
  const exact = db
    .prepare(
      `SELECT claim_id AS claimId, hit_count AS hitCount
       FROM ${ASSOC_TABLE} WHERE repo_id = ? AND query_key = ?`,
    )
    .all(repoId, key) as Array<{ claimId: string; hitCount: number }>;
  for (const row of exact) {
    map.set(row.claimId, (map.get(row.claimId) ?? 0) + row.hitCount * 3);
  }

  // Soft match: overlapping query keys
  const qTokens = new Set(key.split(" ").filter(Boolean));
  if (qTokens.size === 0) return map;
  const others = db
    .prepare(
      `SELECT query_key AS queryKey, claim_id AS claimId, hit_count AS hitCount
       FROM ${ASSOC_TABLE} WHERE repo_id = ? AND query_key != ?`,
    )
    .all(repoId, key) as Array<{ queryKey: string; claimId: string; hitCount: number }>;
  for (const row of others) {
    const parts = row.queryKey.split(" ").filter(Boolean);
    let inter = 0;
    for (const t of parts) if (qTokens.has(t)) inter += 1;
    if (inter === 0) continue;
    const j = inter / (qTokens.size + parts.length - inter);
    if (j < 0.34) continue;
    map.set(row.claimId, (map.get(row.claimId) ?? 0) + row.hitCount * j);
  }
  return map;
}

/**
 * Positive ranking boost from prior helpful hits.
 * Caps so reinforcement cannot drown keyword/FTS/embed.
 */
export function reinforceBoostForClaim(
  claimId: string,
  hitCounts: Map<string, number>,
  assocBoosts: Map<string, number>,
): { boost: number; reason?: string } {
  const hits = hitCounts.get(claimId) ?? 0;
  const assoc = assocBoosts.get(claimId) ?? 0;
  if (hits <= 0 && assoc <= 0) return { boost: 0 };
  // log-ish curve: 1→3, 5→7, 20→12, …
  const fromHits = hits > 0 ? Math.min(14, 2.5 * Math.log2(1 + hits) + 1) : 0;
  const fromAssoc = assoc > 0 ? Math.min(12, 2 * Math.log2(1 + assoc) + 1) : 0;
  const boost = Math.min(22, fromHits + fromAssoc);
  if (boost < 0.5) return { boost: 0 };
  const reason =
    assoc > 0 && hits > 0
      ? `helped×${hits}+q`
      : assoc > 0
        ? "helped:q"
        : `helped×${hits}`;
  return { boost, reason };
}

/** Backfill reinforcement from recent local_hit usage events (idempotent-ish via max). */
export function backfillReinforcementFromUsage(repoId: string, days = 90): number {
  ensureReinforceTables();
  const events = listUsageEvents({ repoId, days }).filter(
    (e) => e.kind === "local_hit" || (e.claims_count > 0 && e.kind !== "server_trip"),
  );
  let n = 0;
  for (const e of events) {
    let ids: string[] = [];
    try {
      ids = JSON.parse(e.claim_ids || "[]") as string[];
    } catch {
      ids = [];
    }
    if (ids.length === 0) continue;
    recordClaimHelpful(repoId, e.query, ids);
    n += 1;
  }
  return n;
}

/** Score how related a prior miss query is to a claim (for gap UI). */
export function claimCoversQuery(claim: ClaimRow, query: string): boolean {
  return tokenJaccard(claim.text, query) >= 0.2 || tokenJaccard(claim.id, query) >= 0.25;
}
