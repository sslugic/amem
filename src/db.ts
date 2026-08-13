import Database from "better-sqlite3";
import { dbPath, ensureAmemHome } from "./paths.js";
import { detectRepoIdentity, newId, type RepoIdentity } from "./repo-identity.js";

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
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS setup_state (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  platforms TEXT NOT NULL,
  setup_completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS claims_repo_idx ON claims(repo_id);
CREATE INDEX IF NOT EXISTS edges_repo_idx ON edges(repo_id);
CREATE INDEX IF NOT EXISTS components_repo_idx ON components(repo_id);
CREATE INDEX IF NOT EXISTS flows_repo_idx ON flows(repo_id);
CREATE INDEX IF NOT EXISTS agent_sessions_repo_idx ON agent_sessions(repo_id);
CREATE INDEX IF NOT EXISTS usage_events_repo_idx ON usage_events(repo_id);
CREATE INDEX IF NOT EXISTS usage_events_created_idx ON usage_events(created_at);
`;

let cached: Database.Database | null = null;

export function openDb(): Database.Database {
  if (cached) return cached;
  ensureAmemHome();
  const db = new Database(dbPath());
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  cached = db;
  return db;
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

export function getRepoByCwd(cwd: string = process.cwd()): RepoRow | null {
  const identity = detectRepoIdentity(cwd);
  const db = openDb();
  const byKey = db
    .prepare("SELECT * FROM repos WHERE repo_key = ?")
    .get(identity.repoKey) as RepoRow | undefined;
  if (byKey) return byKey;

  return (
    (db
      .prepare("SELECT * FROM repos WHERE root_path = ?")
      .get(identity.rootPath) as RepoRow | undefined) ?? null
  );
}

export function requireRepo(cwd: string = process.cwd()): RepoRow {
  const repo = getRepoByCwd(cwd);
  if (!repo) {
    throw new Error(
      "No amem binding for this repo. Run `amem init --platform cursor|claude` first.",
    );
  }
  return repo;
}

export function listClaims(repoId: string): ClaimRow[] {
  return openDb()
    .prepare("SELECT * FROM claims WHERE repo_id = ? ORDER BY updated_at DESC")
    .all(repoId) as ClaimRow[];
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
  openDb().prepare("DELETE FROM repos WHERE id = ?").run(repoId);
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
}): UsageEventRow {
  const id = newId("usage");
  const ts = nowIso();
  openDb()
    .prepare(
      `INSERT INTO usage_events (
         id, repo_id, platform, session_id, query, claim_ids,
         anchors_count, claims_count, packet_tokens, estimated_tokens_saved,
         reported_tokens_saved, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
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
    );
  return openDb().prepare("SELECT * FROM usage_events WHERE id = ?").get(id) as UsageEventRow;
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

export { nowIso };
