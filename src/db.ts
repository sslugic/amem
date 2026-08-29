import Database from "better-sqlite3";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { dbPath, ensureAmemHome } from "./paths.js";
import { detectRepoIdentity, newId, parseWorkspaceSlug, slugifyWorkspace, type RepoIdentity } from "./repo-identity.js";
import { ensureClaimsFts, reindexAllClaimsFts, reindexRepoClaimsFts, removeClaimFts, upsertClaimFts } from "./search.js";
import {
  ensureClaimsEmbed,
  reindexRepoEmbeds,
  removeClaimEmbed,
  upsertClaimEmbed,
} from "./embed.js";
import { isDbEncryptedAtRest, resolvePassphrase, unlockDatabase } from "./crypto.js";

export type RepoRow = {
  id: string;
  repo_key: string;
  remote_url: string | null;
  root_path: string;
  repo_name: string;
  default_branch: string;
  platform: string | null;
  created_at: string;
  updated_at: string;
};

export type ClaimRow = {
  repo_id: string;
  id: string;
  kind: string;
  text: string;
  code_anchors: string;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
  /** active | superseded — superseded claims are excluded from retrieval */
  status: string;
  superseded_by: string | null;
  /** 1 when pinned — boosted in retrieval and sorted first in Memory */
  pinned: number;
};

export type ProposalDraftRow = {
  id: string;
  repo_id: string;
  platform: string;
  session_id: string | null;
  title: string;
  proposal_json: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
};

export type ComponentRow = {
  repo_id: string;
  id: string;
  name: string;
  code_anchor: string | null;
};

export type FlowRow = {
  repo_id: string;
  id: string;
  name: string;
};

export type EdgeRow = {
  repo_id: string;
  id: string;
  from_id: string;
  from_type: string;
  to_id: string;
  to_type: string;
  kind: string;
};

export type UsageEventRow = {
  id: string;
  repo_id: string;
  platform: string;
  session_id: string | null;
  query: string;
  claim_ids: string;
  anchors_count: number;
  claims_count: number;
  packet_tokens: number;
  estimated_tokens_saved: number;
  reported_tokens_saved: number | null;
  created_at: string;
  local_ms: number | null;
  estimated_ms_saved: number | null;
  kind: string | null;
};

export type SessionRow = {
  platform: string;
  session_id: string;
  repo_id: string;
  last_seen: string;
};

export type ConversationNoteRow = {
  id: string;
  repo_id: string;
  platform: string;
  session_id: string | null;
  role: string;
  text: string;
  created_at: string;
};

export type SetupStateRow = {
  repo_id: string;
  platforms: string;
  setup_completed_at: string | null;
  updated_at: string;
};

export type AgentTaskStatus = "backlog" | "next" | "doing" | "blocked" | "done";

