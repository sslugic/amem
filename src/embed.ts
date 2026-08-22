/**
 * On-device embeddings. Default is feature hashing (no download).
 * Pro can switch to a local n-gram encoder (still no cloud, no model fetch).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { ClaimRow } from "./db.js";
import { FEATURE_LOCAL_EMBED, hasFeature } from "./license.js";
import { amemHome } from "./paths.js";
import { tokenize } from "./search.js";

export const HASH_DIM = 128;
export const NGRAM_DIM = 256;
/** @deprecated use HASH_DIM — kept so older tests keep compiling */
export const EMBED_DIM = HASH_DIM;

export type EmbedBackend = "hash" | "ngram" | "external";

export type EmbedStatus = {
  backend: EmbedBackend;
  requested: EmbedBackend;
  dim: number;
  licensed: boolean;
  path: string;
  command?: string;
  args: string[];
};

function embedSettingsPath(): string {
  return join(amemHome(), "embed.json");
}

type EmbedSettings = {
  backend?: string;
  command?: string;
  args?: string[];
  dim?: number;
};

function readEmbedSettings(): EmbedSettings {
  const path = embedSettingsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as EmbedSettings;
  } catch {
    return {};
  }
}

export function requestedEmbedBackend(): EmbedBackend {
  const env = (process.env.AMEM_EMBED_BACKEND || "").trim().toLowerCase();
  if (env === "hash" || env === "ngram" || env === "external") return env;
  const raw = readEmbedSettings().backend;
  if (raw === "ngram" || raw === "external") return raw;
  return "hash";
}

export function activeEmbedBackend(): EmbedBackend {
  const requested = requestedEmbedBackend();
  if ((requested === "ngram" || requested === "external") && hasFeature(FEATURE_LOCAL_EMBED)) {
    return requested;
  }
  return "hash";
}

export function embedDim(backend: EmbedBackend = activeEmbedBackend()): number {
  if (backend === "ngram") return NGRAM_DIM;
  if (backend === "external") {
    const n = Number(process.env.AMEM_EMBED_DIM || readEmbedSettings().dim || 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : HASH_DIM;
  }
  return HASH_DIM;
}

export function embedCommand(): { command?: string; args: string[] } {
  const settings = readEmbedSettings();
  const command = (process.env.AMEM_EMBED_CMD || settings.command || "").trim() || undefined;
  const args = Array.isArray(settings.args) ? settings.args.filter((a) => typeof a === "string") : [];
  return { command, args };
}

export function embedStatus(): EmbedStatus {
  const requested = requestedEmbedBackend();
  const backend = activeEmbedBackend();
  const { command, args } = embedCommand();
  return {
    backend,
    requested,
    dim: embedDim(backend),
    licensed: hasFeature(FEATURE_LOCAL_EMBED),
    path: embedSettingsPath(),
    command,
    args,
  };
}

export function setEmbedBackend(
  backend: EmbedBackend,
  extra: { command?: string; args?: string[]; dim?: number } = {},
): EmbedStatus {
  if ((backend === "ngram" || backend === "external") && !hasFeature(FEATURE_LOCAL_EMBED)) {
    throw new Error(
      "Local embeddings need an amem Pro or IT license. Buy at https://getamem.com then: amem license apply --file <amem-license.json>",
    );
  }
  if (backend === "external" && !(extra.command || process.env.AMEM_EMBED_CMD || readEmbedSettings().command)) {
    throw new Error("external embedder needs --cmd (stdin text → stdout JSON { vector: number[] })");
  }
  mkdirSync(amemHome(), { recursive: true, mode: 0o700 });
  const prev = readEmbedSettings();
  const next: EmbedSettings = {
    backend,
    command: extra.command ?? prev.command,
    args: extra.args ?? prev.args,
    dim: extra.dim ?? prev.dim,
  };
  writeFileSync(embedSettingsPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return embedStatus();
}

function parseExternalVector(raw: string): Float32Array {
  const trimmed = raw.trim();
  let values: number[] = [];
  try {
    const parsed = JSON.parse(trimmed) as { vector?: unknown } | unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { vector?: unknown }).vector;
    if (Array.isArray(list)) values = list.map((n) => Number(n));
  } catch {
    values = trimmed.split(/[\s,]+/).map((n) => Number(n));
  }
  const clean = values.filter((n) => Number.isFinite(n));
  if (clean.length < 4) throw new Error("external embedder returned no usable vector");
  return normalize(Float32Array.from(clean));
}

export function embedExternal(text: string): Float32Array {
  const { command, args } = embedCommand();
  if (!command) throw new Error("No AMEM_EMBED_CMD / embed.json command configured");
  const out = execFileSync(command, args, {
    input: text,
    encoding: "utf8",
    timeout: 8000,
    maxBuffer: 2_000_000,
    windowsHide: true,
  });
  return parseExternalVector(out);
}

function hashToken(token: string, dim: number): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % dim;
}

function addToken(vec: Float32Array, token: string, dim: number): void {
  const i = hashToken(token, dim);
  const sign = hashToken(`s:${token}`, dim) % 2 === 0 ? 1 : -1;
  vec[i] += sign;
}

function normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}

function embedHash(text: string): Float32Array {
  const vec = new Float32Array(HASH_DIM);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vec;
  for (const t of tokens) addToken(vec, t, HASH_DIM);
  return normalize(vec);
}

