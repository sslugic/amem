/**
 * Local activity log behind the live Activity view.
 *
 * One row per MCP tool call, hook run or CLI command: which client made it, which
 * action, which way data flowed, how big the answer was and how long it took.
 * Metadata only. Memory text, prompts, tool arguments and results are never stored:
 * the only free-form inputs are the client name (sanitised) and an action name that
 * must come from a fixed vocabulary.
 *
 * Off switch: AMEM_ACTIVITY=off (or 0/false). Logging never throws into the caller.
 */
import { openDb, listUsageEvents, type UsageEventRow } from "./db.js";
import { savingsBasis } from "./estimate.js";

export type ActivityChannel = "mcp" | "hook" | "cli";
/** in = the client hands amem data; out = amem feeds context back to the client. */
export type ActivityDirection = "in" | "out";

export type ActivityEvent = {
  id: number;
  ts: string;
  client: string;
  channel: ActivityChannel;
  action: string;
  direction: ActivityDirection;
  ok: boolean;
  resultBytes: number;
  latencyMs: number;
};

type ActivityRow = {
  id: number;
  ts: string;
  client: string;
  channel: string;
  action: string;
  direction: string;
  ok: number;
  result_bytes: number;
  latency_ms: number;
};

/** Rows kept at most; older rows are trimmed. */
export const ACTIVITY_MAX_ROWS = 20_000;
/** Days kept at most. */
export const ACTIVITY_RETENTION_DAYS = 30;
const PRUNE_EVERY = 250;