export type AgentTaskRow = {
  repo_id: string;
  id: string;
  title: string;
  body: string;
  status: AgentTaskStatus;
  anchors: string;
  source: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export const AGENT_TASK_STATUSES: readonly AgentTaskStatus[] = [
  "backlog",
  "next",
  "doing",
  "blocked",
  "done",
] as const;

export function normalizeTaskStatus(raw: unknown): AgentTaskStatus | null {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  return (AGENT_TASK_STATUSES as readonly string[]).includes(s) ? (s as AgentTaskStatus) : null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  repo_key TEXT NOT NULL UNIQUE,
  remote_url TEXT,
  root_path TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  platform TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS components (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  code_anchor TEXT,
  PRIMARY KEY(repo_id, id)
);

CREATE TABLE IF NOT EXISTS flows (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY(repo_id, id)
);

CREATE TABLE IF NOT EXISTS claims (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  code_anchors TEXT NOT NULL DEFAULT '[]',
  source_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(repo_id, id)
);

CREATE TABLE IF NOT EXISTS edges (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  from_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY(repo_id, id)
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  platform TEXT NOT NULL,
  session_id TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  last_seen TEXT NOT NULL,
  PRIMARY KEY(platform, session_id)
);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  session_id TEXT,
  query TEXT NOT NULL,
  claim_ids TEXT NOT NULL,
  anchors_count INTEGER NOT NULL,
  claims_count INTEGER NOT NULL,
  packet_tokens INTEGER NOT NULL,
  estimated_tokens_saved INTEGER NOT NULL,
  reported_tokens_saved INTEGER,
  created_at TEXT NOT NULL,
  local_ms INTEGER,
  estimated_ms_saved INTEGER,
  kind TEXT
);

CREATE TABLE IF NOT EXISTS setup_state (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  platforms TEXT NOT NULL,
  setup_completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_notes (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  session_id TEXT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposal_drafts (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  session_id TEXT,
  title TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'session-end',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog',
  anchors TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ui',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(repo_id, id)
);

CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  repo_id TEXT REFERENCES repos(id) ON DELETE SET NULL,
  content_hash TEXT NOT NULL,
  origin_hash TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_drafts (
  id TEXT PRIMARY KEY,
  repo_id TEXT REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  content TEXT,
  kind TEXT NOT NULL DEFAULT 'suggestion',
  target_skill TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'session-end',
  session_id TEXT,
  reasons TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_uses (
  id TEXT PRIMARY KEY,
  skill_name TEXT NOT NULL,
  repo_id TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS claims_repo_idx ON claims(repo_id);
CREATE INDEX IF NOT EXISTS edges_repo_idx ON edges(repo_id);
CREATE INDEX IF NOT EXISTS components_repo_idx ON components(repo_id);
CREATE INDEX IF NOT EXISTS flows_repo_idx ON flows(repo_id);
CREATE INDEX IF NOT EXISTS agent_sessions_repo_idx ON agent_sessions(repo_id);
CREATE INDEX IF NOT EXISTS usage_events_repo_idx ON usage_events(repo_id);
CREATE INDEX IF NOT EXISTS usage_events_created_idx ON usage_events(created_at);
CREATE INDEX IF NOT EXISTS conversation_notes_repo_idx ON conversation_notes(repo_id);
CREATE INDEX IF NOT EXISTS conversation_notes_created_idx ON conversation_notes(created_at);
CREATE INDEX IF NOT EXISTS proposal_drafts_repo_idx ON proposal_drafts(repo_id);
CREATE INDEX IF NOT EXISTS proposal_drafts_status_idx ON proposal_drafts(status);
CREATE INDEX IF NOT EXISTS agent_tasks_repo_idx ON agent_tasks(repo_id);
CREATE INDEX IF NOT EXISTS agent_tasks_status_idx ON agent_tasks(repo_id, status);
CREATE INDEX IF NOT EXISTS skills_repo_idx ON skills(repo_id);
CREATE INDEX IF NOT EXISTS skill_drafts_status_idx ON skill_drafts(status);
CREATE INDEX IF NOT EXISTS skill_uses_session_idx ON skill_uses(session_id);
`;

let cached: Database.Database | null = null;

export function openDb(): Database.Database {
  if (cached) return cached;
  ensureAmemHome();
  if (isDbEncryptedAtRest()) {
    try {
      unlockDatabase(resolvePassphrase(process.env.AMEM_PASSPHRASE));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `amem database is encrypted at rest. Unlock with \`amem unlock --passphrase …\` or set AMEM_PASSPHRASE. (${detail})`,
      );
    }
  }
  const db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrateUsageEvents(db);
  migrateClaimsColumns(db);
  ensureClaimsFts(db);
  migrateClaimsFtsBootstrap(db);
  ensureProposalDrafts(db);
  ensureAgentTasks(db);
  ensureClaimsEmbed(db);
  cached = db;
  return db;
}

function migrateUsageEvents(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(usage_events)").all() as { name: string }[];
  const have = new Set(cols.map((c) => c.name));
  if (!have.has("local_ms")) db.exec("ALTER TABLE usage_events ADD COLUMN local_ms INTEGER");
  if (!have.has("estimated_ms_saved")) {
    db.exec("ALTER TABLE usage_events ADD COLUMN estimated_ms_saved INTEGER");
  }
  if (!have.has("kind")) db.exec("ALTER TABLE usage_events ADD COLUMN kind TEXT");
}

function migrateClaimsColumns(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(claims)").all() as { name: string }[];
  const have = new Set(cols.map((c) => c.name));
  if (!have.has("status")) {
    db.exec(`ALTER TABLE claims ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  }
  if (!have.has("superseded_by")) {
    db.exec(`ALTER TABLE claims ADD COLUMN superseded_by TEXT`);
  }
  if (!have.has("pinned")) {
    db.exec(`ALTER TABLE claims ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  }
}

function ensureProposalDrafts(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposal_drafts (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      session_id TEXT,
      title TEXT NOT NULL,
      proposal_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'session-end',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS proposal_drafts_repo_idx ON proposal_drafts(repo_id);
    CREATE INDEX IF NOT EXISTS proposal_drafts_status_idx ON proposal_drafts(status);
  `);
}

function ensureAgentTasks(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog',
      anchors TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'ui',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY(repo_id, id)
    );
    CREATE INDEX IF NOT EXISTS agent_tasks_repo_idx ON agent_tasks(repo_id);
    CREATE INDEX IF NOT EXISTS agent_tasks_status_idx ON agent_tasks(repo_id, status);
  `);
}

/** One-shot FTS rebuild flag so upgrades populate the index. */
function migrateClaimsFtsBootstrap(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS amem_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const row = db
    .prepare(`SELECT value FROM amem_meta WHERE key = 'claims_fts_v1'`)
    .get() as { value: string } | undefined;
  if (row?.value === "1") return;
  reindexAllClaimsFts(db);
  db.prepare(
    `INSERT INTO amem_meta (key, value) VALUES ('claims_fts_v1', '1')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run();
}

export function closeDb(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function upsertRepo(
  identity: RepoIdentity = detectRepoIdentity(),
  platform?: string,
): RepoRow {
  const db = openDb();
  const existing = db
    .prepare("SELECT * FROM repos WHERE repo_key = ?")
    .get(identity.repoKey) as RepoRow | undefined;

  const ts = nowIso();
  if (existing) {
    db.prepare(
      `UPDATE repos SET remote_url = ?, root_path = ?, repo_name = ?, default_branch = ?,
       platform = COALESCE(?, platform), updated_at = ? WHERE id = ?`,
    ).run(
      identity.remoteUrl,
      identity.rootPath,
      identity.repoName,
      identity.defaultBranch,
      platform ?? null,
      ts,
      existing.id,
    );
    return db.prepare("SELECT * FROM repos WHERE id = ?").get(existing.id) as RepoRow;
  }

  const id = newId("repo");
  db.prepare(
    `INSERT INTO repos (id, repo_key, remote_url, root_path, repo_name, default_branch, platform, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    identity.repoKey,
    identity.remoteUrl,
    identity.rootPath,
    identity.repoName,
    identity.defaultBranch,
    platform ?? null,
    ts,
    ts,
  );
  return db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow;
}

function normalizeFsPath(p: string): string {
  const resolved = resolve(p).replace(/[/\\]+$/, "");
  try {
    if (existsSync(resolved)) return realpathSync(resolved);
  } catch {
    // ignore
  }
  return resolved;
}

export function getRepoByCwd(cwd: string = process.cwd()): RepoRow | null {
  const identity = detectRepoIdentity(cwd);
  const db = openDb();
  const byKey = db
    .prepare("SELECT * FROM repos WHERE repo_key = ?")
    .get(identity.repoKey) as RepoRow | undefined;
  if (byKey) return byKey;

  const byExact = db
    .prepare("SELECT * FROM repos WHERE root_path = ?")
    .get(identity.rootPath) as RepoRow | undefined;
  if (byExact) return byExact;

  const want = normalizeFsPath(identity.rootPath);
  const rows = db.prepare("SELECT * FROM repos").all() as RepoRow[];
  return rows.find((r) => normalizeFsPath(r.root_path) === want) ?? null;
}

export function requireRepo(cwd: string = process.cwd()): RepoRow {
  const repo = getRepoByCwd(cwd);
  if (!repo) {
    throw new Error(
      "No amem binding here. Run `amem init --platform cursor|claude` in a git repo, or `amem init --workspace <name>` for an app.",
    );
  }
  return repo;
}

export function getMeta(key: string): string | null {
  const row = openDb()
    .prepare(`SELECT value FROM amem_meta WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  openDb()
    .prepare(
      `INSERT INTO amem_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

export function listClaims(
  repoId: string,
  opts: { includeSuperseded?: boolean } = {},
): ClaimRow[] {
  if (opts.includeSuperseded) {
    return openDb()
      .prepare(
        `SELECT * FROM claims WHERE repo_id = ?
         ORDER BY COALESCE(pinned, 0) DESC, updated_at DESC`,
      )
      .all(repoId) as ClaimRow[];
  }
  return openDb()
    .prepare(
      `SELECT * FROM claims WHERE repo_id = ?
       AND COALESCE(status, 'active') = 'active'
       ORDER BY COALESCE(pinned, 0) DESC, updated_at DESC`,
    )
    .all(repoId) as ClaimRow[];
}

export function listClaimsAll(opts: { includeSuperseded?: boolean } = {}): ClaimRow[] {
  if (opts.includeSuperseded) {
    return openDb()
      .prepare(
        `SELECT * FROM claims
         ORDER BY COALESCE(pinned, 0) DESC, updated_at DESC`,
      )
      .all() as ClaimRow[];
  }
  return openDb()
    .prepare(
      `SELECT * FROM claims
       WHERE COALESCE(status, 'active') = 'active'
       ORDER BY COALESCE(pinned, 0) DESC, updated_at DESC`,
    )
    .all() as ClaimRow[];
}

export function getClaim(repoId: string, claimId: string): ClaimRow | null {
  return (
    (openDb()
      .prepare("SELECT * FROM claims WHERE repo_id = ? AND id = ?")
      .get(repoId, claimId) as ClaimRow | undefined) ?? null
  );
}

export function updateClaim(
  repoId: string,
  claimId: string,
  patch: {
    text?: string;
    kind?: string;
    code_anchors?: string[];
    pinned?: boolean;
  },
): ClaimRow | null {
  const existing = getClaim(repoId, claimId);
  if (!existing) return null;
  const ts = nowIso();
  const text = patch.text !== undefined ? patch.text.trim() : existing.text;
  const kind = patch.kind !== undefined ? patch.kind.trim() : existing.kind;
  const anchors =
    patch.code_anchors !== undefined
      ? JSON.stringify(patch.code_anchors)
      : existing.code_anchors;
  const pinned =
    patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : (existing.pinned ?? 0);
  if (!text || !kind) throw new Error("claim text and kind are required");
  openDb()
    .prepare(
      `UPDATE claims SET text = ?, kind = ?, code_anchors = ?, pinned = ?, updated_at = ?
       WHERE repo_id = ? AND id = ?`,
    )
    .run(text, kind, anchors, pinned, ts, repoId, claimId);
  const updated = getClaim(repoId, claimId);
  if (updated) {
    upsertClaimFts(openDb(), updated);
    upsertClaimEmbed(openDb(), updated);
  }
  return updated;
}

export function setClaimPinned(repoId: string, claimId: string, pinned: boolean): ClaimRow | null {
  return updateClaim(repoId, claimId, { pinned });
}

export function setClaimStatus(
  repoId: string,
  claimId: string,
  status: "active" | "decayed" | "superseded",
): ClaimRow | null {
  const existing = getClaim(repoId, claimId);
  if (!existing) return null;
  const ts = nowIso();
  openDb()
    .prepare(`UPDATE claims SET status = ?, updated_at = ? WHERE repo_id = ? AND id = ?`)
    .run(status, ts, repoId, claimId);
  const updated = getClaim(repoId, claimId);
  if (updated) {
    upsertClaimFts(openDb(), updated);
    if ((updated.status ?? "active") !== "active") removeClaimEmbed(openDb(), repoId, claimId);
    else upsertClaimEmbed(openDb(), updated);
  }
  return updated;
}

export function deleteClaim(repoId: string, claimId: string): boolean {
  const db = openDb();
  removeClaimFts(db, repoId, claimId);
  removeClaimEmbed(db, repoId, claimId);
  const result = db.prepare(`DELETE FROM claims WHERE repo_id = ? AND id = ?`).run(repoId, claimId);
  return Number(result.changes ?? 0) > 0;
}

/** Reindex FTS + local embeddings for one repo (after propose apply / wipe helpers). */
export function reindexClaimsSearch(repoId: string): void {
  const db = openDb();
  reindexRepoClaimsFts(db, repoId);
  reindexRepoEmbeds(db, repoId);
}

export function listComponents(repoId: string): ComponentRow[] {
  return openDb()
    .prepare("SELECT * FROM components WHERE repo_id = ? ORDER BY name")
    .all(repoId) as ComponentRow[];
}

export function listComponentsAll(): ComponentRow[] {
  return openDb().prepare("SELECT * FROM components ORDER BY name").all() as ComponentRow[];
}

export function listFlows(repoId: string): FlowRow[] {
  return openDb()
    .prepare("SELECT * FROM flows WHERE repo_id = ? ORDER BY name")
    .all(repoId) as FlowRow[];
}

export function listFlowsAll(): FlowRow[] {
  return openDb().prepare("SELECT * FROM flows ORDER BY name").all() as FlowRow[];
}

export function listEdges(repoId: string): EdgeRow[] {
  return openDb()
    .prepare("SELECT * FROM edges WHERE repo_id = ?")
    .all(repoId) as EdgeRow[];
}

export function listEdgesAll(): EdgeRow[] {
  return openDb().prepare("SELECT * FROM edges").all() as EdgeRow[];
}

export function wipeRepo(repoId: string): void {
  const db = openDb();
  const claimIds = db
    .prepare("SELECT id FROM claims WHERE repo_id = ?")
    .all(repoId) as Array<{ id: string }>;
  for (const c of claimIds) {
    removeClaimFts(db, repoId, c.id);
    removeClaimEmbed(db, repoId, c.id);
  }
  db.prepare("DELETE FROM repos WHERE id = ?").run(repoId);
}

/** Delete every bound repo (cascade clears claims/flows/usage). Returns count wiped. */
export function wipeAllRepos(): number {
  const db = openDb();
  const row = db.prepare("SELECT COUNT(*) AS c FROM repos").get() as { c: number };
  const repos = db.prepare("SELECT id FROM repos").all() as Array<{ id: string }>;
  for (const r of repos) {
    const claimIds = db
      .prepare("SELECT id FROM claims WHERE repo_id = ?")
      .all(r.id) as Array<{ id: string }>;
    for (const c of claimIds) {
      removeClaimFts(db, r.id, c.id);
      removeClaimEmbed(db, r.id, c.id);
    }
  }
  db.exec("DELETE FROM repos");
  return row.c;
}

export function touchSession(
  platform: string,
  sessionId: string,
  repoId: string,
): void {
  openDb()
    .prepare(
      `INSERT INTO agent_sessions (platform, session_id, repo_id, last_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(platform, session_id) DO UPDATE SET
         repo_id = excluded.repo_id,
         last_seen = excluded.last_seen`,
    )
    .run(platform, sessionId, repoId, nowIso());
}

export function insertUsageEvent(input: {
  repoId: string;
  platform: string;
  sessionId?: string | null;
  query: string;
  claimIds: string[];
  anchorsCount: number;
  claimsCount: number;
  packetTokens: number;
  estimatedTokensSaved: number;
  localMs?: number | null;
  estimatedMsSaved?: number | null;
  kind?: string | null;
}): UsageEventRow {
  const id = newId("usage");
  const ts = nowIso();
  if (input.sessionId) {
    touchSession(input.platform, input.sessionId, input.repoId);
  }
  openDb()
    .prepare(
      `INSERT INTO usage_events (
         id, repo_id, platform, session_id, query, claim_ids,
         anchors_count, claims_count, packet_tokens, estimated_tokens_saved,
         reported_tokens_saved, created_at, local_ms, estimated_ms_saved, kind
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.repoId,
      input.platform,
      input.sessionId ?? null,
      input.query,
      JSON.stringify(input.claimIds),
      input.anchorsCount,
      input.claimsCount,
      input.packetTokens,
      input.estimatedTokensSaved,
      ts,
      input.localMs ?? null,
      input.estimatedMsSaved ?? null,
      input.kind ?? null,
    );
  return openDb().prepare("SELECT * FROM usage_events WHERE id = ?").get(id) as UsageEventRow;
}

export function listSessions(repoId: string): SessionRow[] {
  return openDb()
    .prepare(
      `SELECT * FROM agent_sessions WHERE repo_id = ? ORDER BY last_seen DESC`,
    )
    .all(repoId) as SessionRow[];
}

export function listSessionsAll(): SessionRow[] {
  return openDb()
    .prepare(`SELECT * FROM agent_sessions ORDER BY last_seen DESC`)
    .all() as SessionRow[];
}

export function setReportedTokensSaved(eventId: string, saved: number): UsageEventRow {
  const row = openDb()
    .prepare("SELECT * FROM usage_events WHERE id = ?")
    .get(eventId) as UsageEventRow | undefined;
  if (!row) throw new Error(`Unknown usage event: ${eventId}`);
  openDb()
    .prepare("UPDATE usage_events SET reported_tokens_saved = ? WHERE id = ?")
    .run(saved, eventId);
  return openDb().prepare("SELECT * FROM usage_events WHERE id = ?").get(eventId) as UsageEventRow;
}

export function setReportedOnLatest(
  repoId: string,
  platform: string,
  saved: number,
): UsageEventRow {
  const row = openDb()
    .prepare(
      `SELECT * FROM usage_events WHERE repo_id = ? AND platform = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(repoId, platform) as UsageEventRow | undefined;
  if (!row) throw new Error("No usage events to update for this platform");
  return setReportedTokensSaved(row.id, saved);
}

export function listUsageEvents(opts: {
  repoId?: string | null;
  days?: number;
}): UsageEventRow[] {
  const days = opts.days ?? 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  if (opts.repoId) {
    return openDb()
      .prepare(
        `SELECT * FROM usage_events WHERE repo_id = ? AND created_at >= ?
         ORDER BY created_at DESC`,
      )
      .all(opts.repoId, since) as UsageEventRow[];
  }
  return openDb()
    .prepare(
      `SELECT * FROM usage_events WHERE created_at >= ? ORDER BY created_at DESC`,
    )
    .all(since) as UsageEventRow[];
}

export function listRepos(): RepoRow[] {
  return openDb()
    .prepare("SELECT * FROM repos ORDER BY updated_at DESC")
    .all() as RepoRow[];
}

export function getSetupState(repoId: string): SetupStateRow | null {
  return (
    (openDb()
      .prepare("SELECT * FROM setup_state WHERE repo_id = ?")
      .get(repoId) as SetupStateRow | undefined) ?? null
  );
}

export function upsertSetupState(
  repoId: string,
  platforms: string[],
  completed: boolean,
): SetupStateRow {
  const ts = nowIso();
  const existing = getSetupState(repoId);
  const completedAt = completed
    ? (existing?.setup_completed_at ?? ts)
    : existing?.setup_completed_at ?? null;
  openDb()
    .prepare(
      `INSERT INTO setup_state (repo_id, platforms, setup_completed_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo_id) DO UPDATE SET
         platforms = excluded.platforms,
         setup_completed_at = COALESCE(excluded.setup_completed_at, setup_state.setup_completed_at),
         updated_at = excluded.updated_at`,
    )
    .run(repoId, JSON.stringify(platforms), completed ? completedAt ?? ts : completedAt, ts);
  if (completed && !existing?.setup_completed_at) {
    openDb()
      .prepare("UPDATE setup_state SET setup_completed_at = ? WHERE repo_id = ?")
      .run(ts, repoId);
  }
  return getSetupState(repoId)!;
}

export function getRepoById(id: string): RepoRow | null {
  return (
    (openDb().prepare("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow | undefined) ??
    null
  );
}

export function getRepoByName(name: string): RepoRow | null {
  const byId = getRepoById(name);
  if (byId) return byId;
  const raw = name.trim();
  if (!raw) return null;
  let slug: string;
  try {
    slug = slugifyWorkspace(raw);
  } catch {
    return null;
  }
  const rows = listRepos();
  const lower = raw.toLowerCase();
  return (
    rows.find((r) => parseWorkspaceSlug(r.remote_url) === slug) ??
    rows.find((r) => r.repo_name.toLowerCase() === lower) ??
    rows.find((r) => {
      try {
        return slugifyWorkspace(r.repo_name) === slug;
      } catch {
        return false;
      }
    }) ??
    null
  );
}

/** Change a workspace display name. Keeps id, repo_key, and amem:// slug so memory stays bound. */
export function renameWorkspace(repoId: string, displayName: string): RepoRow {
  const repo = getRepoById(repoId);
  if (!repo) throw new Error("Workspace not found");
  if (!parseWorkspaceSlug(repo.remote_url)) {
    throw new Error("Only named workspaces can be renamed (git repos follow the folder / remote name)");
  }
  const label = displayName.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!label) throw new Error("Name required");
  slugifyWorkspace(label);
  const ts = nowIso();
  openDb()
    .prepare("UPDATE repos SET repo_name = ?, updated_at = ? WHERE id = ?")
    .run(label, ts, repoId);
  return getRepoById(repoId)!;
}

export function insertConversationNote(input: {
  repoId: string;
  platform: string;
  sessionId?: string | null;
  role: string;
  text: string;
}): ConversationNoteRow {
  const id = newId("note");
  const ts = nowIso();
  const text = input.text.trim().slice(0, 2000);
  openDb()
    .prepare(
      `INSERT INTO conversation_notes (id, repo_id, platform, session_id, role, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.repoId, input.platform, input.sessionId ?? null, input.role, text, ts);
  pruneConversationNotes(input.repoId);
  return openDb()
    .prepare("SELECT * FROM conversation_notes WHERE id = ?")
    .get(id) as ConversationNoteRow;
}

function pruneConversationNotes(repoId: string): void {
  const cutoff = openDb()
    .prepare(
      `SELECT created_at FROM conversation_notes WHERE repo_id = ?
       ORDER BY created_at DESC LIMIT 1 OFFSET 100`,
    )
    .get(repoId) as { created_at: string } | undefined;
  if (!cutoff) return;
  openDb()
    .prepare("DELETE FROM conversation_notes WHERE repo_id = ? AND created_at < ?")
    .run(repoId, cutoff.created_at);
}

export function listConversationNotes(repoId: string, limit = 40): ConversationNoteRow[] {
  return openDb()
    .prepare(
      `SELECT * FROM conversation_notes WHERE repo_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(repoId, limit) as ConversationNoteRow[];
}

export function insertProposalDraft(input: {
  repoId: string;
  platform: string;
  sessionId?: string | null;
  title: string;
  proposal: unknown;
  source?: string;
}): ProposalDraftRow {
  const id = newId("draft");
  const ts = nowIso();
  openDb()
    .prepare(
      `INSERT INTO proposal_drafts (
         id, repo_id, platform, session_id, title, proposal_json, status, source, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(
      id,
      input.repoId,
      input.platform,
      input.sessionId ?? null,
      input.title.slice(0, 200),
      JSON.stringify(input.proposal),
      input.source ?? "session-end",
      ts,
      ts,
    );
  return getProposalDraft(id)!;
}

export function getProposalDraft(id: string): ProposalDraftRow | null {
  return (
    (openDb().prepare(`SELECT * FROM proposal_drafts WHERE id = ?`).get(id) as
      | ProposalDraftRow
      | undefined) ?? null
  );
}

export function listProposalDrafts(
  repoId: string,
  opts: { status?: string; limit?: number } = {},
): ProposalDraftRow[] {
  const limit = opts.limit ?? 40;
  if (opts.status) {
    return openDb()
      .prepare(
        `SELECT * FROM proposal_drafts WHERE repo_id = ? AND status = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(repoId, opts.status, limit) as ProposalDraftRow[];
  }
  return openDb()
    .prepare(
      `SELECT * FROM proposal_drafts WHERE repo_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(repoId, limit) as ProposalDraftRow[];
}

export function listProposalDraftsAll(opts: { status?: string; limit?: number } = {}): ProposalDraftRow[] {
  const limit = opts.limit ?? 80;
  if (opts.status) {
    return openDb()
      .prepare(
        `SELECT * FROM proposal_drafts WHERE status = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(opts.status, limit) as ProposalDraftRow[];
  }
  return openDb()
    .prepare(`SELECT * FROM proposal_drafts ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as ProposalDraftRow[];
}

export function countProposalDrafts(repoId: string, status = "pending"): number {
  const row = openDb()
    .prepare(`SELECT COUNT(*) AS n FROM proposal_drafts WHERE repo_id = ? AND status = ?`)
    .get(repoId, status) as { n: number };
  return Number(row?.n || 0);
}

export function countProposalDraftsAll(status = "pending"): number {
  const row = openDb()
    .prepare(`SELECT COUNT(*) AS n FROM proposal_drafts WHERE status = ?`)
    .get(status) as { n: number };
  return Number(row?.n || 0);
}

export function setProposalDraftStatus(
  id: string,
  status: "pending" | "applied" | "dismissed",
): ProposalDraftRow | null {
  const ts = nowIso();
  openDb()
    .prepare(`UPDATE proposal_drafts SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, ts, id);
  return getProposalDraft(id);
}

function encodeTaskAnchors(anchors?: string[] | null): string {
  const list = (anchors ?? [])
    .filter((a): a is string => typeof a === "string" && Boolean(a.trim()))
    .map((a) => a.trim().slice(0, 200))
    .slice(0, 20);
  return JSON.stringify(list);
}

const TASK_STATUS_ORDER: Record<AgentTaskStatus, number> = {
  doing: 0,
  next: 1,
  blocked: 2,
  backlog: 3,
  done: 4,
};

export type SkillRow = {
  name: string;
  path: string;
  description: string;
  version: string | null;
  tags: string;
  repo_id: string | null;
  content_hash: string;
  origin_hash: string | null;
  source: string;
  uses: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

export function listSkillRows(): SkillRow[] {
  return openDb().prepare(`SELECT * FROM skills ORDER BY name`).all() as SkillRow[];
}

export function getSkillRow(name: string): SkillRow | null {
  return (
    (openDb().prepare(`SELECT * FROM skills WHERE name = ?`).get(name) as SkillRow | undefined) ??
    null
  );
}

/**
 * Index one skill found on disk. Disk is the source of truth, so this only ever refreshes
 * derived columns — it must not clobber the repo tag or usage counters a user built up.
 */
export function upsertSkillRow(input: {
  name: string;
  path: string;
  description?: string;
  version?: string | null;
  tags?: string[];
  contentHash: string;
  source?: string;
  repoId?: string | null;
}): SkillRow {
  const ts = nowIso();
  const existing = getSkillRow(input.name);
  const tags = JSON.stringify(input.tags ?? []);
  if (existing) {
    openDb()
      .prepare(
        `UPDATE skills SET path = ?, description = ?, version = ?, tags = ?,
         content_hash = ?, source = ?, updated_at = ? WHERE name = ?`,
      )
      .run(
        input.path,
        input.description ?? "",
        input.version ?? null,
        tags,
        input.contentHash,
        input.source ?? existing.source,
        ts,
        input.name,
      );
    if (input.repoId !== undefined) setSkillRepo(input.name, input.repoId);
    return getSkillRow(input.name)!;
  }
  openDb()
    .prepare(
      `INSERT INTO skills (name, path, description, version, tags, repo_id, content_hash,
        origin_hash, source, uses, last_used_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    )
    .run(
      input.name,
      input.path,
      input.description ?? "",
      input.version ?? null,
      tags,
      input.repoId ?? null,
      input.contentHash,
      input.contentHash,
      input.source ?? "local",
      ts,
      ts,
    );
  return getSkillRow(input.name)!;
}

/** Optional memory tag. Skills are a global library; the tag is only a filter hint. */
export function setSkillRepo(name: string, repoId: string | null): void {
  openDb()
    .prepare(`UPDATE skills SET repo_id = ?, updated_at = ? WHERE name = ?`)
    .run(repoId, nowIso(), name);
}

export function deleteSkillRow(name: string): boolean {
  const info = openDb().prepare(`DELETE FROM skills WHERE name = ?`).run(name);
  return Number(info.changes || 0) > 0;
}

/** Drop index rows whose skill is no longer on disk. */
export function pruneSkillRows(keepNames: string[]): number {
  const keep = new Set(keepNames);
  let removed = 0;
  for (const row of listSkillRows()) {
    if (!keep.has(row.name)) {
      deleteSkillRow(row.name);
      removed += 1;
    }
  }
  return removed;
}

export function recordSkillUse(
  name: string,
  ctx: { repoId?: string | null; sessionId?: string | null } = {},
): void {
  openDb()
    .prepare(`UPDATE skills SET uses = uses + 1, last_used_at = ? WHERE name = ?`)
    .run(nowIso(), name);
  // Per-session trail so session-end can tell which procedures were actually followed.
  openDb()
    .prepare(
      `INSERT INTO skill_uses (id, skill_name, repo_id, session_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(newId("skilluse"), name, ctx.repoId ?? null, ctx.sessionId ?? null, nowIso());
}

/**
 * Skills used recently in a repo. MCP clients do not always carry a session id, so
 * recency in the same memory is the fallback for correlating a view to a session.
 */
export function listRecentSkillUses(repoId: string, minutes = 120, limit = 5): string[] {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const rows = openDb()
    .prepare(
      `SELECT skill_name, MAX(created_at) AS last FROM skill_uses
       WHERE repo_id = ? AND created_at >= ? GROUP BY skill_name ORDER BY last DESC LIMIT ?`,
    )
    .all(repoId, since, limit) as Array<{ skill_name: string }>;
  return rows.map((r) => r.skill_name);
}

export function listSkillsUsedInSession(sessionId: string, limit = 5): string[] {
  if (!sessionId) return [];
  const rows = openDb()
    .prepare(
      `SELECT skill_name, MAX(created_at) AS last FROM skill_uses
       WHERE session_id = ? GROUP BY skill_name ORDER BY last DESC LIMIT ?`,
    )
    .all(sessionId, limit) as Array<{ skill_name: string }>;
  return rows.map((r) => r.skill_name);
}

export type SkillDraftRow = {
  id: string;
  repo_id: string | null;
  name: string | null;
  title: string;
  summary: string;
  content: string | null;
  kind: string;
  target_skill: string | null;
  status: string;
  source: string;
  session_id: string | null;
  reasons: string;
  created_at: string;
  updated_at: string;
};

export function insertSkillDraft(input: {
  repoId?: string | null;
  name?: string | null;
  title: string;
  summary?: string;
  content?: string | null;
  kind?: "suggestion" | "create" | "revision";
  targetSkill?: string | null;
  source?: string;
  sessionId?: string | null;
  reasons?: string[];
}): SkillDraftRow {
  const id = newId("skilldraft");
  const ts = nowIso();
  openDb()
    .prepare(
      `INSERT INTO skill_drafts (id, repo_id, name, title, summary, content, kind, target_skill,
        status, source, session_id, reasons, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.repoId ?? null,
      input.name ?? null,
      input.title,
      input.summary ?? "",
      input.content ?? null,
      input.kind ?? "suggestion",
      input.targetSkill ?? null,
      input.source ?? "session-end",
      input.sessionId ?? null,
      JSON.stringify(input.reasons ?? []),
      ts,
      ts,
    );
  return getSkillDraft(id)!;
}

export function getSkillDraft(id: string): SkillDraftRow | null {
  return (
    (openDb().prepare(`SELECT * FROM skill_drafts WHERE id = ?`).get(id) as
      | SkillDraftRow
      | undefined) ?? null
  );
}

export function listSkillDrafts(
  opts: { status?: string; repoId?: string; limit?: number } = {},
): SkillDraftRow[] {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.status) {
    where.push("status = ?");
    args.push(opts.status);
  }
  if (opts.repoId) {
    where.push("repo_id = ?");
    args.push(opts.repoId);
  }
  const sql = `SELECT * FROM skill_drafts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
  return openDb()
    .prepare(sql)
    .all(...args, limit) as SkillDraftRow[];
}

export function setSkillDraftStatus(id: string, status: string): SkillDraftRow | null {
  openDb()
    .prepare(`UPDATE skill_drafts SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, nowIso(), id);
  return getSkillDraft(id);
}

export function skillDraftExists(source: string): boolean {
  const row = openDb()
    .prepare(`SELECT 1 AS hit FROM skill_drafts WHERE source = ? LIMIT 1`)
    .get(source) as { hit: number } | undefined;
  return Boolean(row);
}

export function getTask(repoId: string, id: string): AgentTaskRow | null {
  return (
    (openDb()
      .prepare(`SELECT * FROM agent_tasks WHERE repo_id = ? AND id = ?`)
      .get(repoId, id) as AgentTaskRow | undefined) ?? null
  );
}

export function listTasks(
  repoId: string,
  opts: { status?: AgentTaskStatus; includeDone?: boolean; limit?: number } = {},
): AgentTaskRow[] {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
  let rows: AgentTaskRow[];
  if (opts.status) {
    rows = openDb()
      .prepare(
        `SELECT * FROM agent_tasks WHERE repo_id = ? AND status = ?
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(repoId, opts.status, limit) as AgentTaskRow[];
  } else if (opts.includeDone) {
    rows = openDb()
      .prepare(
        `SELECT * FROM agent_tasks WHERE repo_id = ?
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(repoId, limit) as AgentTaskRow[];
  } else {
    rows = openDb()
      .prepare(
        `SELECT * FROM agent_tasks WHERE repo_id = ? AND status != 'done'
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(repoId, limit) as AgentTaskRow[];
  }
  return rows.sort(
    (a, b) =>
      (TASK_STATUS_ORDER[a.status] ?? 9) - (TASK_STATUS_ORDER[b.status] ?? 9) ||
      b.updated_at.localeCompare(a.updated_at),
  );
}

/**
 * Tasks across every memory. The UI's "All memory" scope needs this because agents file
 * tasks against whatever repo they were working in, which is often not the repo the UI
 * was launched from — without it those tasks are invisible.
 */
export function listTasksAll(
  opts: { status?: AgentTaskStatus; includeDone?: boolean; limit?: number } = {},
): AgentTaskRow[] {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  let rows: AgentTaskRow[];
  if (opts.status) {
    rows = openDb()
      .prepare(`SELECT * FROM agent_tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ?`)
      .all(opts.status, limit) as AgentTaskRow[];
  } else if (opts.includeDone) {
    rows = openDb()
      .prepare(`SELECT * FROM agent_tasks ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as AgentTaskRow[];
  } else {
    rows = openDb()
      .prepare(`SELECT * FROM agent_tasks WHERE status != 'done' ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as AgentTaskRow[];
  }
  return rows.sort(
    (a, b) =>
      (TASK_STATUS_ORDER[a.status] ?? 9) - (TASK_STATUS_ORDER[b.status] ?? 9) ||
      b.updated_at.localeCompare(a.updated_at),
  );
}

export function countTasksAll(opts: { status?: AgentTaskStatus; openOnly?: boolean } = {}): number {
  if (opts.status) {
    const row = openDb()
      .prepare(`SELECT COUNT(*) AS n FROM agent_tasks WHERE status = ?`)
      .get(opts.status) as { n: number };
    return Number(row?.n || 0);
  }
  if (opts.openOnly) {
    const row = openDb()
      .prepare(`SELECT COUNT(*) AS n FROM agent_tasks WHERE status != 'done'`)
      .get() as { n: number };
    return Number(row?.n || 0);
  }
  const row = openDb().prepare(`SELECT COUNT(*) AS n FROM agent_tasks`).get() as { n: number };
  return Number(row?.n || 0);
}

/** Find a task without knowing its repo, so all-memory edits can resolve their owner. */
export function findTaskAnyRepo(id: string): AgentTaskRow | null {
  return (
    (openDb().prepare(`SELECT * FROM agent_tasks WHERE id = ?`).get(id) as
      | AgentTaskRow
      | undefined) ?? null
  );
}

/** Open tasks for context injection — prefer doing/next/blocked, then backlog. */
export function listOpenTasksForContext(repoId: string, limit = 8): AgentTaskRow[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM agent_tasks WHERE repo_id = ? AND status != 'done'
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(repoId, Math.max(limit * 3, 24)) as AgentTaskRow[];
  return rows
    .sort(
      (a, b) =>
        (TASK_STATUS_ORDER[a.status] ?? 9) - (TASK_STATUS_ORDER[b.status] ?? 9) ||
        b.updated_at.localeCompare(a.updated_at),
    )
    .slice(0, limit);
}

export function countTasks(
  repoId: string,
  opts: { status?: AgentTaskStatus; openOnly?: boolean } = {},
): number {
  if (opts.status) {
    const row = openDb()
      .prepare(`SELECT COUNT(*) AS n FROM agent_tasks WHERE repo_id = ? AND status = ?`)
      .get(repoId, opts.status) as { n: number };
    return Number(row?.n || 0);
  }
  if (opts.openOnly) {
    const row = openDb()
      .prepare(`SELECT COUNT(*) AS n FROM agent_tasks WHERE repo_id = ? AND status != 'done'`)
      .get(repoId) as { n: number };
    return Number(row?.n || 0);
  }
  const row = openDb()
    .prepare(`SELECT COUNT(*) AS n FROM agent_tasks WHERE repo_id = ?`)
    .get(repoId) as { n: number };
  return Number(row?.n || 0);
}

export function insertTask(input: {
  repoId: string;
  title: string;
  body?: string;
  status?: AgentTaskStatus | string;
  anchors?: string[];
  source?: string;
}): AgentTaskRow {
  const title = String(input.title || "")
    .trim()
    .slice(0, 200);
  if (!title) throw new Error("title is required");
  const status = normalizeTaskStatus(input.status) || "backlog";
  const id = newId("task");
  const ts = nowIso();
  const completed = status === "done" ? ts : null;
  openDb()
    .prepare(
      `INSERT INTO agent_tasks (
         repo_id, id, title, body, status, anchors, source, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.repoId,
      id,
      title,
      String(input.body || "").slice(0, 4000),
      status,
      encodeTaskAnchors(input.anchors),
      String(input.source || "ui").slice(0, 80),
      ts,
      ts,
      completed,
    );
  return getTask(input.repoId, id)!;
}

export function updateTask(
  repoId: string,
  id: string,
  patch: {
    title?: string;
    body?: string;
    status?: AgentTaskStatus | string;
    anchors?: string[];
  },
): AgentTaskRow | null {
  const existing = getTask(repoId, id);
  if (!existing) return null;
  const ts = nowIso();
  let title = existing.title;
  let body = existing.body;
  let status = existing.status;
  let anchors = existing.anchors;
  let completedAt = existing.completed_at;

  if (typeof patch.title === "string") {
    const t = patch.title.trim().slice(0, 200);
    if (!t) throw new Error("title cannot be empty");
    title = t;
  }
  if (typeof patch.body === "string") body = patch.body.slice(0, 4000);
  if (patch.status !== undefined) {
    const next = normalizeTaskStatus(patch.status);
    if (!next) throw new Error("invalid status");
    status = next;
    if (status === "done") completedAt = completedAt || ts;
    else completedAt = null;
  }
  if (patch.anchors !== undefined) anchors = encodeTaskAnchors(patch.anchors);

  openDb()
    .prepare(
      `UPDATE agent_tasks SET title = ?, body = ?, status = ?, anchors = ?,
       updated_at = ?, completed_at = ? WHERE repo_id = ? AND id = ?`,
    )
    .run(title, body, status, anchors, ts, completedAt, repoId, id);
  return getTask(repoId, id);
}

export function completeTask(repoId: string, id: string): AgentTaskRow | null {
  return updateTask(repoId, id, { status: "done" });
}

export function deleteTask(repoId: string, id: string): boolean {
  const info = openDb()
    .prepare(`DELETE FROM agent_tasks WHERE repo_id = ? AND id = ?`)
    .run(repoId, id);
  return Number(info.changes || 0) > 0;
}

export { nowIso };