/** Local n-gram encoder: word tokens + char 3-grams + token pairs. No download. */
export function embedNgram(text: string): Float32Array {
  const vec = new Float32Array(NGRAM_DIM);
  const tokens = tokenize(text);
  const chars = text.toLowerCase().replace(/\s+/g, " ");
  for (const t of tokens) addToken(vec, t, NGRAM_DIM);
  for (let i = 0; i < tokens.length - 1; i++) {
    addToken(vec, `${tokens[i]}_${tokens[i + 1]}`, NGRAM_DIM);
  }
  for (let i = 0; i < chars.length - 2; i++) {
    addToken(vec, `c:${chars.slice(i, i + 3)}`, NGRAM_DIM);
  }
  return normalize(vec);
}

export function embedText(text: string, backend: EmbedBackend = activeEmbedBackend()): Float32Array {
  if (backend === "ngram") return embedNgram(text);
  if (backend === "external") {
    try {
      return embedExternal(text);
    } catch {
      return embedHash(text);
    }
  }
  return embedHash(text);
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
  const cols = db.prepare(`PRAGMA table_info(claims_embed)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "backend")) {
    db.exec(`ALTER TABLE claims_embed ADD COLUMN backend TEXT NOT NULL DEFAULT 'hash'`);
  }
}

export function upsertClaimEmbed(db: Database.Database, claim: ClaimRow): void {
  ensureClaimsEmbed(db);
  const backend = activeEmbedBackend();
  const text = `${claim.id} ${claim.kind} ${claim.text} ${claim.code_anchors}`;
  const vec = embedText(text, backend);
  db.prepare(
    `INSERT INTO claims_embed (repo_id, claim_id, dim, vector, updated_at, backend)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, claim_id) DO UPDATE SET
       dim = excluded.dim,
       vector = excluded.vector,
       updated_at = excluded.updated_at,
       backend = excluded.backend`,
  ).run(claim.repo_id, claim.id, vec.length, vectorToBlob(vec), claim.updated_at, backend);
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

export function reindexAllEmbeds(db: Database.Database): { repos: number; claims: number } {
  ensureClaimsEmbed(db);
  const repos = db.prepare(`SELECT DISTINCT repo_id AS id FROM claims`).all() as Array<{ id: string }>;
  let claims = 0;
  for (const repo of repos) {
    reindexRepoEmbeds(db, repo.id);
    claims += (
      db
        .prepare(`SELECT COUNT(*) AS n FROM claims_embed WHERE repo_id = ?`)
        .get(repo.id) as { n: number }
    ).n;
  }
  return { repos: repos.length, claims };
}

export type EmbedIndexHealth = {
  active: EmbedBackend;
  dim: number;
  total: number;
  usable: number;
  stale: number;
  strandedBy: Array<{ backend: string; dim: number; count: number }>;
};

/**
 * Stored vectors are only scored when their backend *and* dim match the active one, so a
 * backend switch (usually a license change) silently drops facts out of semantic ranking
 * without any error. This reports that drift so doctor/attest can tell the user to reindex.
 */
export function embedIndexHealth(db: Database.Database): EmbedIndexHealth {
  ensureClaimsEmbed(db);
  const active = activeEmbedBackend();
  const dim = embedDim(active);
  const rows = db
    .prepare(
      `SELECT COALESCE(backend, 'hash') AS backend, dim, COUNT(*) AS n
       FROM claims_embed GROUP BY backend, dim`,
    )
    .all() as Array<{ backend: string; dim: number; n: number }>;

  let total = 0;
  let usable = 0;
  const strandedBy: EmbedIndexHealth["strandedBy"] = [];
  for (const row of rows) {
    total += row.n;
    if (row.backend === active && row.dim === dim) usable += row.n;
    else strandedBy.push({ backend: row.backend, dim: row.dim, count: row.n });
  }
  return { active, dim, total, usable, stale: total - usable, strandedBy };
}

/** Human-readable warnings for doctor/attest. Empty when the index is consistent. */
export function embedIndexIssues(db: Database.Database): string[] {
  let health: EmbedIndexHealth;
  try {
    health = embedIndexHealth(db);
  } catch {
    return [];
  }
  if (health.stale === 0) return [];
  const from = health.strandedBy
    .map((s) => `${s.backend}/${s.dim}`)
    .join(", ");
  return [
    `${health.stale} of ${health.total} facts are indexed with ${from} but the active embed backend is ${health.active}/${health.dim} — semantic search skips them. Run: amem embed reindex`,
  ];
}

export type EmbedHit = { id: string; score: number };

export function searchClaimsEmbed(
  db: Database.Database,
  repoId: string,
  query: string,
  limit = 24,
): EmbedHit[] {
  return searchClaimsEmbedBackend(db, repoId, query, activeEmbedBackend(), limit);
}

/**
 * Live embed ranking for a forced backend (hash vs ngram showdown).
 * Scores active claim texts against the query without requiring stored rows for that backend.
 */
export function searchClaimsEmbedLive(
  claims: ClaimRow[],
  query: string,
  backend: EmbedBackend,
  limit = 24,
): EmbedHit[] {
  if (tokenize(query).length === 0) return [];
  const qv = embedText(query, backend);
  const scored = claims
    .map((c) => {
      const text = `${c.id} ${c.kind} ${c.text} ${c.code_anchors}`;
      return { id: c.id, score: cosine(qv, embedText(text, backend)) };
    })
    .filter((r) => r.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}

function searchClaimsEmbedBackend(
  db: Database.Database,
  repoId: string,
  query: string,
  backend: EmbedBackend,
  limit = 24,
): EmbedHit[] {
  ensureClaimsEmbed(db);
  const qv = embedText(query, backend);
  if (tokenize(query).length === 0) return [];
  const rows = db
    .prepare(
      `SELECT claim_id AS id, vector FROM claims_embed
       WHERE repo_id = ? AND dim = ? AND COALESCE(backend, 'hash') = ?`,
    )
    .all(repoId, qv.length, backend) as Array<{ id: string; vector: Buffer }>;
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
