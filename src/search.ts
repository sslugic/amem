import type Database from "better-sqlite3";
import type { ClaimRow } from "./db.js";

const FTS_TABLE = "claims_fts";
const FTS_MAP = "claims_fts_map";

/** Tokenize for keyword fallback / conflict heuristics. */
/**
 * Words that carry no topic. Left in, they make every claim and task match every
 * question ("what is the status of …" matched all of them through "the", "is", "of").
 */
const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does doing for from had has have how i if in into is it its " +
    "me my of on or our so than that the their them then there these they this to us was we were what when where " +
    "which who why will with would you your yes no not ok okay please thanks just also about any some all more " +
    "should shall may might am get got go going make made let lets now new use using used work worked working"
  ).split(" "),
);

/** Query tokens that carry meaning: tokenize() minus stopwords (falls back to all tokens). */
export function contentTokens(text: string): string[] {
  const all = tokenize(text);
  const content = all.filter((t) => !STOPWORDS.has(t));
  return content.length > 0 ? content : all;
}

/**
 * Conversational words: they say how the user feels or what to do next, not what the
 * prompt is about. A small repo makes them look rare ("think" in one memory), so rarity
 * alone cannot tell "is this good?" from "why is TEST-109 failing?".
 */
const CONVERSATIONAL = new Set(
  (
    "want wants wanted need needs needed like liked love keep kept try tried trying think thought " +
    "know knew see seen look looks looking looked good great nice nicer better best bad worse fine " +
    "cool awesome perfect right wrong sure maybe really very much many little bit lot lots thing things " +
    "stuff way something anything everything nothing one two first next last again still already " +
    "even only back up down out over here there well yeah yep nope hey hi hello thank thx pls " +
    "give take put tell show shows help let's ask asked said say says done do doing start continue " +
    "until reach reaches reached rate rating improve improvements improvement update updated " +
    "clean cleanup fix fixed change changes changed add added remove check checked feel feels " +
    "seem seems seemed going gonna wanna gotta able time times today day days week tomorrow " +
    "yesterday everyone someone people user users other others same different whole each every " +
    "since while after before though because cause actually basically probably also too " +
    "come came find found doesn't don't isn't can't won't it's i'm i've i'd you're that's what's"
  ).split(" "),
);

/** A ticket key, path, version or name with digits/punctuation: specific on its own. */
export function isIdentifierToken(token: string): boolean {
  return /[a-z]/.test(token) && /[0-9_./-]/.test(token) && token.length >= 3;
}

/** Query words that name a topic: content tokens minus filler, plurals trimmed ("terms" finds "term"). */
export function topicTokens(text: string): string[] {
  return [
    ...new Set(
      contentTokens(text)
        .filter((t) => !CONVERSATIONAL.has(t) && !/^[0-9./-]+$/.test(t))
        .map((t) => (t.length > 4 && /[^s]s$/.test(t) ? t.slice(0, -1) : t)),
    ),
  ];
}

/** Does `token` start a word in `hay` (lower-cased)? "flake" matches "flaky", not "snowflake". */
export function wordHit(hay: string, token: string): boolean {
  let i = hay.indexOf(token);
  while (i !== -1) {
    if (i === 0 || /[^a-z0-9]/.test(hay[i - 1]!)) return true;
    i = hay.indexOf(token, i + 1);
  }
  return false;
}

/**
 * Is `text` about the question, judged by topic words? One identifier (TEST-109,
 * src/hook.ts) or one uncommon word (in at most a tenth of the memories) is enough;
 * otherwise two topic words must match.
 */
export function matchesTopic(
  text: string,
  topics: string[],
  docFreq: Map<string, number>,
  total: number,
): boolean {
  const hay = text.toLowerCase();
  const hits = topics.filter((t) => wordHit(hay, t));
  if (hits.length >= 2) return true;
  return hits.some(
    (t) => isIdentifierToken(t) || (t.length >= 5 && (docFreq.get(t) ?? 0) <= Math.max(2, total * 0.1)),
  );
}

/** How many of `texts` contain each topic word. */
export function topicDocFreq(texts: string[], topics: string[]): Map<string, number> {
  const lower = texts.map((t) => t.toLowerCase());
  return new Map(topics.map((t) => [t, lower.filter((h) => wordHit(h, t)).length]));
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 1);
}

/** Build a safe FTS5 MATCH string from a free-text query (OR of quoted terms). */
export function buildFtsMatchQuery(query: string): string | null {
  const tokens = contentTokens(query)
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