export function activityEnabled(): boolean {
  const v = String(process.env.AMEM_ACTIVITY ?? "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

/** Tools that write into amem. Everything else an MCP client calls reads from it. */
const MCP_IN = new Set([
  "amem_remember",
  "amem_supersede",
  "amem_skill_save",
  "amem_task_add",
  "amem_task_update",
  "amem_task_complete",
  "amem_usage_report",
]);

const CLI_IN = new Set([
  "remember",
  "supersede",
  "propose",
  "session",
  "rename",
  "backup",
  "rules",
]);

/** CLI verbs that may be logged as a sub-action. Anything else (free text) is dropped. */
const CLI_VERBS = new Set([
  "add", "list", "ls", "update", "complete", "done", "view", "show", "save", "export",
  "install", "uninstall", "status", "run", "apply", "rebuild", "on", "off", "scan", "sync",
  "approve", "reject", "remove", "delete", "start", "stop", "check", "report", "attest",
  "backfill", "create", "move", "edit", "index", "verify", "new", "rm", "import", "drafts",
  "dismiss", "schedule", "unschedule", "validate", "diff",
]);

const CLI_IN_VERBS = new Set([
  "add", "update", "complete", "done", "save", "approve", "reject", "remove", "delete",
  "move", "edit", "attest", "backfill", "create", "restore", "new", "rm", "import", "dismiss",
]);

/** Map a client name from MCP clientInfo, a User-Agent or a hook into a short stable id. */
export function normalizeClient(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s.includes("claude-code") || s.includes("claude code") || s === "claude") return "claude-code";
  if (s.includes("claude-ai") || s.includes("claude desktop") || s.includes("claude-desktop")) {
    return "claude-desktop";
  }
  if (s.includes("cursor")) return "cursor";
  if (s.includes("codex")) return "codex";
  if (s.includes("windsurf") || s.includes("codeium")) return "windsurf";
  if (s.includes("copilot") || s.includes("vscode") || s.includes("visual studio code")) return "vscode";
  if (s.includes("gemini")) return "gemini";
  if (s.includes("zed")) return "zed";
  if (s.includes("cline")) return "cline";
  const clean = s.replace(/[^a-z0-9._ -]/g, "").replace(/\s+/g, "-").slice(0, 32);
  return clean || "unknown";
}

/** Only identifiers from a fixed shape reach the log; anything else becomes "other". */
function safeAction(raw: string): string {
  const s = String(raw || "").trim();
  return /^[A-Za-z][A-Za-z0-9_:. -]{0,47}$/.test(s) ? s : "other";
}

export function mcpDirection(tool: string): ActivityDirection {
  return MCP_IN.has(tool) ? "in" : "out";
}

/** The logged action for a CLI call: the command, plus a known verb if one follows. */
export function cliAction(positional: string[]): { action: string; direction: ActivityDirection } | null {
  const cmd = String(positional[0] ?? "").trim();
  // hook/mcp log themselves; ui/app are long-running; the rest remove or lock the store,
  // and logging afterwards would recreate or touch it.
  const skip = ["hook", "mcp", "ui", "app", "help", "--help", "-h", "uninstall", "wipe", "lock", "unlock", "restore"];
  if (!cmd || skip.includes(cmd)) return null;
  if (!/^[a-z][a-z-]{0,23}$/.test(cmd)) return null;
  const verb = String(positional[1] ?? "").trim().toLowerCase();
  const hasVerb = CLI_VERBS.has(verb);
  const action = hasVerb ? `${cmd} ${verb}` : cmd;
  const direction: ActivityDirection =
    CLI_IN.has(cmd) || (hasVerb && CLI_IN_VERBS.has(verb)) ? "in" : "out";
  return { action, direction };
}

let inserts = 0;

export function recordActivity(input: {
  client: string;
  channel: ActivityChannel;
  action: string;
  direction: ActivityDirection;
  ok?: boolean;
  resultBytes?: number;
  latencyMs?: number;
}): void {
  if (!activityEnabled()) return;
  try {
    const db = openDb();
    db.prepare(
      `INSERT INTO activity_events (ts, client, channel, action, direction, ok, result_bytes, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      normalizeClient(input.client),
      input.channel,
      safeAction(input.action),
      input.direction === "in" ? "in" : "out",
      input.ok === false ? 0 : 1,
      Math.max(0, Math.round(input.resultBytes ?? 0)),
      Math.max(0, Math.round(input.latencyMs ?? 0)),
    );
    inserts += 1;
    // Short-lived processes (hooks, CLI) rarely reach the counter; give them a small chance.
    if (inserts % PRUNE_EVERY === 0 || Math.random() < 1 / PRUNE_EVERY) pruneActivity();
  } catch {
    // A locked or missing database must never break the call being logged.
  }
}

export function pruneActivity(
  opts: { maxRows?: number; retentionDays?: number } = {},
): number {
  const maxRows = opts.maxRows ?? ACTIVITY_MAX_ROWS;
  const days = opts.retentionDays ?? ACTIVITY_RETENTION_DAYS;
  const db = openDb();
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  let removed = db.prepare(`DELETE FROM activity_events WHERE ts < ?`).run(cutoff).changes;
  removed += db
    .prepare(
      `DELETE FROM activity_events WHERE id <= (
         SELECT id FROM activity_events ORDER BY id DESC LIMIT 1 OFFSET ?
       )`,
    )
    .run(maxRows).changes;
  return removed;
}

function toEvent(r: ActivityRow): ActivityEvent {
  return {
    id: r.id,
    ts: r.ts,
    client: r.client,
    channel: r.channel as ActivityChannel,
    action: r.action,
    direction: r.direction === "in" ? "in" : "out",
    ok: r.ok === 1,
    resultBytes: r.result_bytes,
    latencyMs: r.latency_ms,
  };
}

/** Newest first when no cursor; oldest first after `sinceId` (for streaming). */
export function listActivity(opts: { sinceId?: number; limit?: number } = {}): ActivityEvent[] {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 500);
  const db = openDb();
  if (opts.sinceId != null && Number.isFinite(opts.sinceId)) {
    return (
      db
        .prepare(`SELECT * FROM activity_events WHERE id > ? ORDER BY id ASC LIMIT ?`)
        .all(Math.floor(opts.sinceId), limit) as ActivityRow[]
    ).map(toEvent);
  }
  return (
    db.prepare(`SELECT * FROM activity_events ORDER BY id DESC LIMIT ?`).all(limit) as ActivityRow[]
  ).map(toEvent);
}

/** Every client id with at least one logged call (within the retained log). */
export function activityClientIds(): string[] {
  const rows = openDb().prepare(`SELECT DISTINCT client FROM activity_events`).all() as Array<{ client: string }>;
  return rows.map((r) => r.client).filter(Boolean);
}

export function latestActivityId(): number {
  const row = openDb().prepare(`SELECT MAX(id) AS id FROM activity_events`).get() as
    | { id: number | null }
    | undefined;
  return row?.id ?? 0;
}

export type ClientStats = {
  client: string;
  calls: number;
  in: number;
  out: number;
  errors: number;
  bytesOut: number;
  avgLatencyMs: number;
  lastSeen: string | null;
  /** One row per client and channel: Claude Code over MCP and its hooks are separate lanes. */
  channel: ActivityChannel;
};

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * What amem did for the agents in a window, split by how much each number can be trusted.
 * "measured" comes from attested events: real sizes of files the agent did not have to open.
 * "estimate" is the model's figure for every context packet and is labelled as such.
 * There is deliberately no time or "% faster" figure: nothing here measures wall clock.
 */
export function savingsSummary(events: UsageEventRow[]) {
  let attested = 0;
  let measuredTokens = 0;
  let readsAvoided = 0;
  let readsOpened = 0;
  let estimatedTokens = 0;
  for (const e of events) {
    estimatedTokens += e.estimated_tokens_saved ?? 0;
    if (!e.attested_at) continue;
    attested += 1;
    measuredTokens += e.reported_tokens_saved ?? 0;
    const opened = new Set(parseList(e.anchors_opened_json));
    const returned = parseList(e.anchors_json);
    readsOpened += returned.filter((a) => opened.has(a)).length;
    readsAvoided += returned.filter((a) => !opened.has(a)).length;
  }
  const basis = savingsBasis({ attestedEvents: attested, totalEvents: events.length });
  return {
    packets: events.length,
    measured: {
      attestedEvents: attested,
      tokensSaved: measuredTokens,
      fileReadsAvoided: readsAvoided,
      fileReadsStillOpened: readsOpened,
      note: "Measured from the real size of files the agent reported it did not open.",
    },
    estimate: {
      tokensSaved: estimatedTokens,
      note: "Estimate from a model of typical file and memory sizes, not a measurement.",
    },
    basis: basis.savingsBasis,
  };
}

export function activitySummary(opts: { hours?: number } = {}) {
  const hours = Math.min(Math.max(1, Number(opts.hours) || 24), 24 * ACTIVITY_RETENTION_DAYS);
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT client, channel,
              COUNT(*) AS calls,
              SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS n_in,
              SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS n_out,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN direction = 'out' THEN result_bytes ELSE 0 END) AS bytes_out,
              AVG(latency_ms) AS avg_latency,
              MAX(ts) AS last_seen
         FROM activity_events WHERE ts >= ?
        GROUP BY client, channel ORDER BY calls DESC`,
    )
    .all(since) as Array<{
    client: string;
    calls: number;
    n_in: number;
    n_out: number;
    errors: number;
    bytes_out: number;
    avg_latency: number | null;
    last_seen: string | null;
    channel: string;
  }>;
  const clients: ClientStats[] = rows.map((r) => ({
    client: r.client,
    calls: r.calls,
    in: r.n_in,
    out: r.n_out,
    errors: r.errors,
    bytesOut: r.bytes_out ?? 0,
    avgLatencyMs: Math.round(r.avg_latency ?? 0),
    lastSeen: r.last_seen,
    channel: r.channel as ActivityChannel,
  }));
  const totals = clients.reduce(
    (t, c) => ({
      calls: t.calls + c.calls,
      in: t.in + c.in,
      out: t.out + c.out,
      errors: t.errors + c.errors,
      bytesOut: t.bytesOut + c.bytesOut,
    }),
    { calls: 0, in: 0, out: 0, errors: 0, bytesOut: 0 },
  );
  const days = hours / 24;
  const usage = listUsageEvents({ days }).filter((e) => e.created_at >= since);
  return {
    hours,
    since,
    enabled: activityEnabled(),
    latestId: latestActivityId(),
    totals,
    clients,
    savings: savingsSummary(usage),
  };
}
