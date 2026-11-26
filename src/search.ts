import type Database from "better-sqlite3";
import type { ClaimRow } from "./db.js";

const FTS_TABLE = "claims_fts";
const FTS_MAP = "claims_fts_map";
/** Skills and tasks share one FTS index; claims keep their own (older, per-repo map). */
const ITEMS_FTS = "amem_fts";

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
    "come came find found doesn't don't isn't can't won't it's i'm i've i'd you're that's what's " +
    "sound sounds alright ahead proceed go went gone carry keep going sorry hmm wow lol nice amazing " +
    "idea ideas plan suggestion suggestions option options question questions answer"
  ).split(" "),
);

const SUFFIXES = ["ations", "ation", "ings", "ing", "ions", "ion", "ers", "ed", "es", "ly", "s"];

/**
 * Crude suffix stem, used as a word prefix: "failing" and "failed" both become "fail",
 * "translation" and "translated" both "translat". Identifiers are left alone.
 */
export function stem(token: string): string {
  if (token.length <= 4 || /[0-9_./-]/.test(token)) return token;
  for (const suffix of SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= (suffix === "s" ? 3 : 4)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

/** A ticket key, path, version or name with digits/punctuation: specific on its own. */
export function isIdentifierToken(token: string): boolean {
  return /[a-z]/.test(token) && /[0-9_./-]/.test(token) && token.length >= 3;
}

/** Query words that name a topic: content tokens minus conversational filler. */
export function topicWords(text: string): string[] {
  return [...new Set(contentTokens(text).filter((t) => !CONVERSATIONAL.has(t) && !/^[0-9./-]+$/.test(t)))];
}

/** Topic words stemmed, for matching as word prefixes ("terms" finds "term"). */
export function topicTokens(text: string): string[] {
  return [...new Set(topicWords(text).map(stem))];
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
 * src/hook.ts) or one uncommon word is enough; otherwise two topic words must match.
 * "Uncommon" means memory uses the word, but in at most a tenth of it: a word memory
 * never uses ("sounds") says nothing about the repo, however rare it is.
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
    (t) => {
      if (isIdentifierToken(t)) return true;
      const df = docFreq.get(t) ?? 0;
      return t.length >= 5 && df >= 1 && df <= Math.max(2, total * 0.1);
    },
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

/**
 * FTS5 is compiled into the better-sqlite3 build we ship, but a custom SQLite (or
 * AMEM_DISABLE_FTS=1, used by tests) may lack it. Then every FTS helper turns into a
 * no-op and retrieval falls back to keyword + embedding scoring.
 */
const ftsState = new WeakMap<Database.Database, boolean>();

export function ftsDisabledByEnv(): boolean {
  return process.env.AMEM_DISABLE_FTS === "1";
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(name));
}

/** True when the FTS tables exist on this connection (created by the migration). */
export function ftsReady(db: Database.Database): boolean {
  if (ftsDisabledByEnv()) return false;
  const known = ftsState.get(db);
  if (known !== undefined) return known;
  const ready = tableExists(db, FTS_TABLE) && tableExists(db, ITEMS_FTS);
  if (ready) ftsState.set(db, true);
  return ready;
}

export function ensureClaimsFts(db: Database.Database): void {
  if (ftsDisabledByEnv()) return;
  try {
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
  `);
  } catch {
    // No FTS5 in this SQLite build: keyword fallback.
    return;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${FTS_MAP} (
      repo_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      fts_rowid INTEGER NOT NULL,
      PRIMARY KEY (repo_id, claim_id)
    );
  `);
}

function deleteFtsRow(db: Database.Database, repoId: string, claimId: string): void {
  if (!tableExists(db, FTS_TABLE) || ftsDisabledByEnv()) return;
  const mapped = db
    .prepare(`SELECT fts_rowid AS rowid FROM ${FTS_MAP} WHERE repo_id = ? AND claim_id = ?`)
    .get(repoId, claimId) as { rowid: number } | undefined;
  if (!mapped) return;
  db.prepare(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`).run(mapped.rowid);
  db.prepare(`DELETE FROM ${FTS_MAP} WHERE repo_id = ? AND claim_id = ?`).run(repoId, claimId);
}

export function upsertClaimFts(db: Database.Database, claim: ClaimRow): void {
  if (!tableExists(db, FTS_TABLE) || ftsDisabledByEnv()) return;
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
  if (!tableExists(db, FTS_TABLE) || ftsDisabledByEnv()) return;
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
  if (!tableExists(db, FTS_TABLE) || ftsDisabledByEnv()) return;
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
  const base = buildFtsMatchQuery(query);
  // Synonym members join as OR terms so "auth flow" reaches "JWT login middleware".
  const match = base ? ftsOrQuery(expandQueryTerms(contentTokens(query).slice(0, 12))) : null;
  if (!match || !tableExists(db, FTS_TABLE) || ftsDisabledByEnv()) return [];
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
    // Fall back to the stem as a word start: "failing" finds "failed", "jobs" finds "job".
    if (hay.includes(token) || (stem(token) !== token && wordHit(hay, stem(token)))) {
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

/**
 * Small hand-written synonym groups so natural phrasing reaches the words people
 * actually wrote ("auth flow" finds "JWT login middleware"). No model, no download:
 * a query term in a group adds the other members as OR terms.
 */
const SYNONYM_GROUPS: string[][] = [
  ["auth", "authentication", "authenticate", "login", "signin", "jwt", "token", "oauth", "sso", "session", "credential"],
  ["deploy", "deployment", "release", "rollout", "ship", "publish"],
  ["database", "db", "sqlite", "postgres", "sql", "schema", "migration"],
  ["test", "tests", "testing", "spec", "e2e", "regression", "qa"],
  ["bug", "error", "failure", "crash", "defect", "exception"],
  ["ci", "pipeline", "workflow", "actions"],
  ["config", "configuration", "settings", "env", "environment"],
  ["performance", "perf", "latency", "slow", "speed"],
  ["ui", "frontend", "interface", "dashboard"],
  ["api", "endpoint", "route", "rest"],
  ["docs", "documentation", "readme"],
];
const SYNONYMS = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) for (const w of group) SYNONYMS.set(w, group);

/** Query tokens plus their synonym-group members, deduped, capped. */
export function expandQueryTerms(tokens: string[], cap = 24): string[] {
  const out = new Set<string>();
  for (const t of tokens) {
    out.add(t);
    const group = SYNONYMS.get(t) ?? SYNONYMS.get(stem(t));
    if (group) for (const g of group) out.add(g);
  }
  return [...out].slice(0, cap);
}

function ftsOrQuery(tokens: string[]): string | null {
  const terms = tokens
    .map((t) => t.replace(/["']/g, ""))
    .filter((t) => t.length > 1 && !/^[.]+$/.test(t))
    .map((t) => `"${t}"`);
  return terms.length ? terms.join(" OR ") : null;
}

export type ItemType = "skill" | "task";

export function ensureItemsFts(db: Database.Database): void {
  if (ftsDisabledByEnv()) return;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${ITEMS_FTS} USING fts5(
        type UNINDEXED,
        title,
        body,
        tags,
        ref UNINDEXED,
        repo_id UNINDEXED,
        tokenize = 'porter unicode61'
      );
    `);
  } catch {
    // No FTS5: skills and tasks are searched by keyword instead.
  }
}

