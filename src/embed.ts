/**
 * On-device "embeddings" via feature hashing (no model download).
 * Hybrid with FTS: cheap cosine over hashed token bags.
 */
import type Database from "better-sqlite3";
import type { ClaimRow } from "./db.js";
import { tokenize } from "./search.js";

export const EMBED_DIM = 128;

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % EMBED_DIM;
}

export function embedText(text: string): Float32Array {
  const vec = new Float32Array(EMBED_DIM);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vec;
  for (const t of tokens) {
    const i = hashToken(t);
    // signed hashing trick
    const sign = hashToken(`s:${t}`) % 2 === 0 ? 1 : -1;
    vec[i] += sign;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) vec[i] = vec[i]! / norm;
  return vec;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

export function vectorToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToVector(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

export function ensureClaimsEmbed(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS claims_embed (
      repo_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repo_id, claim_id)
    );
  `);
}

export function upsertClaimEmbed(db: Database.Database, claim: ClaimRow): void {
  ensureClaimsEmbed(db);
  const text = `${claim.id} ${claim.kind} ${claim.text} ${claim.code_anchors}`;
  const vec = embedText(text);
  db.prepare(
    `INSERT INTO claims_embed (repo_id, claim_id, dim, vector, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, claim_id) DO UPDATE SET
       dim = excluded.dim,
       vector = excluded.vector,
       updated_at = excluded.updated_at`,
  ).run(claim.repo_id, claim.id, EMBED_DIM, vectorToBlob(vec), claim.updated_at);
}

export function removeClaimEmbed(db: Database.Database, repoId: string, claimId: string): void {
  ensureClaimsEmbed(db);
  db.prepare(`DELETE FROM claims_embed WHERE repo_id = ? AND claim_id = ?`).run(repoId, claimId);
}

export function reindexRepoEmbeds(db: Database.Database, repoId: string): void {
  ensureClaimsEmbed(db);
  db.prepare(`DELETE FROM claims_embed WHERE repo_id = ?`).run(repoId);
  const claims = db
    .prepare(
      `SELECT * FROM claims WHERE repo_id = ? AND COALESCE(status, 'active') = 'active'`,
    )
    .all(repoId) as ClaimRow[];
  for (const c of claims) upsertClaimEmbed(db, c);
}

export type EmbedHit = { id: string; score: number };

export function searchClaimsEmbed(
  db: Database.Database,
  repoId: string,
  query: string,
  limit = 24,
): EmbedHit[] {
  ensureClaimsEmbed(db);
  const qv = embedText(query);
  if (tokenize(query).length === 0) return [];
  const rows = db
    .prepare(`SELECT claim_id AS id, vector FROM claims_embed WHERE repo_id = ?`)
    .all(repoId) as Array<{ id: string; vector: Buffer }>;
  const scored = rows
    .map((r) => ({ id: r.id, score: cosine(qv, blobToVector(r.vector)) }))
    .filter((r) => r.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}

/** Convert cosine (0..1-ish) into a ranking boost comparable to FTS. */
export function embedBoostFromScore(score: number): number {
  return Math.max(0, score) * 14;
}
