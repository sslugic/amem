import Database from "better-sqlite3";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { dbPath, ensureAmemHome } from "./paths.js";
import { detectRepoIdentity, newId, parseWorkspaceSlug, slugifyWorkspace, type RepoIdentity } from "./repo-identity.js";
import { ensureClaimsFts, reindexAllClaimsFts, reindexRepoClaimsFts, removeClaimFts } from "./search.js";

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

CREATE INDEX IF NOT EXISTS claims_repo_idx ON claims(repo_id);
CREATE INDEX IF NOT EXISTS edges_repo_idx ON edges(repo_id);
CREATE INDEX IF NOT EXISTS components_repo_idx ON components(repo_id);
CREATE INDEX IF NOT EXISTS flows_repo_idx ON flows(repo_id);
CREATE INDEX IF NOT EXISTS agent_sessions_repo_idx ON agent_sessions(repo_id);
CREATE INDEX IF NOT EXISTS usage_events_repo_idx ON usage_events(repo_id);
CREATE INDEX IF NOT EXISTS usage_events_created_idx ON usage_events(created_at);
CREATE INDEX IF NOT EXISTS conversation_notes_repo_idx ON conversation_notes(repo_id);
CREATE INDEX IF NOT EXISTS conversation_notes_created_idx ON conversation_notes(created_at);
`;

let cached: Database.Database | null = null;

export function openDb(): Database.Database {
  if (cached) return cached;
  ensureAmemHome();
  const db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrateUsageEvents(db);
  migrateClaimsColumns(db);
  ensureClaimsFts(db);
  migrateClaimsFtsBootstrap(db);
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

export function listClaims(
  repoId: string,
  opts: { includeSuperseded?: boolean } = {},
): ClaimRow[] {
  if (opts.includeSuperseded) {
    return openDb()
      .prepare("SELECT * FROM claims WHERE repo_id = ? ORDER BY updated_at DESC")
      .all(repoId) as ClaimRow[];
  }
  return openDb()
    .prepare(
      `SELECT * FROM claims WHERE repo_id = ?
       AND COALESCE(status, 'active') = 'active'
       ORDER BY updated_at DESC`,
    )
    .all(repoId) as ClaimRow[];
}

export function getClaim(repoId: string, claimId: string): ClaimRow | null {
  return (
    (openDb()
      .prepare("SELECT * FROM claims WHERE repo_id = ? AND id = ?")
      .get(repoId, claimId) as ClaimRow | undefined) ?? null
  );
}

/** Reindex FTS for one repo (after propose apply / wipe helpers). */
export function reindexClaimsSearch(repoId: string): void {
  reindexRepoClaimsFts(openDb(), repoId);
}

export function listComponents(repoId: string): ComponentRow[] {
  return openDb()
    .prepare("SELECT * FROM components WHERE repo_id = ? ORDER BY name")
    .all(repoId) as ComponentRow[];
}

export function listFlows(repoId: string): FlowRow[] {
  return openDb()
    .prepare("SELECT * FROM flows WHERE repo_id = ? ORDER BY name")
    .all(repoId) as FlowRow[];
}

export function listEdges(repoId: string): EdgeRow[] {
  return openDb()
    .prepare("SELECT * FROM edges WHERE repo_id = ?")
    .all(repoId) as EdgeRow[];
}

export function wipeRepo(repoId: string): void {
  const db = openDb();
  const claimIds = db
    .prepare("SELECT id FROM claims WHERE repo_id = ?")
    .all(repoId) as Array<{ id: string }>;
  for (const c of claimIds) {
    removeClaimFts(db, repoId, c.id);
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

export { nowIso };