export function upsertItemFts(
  db: Database.Database,
  item: { type: ItemType; ref: string; repoId: string | null; title: string; body: string; tags: string[] },
): void {
  if (!tableExists(db, ITEMS_FTS) || ftsDisabledByEnv()) return;
  db.prepare(`DELETE FROM ${ITEMS_FTS} WHERE type = ? AND ref = ?`).run(item.type, item.ref);
  db.prepare(
    `INSERT INTO ${ITEMS_FTS} (type, title, body, tags, ref, repo_id) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(item.type, item.title, item.body, item.tags.join(" "), item.ref, item.repoId ?? "");
}

export function removeItemFts(db: Database.Database, type: ItemType, ref: string): void {
  if (!tableExists(db, ITEMS_FTS) || ftsDisabledByEnv()) return;
  db.prepare(`DELETE FROM ${ITEMS_FTS} WHERE type = ? AND ref = ?`).run(type, ref);
}

/** Drop rows of `type` whose ref is not in `keep` (skills deleted on disk). */
export function pruneItemFts(db: Database.Database, type: ItemType, keep: string[]): void {
  if (!tableExists(db, ITEMS_FTS) || ftsDisabledByEnv()) return;
  const rows = db.prepare(`SELECT rowid, ref FROM ${ITEMS_FTS} WHERE type = ?`).all(type) as Array<{ rowid: number; ref: string }>;
  const live = new Set(keep);
  const del = db.prepare(`DELETE FROM ${ITEMS_FTS} WHERE rowid = ?`);
  for (const r of rows) if (!live.has(r.ref)) del.run(r.rowid);
}

export type ItemHit = { type: ItemType | "claim"; ref: string; repoId: string; bm25: number };

/**
 * One BM25 ranking over facts, skills and tasks. Claims come from claims_fts (scoped by
 * repo ids), skills/tasks from amem_fts (skills are global, tasks per repo).
 * Returns [] when FTS5 is unavailable; callers fall back to keyword scoring.
 */
export function searchAllFts(
  db: Database.Database,
  query: string,
  opts: { repoIds: string[]; types: Array<ItemType | "claim">; limit?: number; expand?: boolean },
): ItemHit[] {
  const base = contentTokens(query).slice(0, 12);
  const match = ftsOrQuery(opts.expand === false ? base : expandQueryTerms(base));
  if (!match || !ftsReady(db)) return [];
  const limit = opts.limit ?? 50;
  const hits: ItemHit[] = [];
  const marks = opts.repoIds.map(() => "?").join(",") || "''";
  try {
    if (opts.types.includes("claim") && opts.repoIds.length) {
      const rows = db
        .prepare(
          `SELECT claim_id AS ref, repo_id AS repoId, bm25(${FTS_TABLE}) AS bm25 FROM ${FTS_TABLE}
           WHERE ${FTS_TABLE} MATCH ? AND repo_id IN (${marks}) ORDER BY bm25 LIMIT ?`,
        )
        .all(match, ...opts.repoIds, limit) as Array<{ ref: string; repoId: string; bm25: number }>;
      for (const r of rows) hits.push({ type: "claim", ...r });
    }
    const itemTypes = opts.types.filter((t): t is ItemType => t === "skill" || t === "task");
    if (itemTypes.length) {
      const rows = db
        .prepare(
          `SELECT type, ref, repo_id AS repoId, bm25(${ITEMS_FTS}) AS bm25 FROM ${ITEMS_FTS}
           WHERE ${ITEMS_FTS} MATCH ? ORDER BY bm25 LIMIT ?`,
        )
        .all(match, limit * 2) as Array<{ type: ItemType; ref: string; repoId: string; bm25: number }>;
      const repoSet = new Set(opts.repoIds);
      for (const r of rows) {
        if (!itemTypes.includes(r.type)) continue;
        if (r.type === "task" && !repoSet.has(r.repoId)) continue;
        hits.push(r);
      }
    }
  } catch {
    return [];
  }
  return hits.sort((a, b) => a.bm25 - b.bm25).slice(0, limit);
}

/** Keyword relevance used when FTS5 is missing: synonym-expanded word-prefix hits. */
export function keywordRelevance(text: string, query: string): number {
  const hay = text.toLowerCase();
  const base = contentTokens(query);
  let score = 0;
  for (const t of expandQueryTerms(base)) {
    const direct = base.includes(t);
    if (wordHit(hay, t) || (stem(t) !== t && wordHit(hay, stem(t)))) score += direct ? 3 : 1.5;
  }
  return score;
}
