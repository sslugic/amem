import type Database from "better-sqlite3";
import type { ClaimRow } from "./db.js";

const FTS_TABLE = "claims_fts";
const FTS_MAP = "claims_fts_map";

/** Tokenize for keyword fallback / conflict heuristics. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 1);
}

/** Build a safe FTS5 MATCH string from a free-text query (OR of quoted terms). */
export function buildFtsMatchQuery(query: string): string | null {
  const tokens = tokenize(query)
    .map((t) => t.replace(/"/g, "").replace(/'/g, ""))
    .filter((t) => t.length > 1 && !/^[.]+$/.test(t));
  if (tokens.length === 0) return null;
  // Cap terms so pathological queries stay cheap
  const terms = tokens.slice(0, 12).map((t) => `"${t}"`);
  return terms.join(" OR ");
}

export function ensureClaimsFts(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
      kind,
      text,
      anchors,
      id_text,
      repo_id UNINDEXED,
      claim_id UNINDEXED,
      tokenize = 'porter unicode61'
    );
    CREATE TABLE IF NOT EXISTS ${FTS_MAP} (
      repo_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      fts_rowid INTEGER NOT NULL,
      PRIMARY KEY (repo_id, claim_id)
    );
  `);
}

function deleteFtsRow(db: Database.Database, repoId: string, claimId: string): void {
  const mapped = db
    .prepare(`SELECT fts_rowid AS rowid FROM ${FTS_MAP} WHERE repo_id = ? AND claim_id = ?`)
    .get(repoId, claimId) as { rowid: number } | undefined;
  if (!mapped) return;
  db.prepare(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`).run(mapped.rowid);
  db.prepare(`DELETE FROM ${FTS_MAP} WHERE repo_id = ? AND claim_id = ?`).run(repoId, claimId);
}

export function upsertClaimFts(db: Database.Database, claim: ClaimRow): void {
  if ((claim.status ?? "active") !== "active") {
    deleteFtsRow(db, claim.repo_id, claim.id);
    return;
  }
  deleteFtsRow(db, claim.repo_id, claim.id);
  const result = db
    .prepare(
      `INSERT INTO ${FTS_TABLE} (kind, text, anchors, id_text, repo_id, claim_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      claim.kind,
      claim.text,
      claim.code_anchors,
      claim.id,
      claim.repo_id,
      claim.id,
    );
  const rowid = Number(result.lastInsertRowid);
  db.prepare(
    `INSERT INTO ${FTS_MAP} (repo_id, claim_id, fts_rowid) VALUES (?, ?, ?)`,
  ).run(claim.repo_id, claim.id, rowid);
}

export function removeClaimFts(db: Database.Database, repoId: string, claimId: string): void {
  deleteFtsRow(db, repoId, claimId);
}

export function reindexRepoClaimsFts(db: Database.Database, repoId: string): void {
  const mapped = db
    .prepare(`SELECT claim_id, fts_rowid FROM ${FTS_MAP} WHERE repo_id = ?`)
    .all(repoId) as Array<{ claim_id: string; fts_rowid: number }>;
  for (const row of mapped) {
    db.prepare(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`).run(row.fts_rowid);
  }
  db.prepare(`DELETE FROM ${FTS_MAP} WHERE repo_id = ?`).run(repoId);

  const claims = db
    .prepare(
      `SELECT * FROM claims WHERE repo_id = ? AND COALESCE(status, 'active') = 'active'`,
    )
    .all(repoId) as ClaimRow[];
  for (const claim of claims) {
    upsertClaimFts(db, claim);
  }
}

export function reindexAllClaimsFts(db: Database.Database): void {
  const mapped = db
    .prepare(`SELECT fts_rowid FROM ${FTS_MAP}`)
    .all() as Array<{ fts_rowid: number }>;
  for (const row of mapped) {
    try {
      db.prepare(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`).run(row.fts_rowid);
    } catch {
      // ignore missing row
    }
  }
  db.exec(`DELETE FROM ${FTS_MAP}`);
  const repos = db.prepare(`SELECT id FROM repos`).all() as Array<{ id: string }>;
  for (const r of repos) {
    reindexRepoClaimsFts(db, r.id);
  }
}

export type FtsHit = { id: string; bm25: number };

/**
 * Rank active claims via FTS5 + bm25 (more negative = better).
 * Returns empty on MATCH errors or empty query.
 */
export function searchClaimsFts(
  db: Database.Database,
  repoId: string,
  query: string,
  limit = 24,
): FtsHit[] {
  const match = buildFtsMatchQuery(query);
  if (!match) return [];
  try {
    return db
      .prepare(
        `SELECT claim_id AS id, bm25(${FTS_TABLE}) AS bm25
         FROM ${FTS_TABLE}
         WHERE ${FTS_TABLE} MATCH ? AND repo_id = ?
         ORDER BY bm25
         LIMIT ?`,
      )
      .all(match, repoId, limit) as FtsHit[];
  } catch {
    return [];
  }
}

/** Convert bm25 (lower/more negative is better) into a positive boost. */
export function ftsBoostFromBm25(bm25: number): number {
  return 18 / (1 + Math.abs(bm25));
}

export function keywordScoreClaim(claim: ClaimRow, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const hay = `${claim.id} ${claim.kind} ${claim.text} ${claim.code_anchors}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (hay.includes(token)) {
      score += token.length > 4 ? 3 : 2;
      if (claim.text.toLowerCase().includes(token)) score += 1;
      if (claim.id.toLowerCase().includes(token)) score += 2;
    }
  }
  return score;
}

/** Jaccard similarity over token sets (0–1). */
export function tokenJaccard(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}
