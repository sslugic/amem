/**
 * Unified recall over facts (claims), skills and tasks: BM25 via FTS5 when available,
 * keyword scoring otherwise, blended with recency, usage and pins, and packed into an
 * optional token budget. Also the compact session-start payload (amem_bootstrap).
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  getRepoByCwd,
  getRepoByName,
  listClaims,
  listOpenTasksForContext,
  listTasks,
  openDb,
  type AgentTaskRow,
  type ClaimRow,
  type RepoRow,
} from "./db.js";
import { estimateTokensFromText } from "./estimate.js";
import { ensurePersonalWorkspace, isPersonalRepo, isPrivatePersonalClaim, PERSONAL_SLUG } from "./personal.js";
import { parseWorkspaceSlug } from "./repo-identity.js";
import { keywordRelevance, searchAllFts, ftsReady } from "./search.js";
import { listIndexedSkills, matchSkillTriggers, isPromptDerivedSkill, type IndexedSkill, type SkillHint } from "./skills.js";
import { clipText } from "./text-clip.js";

export type RecallType = "claim" | "skill" | "task";

/** "global" (the personal workspace) or "project:<root path>". */
export function scopeOf(repo: RepoRow): string {
  return isPersonalRepo(repo) ? "global" : `project:${repo.root_path}`;
}

/**
 * Resolve a scope string to the memory that holds it. `global` is the cross-project
 * personal workspace; `project:<path>` the repo or workspace bound at that path; anything
 * else is taken as a workspace name. Omitted: the repo bound to `cwd`.
 */
export function resolveScope(scope: string | undefined | null, cwd = process.cwd()): RepoRow | null {
  const s = (scope ?? "").trim();
  if (!s || s === "project") return getRepoByCwd(cwd);
  if (s === "global" || s === PERSONAL_SLUG) return getRepoByName(PERSONAL_SLUG) ?? ensurePersonalWorkspace();
  if (s.startsWith("project:")) return getRepoByCwd(resolve(s.slice("project:".length)));
  return getRepoByName(s);
}

export type RecallItem = {
  type: RecallType;
  id: string;
  scope: string;
  title: string;
  text: string;
  status: string;
  score: number;
  tokens: number;
};

export type RecallResult = {
  query: string;
  engine: "fts5" | "keyword";
  items: RecallItem[];
  usedTokens: number;
  maxTokens: number | null;
  truncated: boolean;
  /** How many matches were left out by limit or budget. */
  omitted: number;
};

export type RecallOptions = {
  query: string;
  repo: RepoRow | null;
  /** Blend in the global (personal) scope too. Default true. */
  includeGlobal?: boolean;
  types?: RecallType[];
  /** claims: active (default) | all; tasks: a Kanban status, open (default) or all. */
  status?: string;
  tags?: string[];
  limit?: number;
  maxTokens?: number;
  now?: Date;
};

function parseList(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function recency(iso: string | null | undefined, now: Date): number {
  if (!iso) return 0;
  const days = Math.max(0, (now.getTime() - Date.parse(iso)) / 86_400_000);
  return Number.isFinite(days) ? 2 * Math.exp(-days / 30) : 0;
}

function usageBoost(uses: number): number {
  return uses > 0 ? Math.min(3, Math.log2(uses + 1)) : 0;
}

/** How often each claim was served in recent packets: a cheap usage signal. */
function claimUseCounts(repoIds: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (repoIds.length === 0) return counts;
  const marks = repoIds.map(() => "?").join(",");
  const rows = openDb()
    .prepare(`SELECT claim_ids FROM usage_events WHERE repo_id IN (${marks}) ORDER BY created_at DESC LIMIT 300`)
    .all(...repoIds) as Array<{ claim_ids: string }>;
  for (const r of rows) for (const id of parseList(r.claim_ids)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function hasTag(tags: string[], wanted: string[]): boolean {
  if (wanted.length === 0) return true;
  const have = new Set(tags.map((t) => t.toLowerCase()));
  return wanted.some((w) => have.has(w.toLowerCase()));
}

export function renderRecallLine(item: Pick<RecallItem, "type" | "id" | "title" | "text" | "status">): string {
  const status = item.type === "task" ? ` [${item.status}]` : "";
  const body = item.text && item.text !== item.title ? ` — ${item.text}` : "";
  return `- (${item.type}${status}) ${item.title}${body} \`${item.id}\``;
}

/** Deterministic token cost of one rendered item (~4 chars per token). */
export function itemTokens(item: Pick<RecallItem, "type" | "id" | "title" | "text" | "status">): number {
  return estimateTokensFromText(renderRecallLine(item));
}

/**
 * Keep items in score order until the next would exceed `maxTokens`. Items are never
 * cut mid-way; a later, smaller item may still fit after a large one is skipped.
 */
export function packToBudget<T extends { tokens: number }>(
  items: T[],
  maxTokens: number | null | undefined,
): { kept: T[]; usedTokens: number; truncated: boolean } {
  if (!maxTokens || maxTokens <= 0) {
    return { kept: items, usedTokens: items.reduce((n, i) => n + i.tokens, 0), truncated: false };
  }
  const kept: T[] = [];
  let used = 0;
  let truncated = false;
  for (const item of items) {
    if (used + item.tokens > maxTokens) {
      truncated = true;
      continue;
    }
    kept.push(item);
    used += item.tokens;
  }
  return { kept, usedTokens: used, truncated };
}

export function searchMemory(opts: RecallOptions): RecallResult {
  const now = opts.now ?? new Date();
  const query = opts.query.trim();
  const types = opts.types?.length ? opts.types : (["claim", "skill", "task"] as RecallType[]);
  const tags = (opts.tags ?? []).filter(Boolean);
  const repos: RepoRow[] = [];
  if (opts.repo) repos.push(opts.repo);
  if (opts.includeGlobal !== false) {
    const personal = getRepoByName(PERSONAL_SLUG);
    if (personal && !repos.some((r) => r.id === personal.id)) repos.push(personal);
  }
  const repoIds = repos.map((r) => r.id);
  const scopeById = new Map(repos.map((r) => [r.id, scopeOf(r)]));
  const projectId = opts.repo && !isPersonalRepo(opts.repo) ? opts.repo.id : null;

  const db = openDb();
  // Skills live on disk; reconcile them into the index before querying it.
  let skills: IndexedSkill[] = [];
  if (types.includes("skill")) {
    try {
      skills = listIndexedSkills();
    } catch {
      skills = [];
    }
  }
  const useFts = ftsReady(db) && Boolean(query);
  const relevance = new Map<string, number>();
  if (useFts) {
    const hits = searchAllFts(db, query, { repoIds, types, limit: 200 });
    const best = Math.max(1e-9, ...hits.map((h) => Math.abs(h.bm25)));
    for (const h of hits) {
      const key = h.type === "task" ? `task:${h.ref}` : h.type === "claim" ? `claim:${h.repoId}:${h.ref}` : `skill:${h.ref}`;
      relevance.set(key, Math.max(relevance.get(key) ?? 0, 10 * (Math.abs(h.bm25) / best)));
    }
  }
  // Retired claims are not in the FTS index; `status: all` scores them by keyword.
  const rel = (key: string, text: string, indexed = true): number | null => {
    if (!query) return 0;
    if (useFts && indexed) return relevance.get(key) ?? null;
    const k = keywordRelevance(text, query);
    return k > 0 ? Math.min(10, k * 2) : null;
  };

  const candidates: RecallItem[] = [];
  const statusFilter = (opts.status ?? "").trim().toLowerCase();

  if (types.includes("claim")) {
    const uses = claimUseCounts(repoIds);
    for (const repo of repos) {
      const claims: ClaimRow[] =
        statusFilter === "all"
          ? (db.prepare(`SELECT * FROM claims WHERE repo_id = ?`).all(repo.id) as ClaimRow[])
          : listClaims(repo.id);
      for (const c of claims) {
        if (repo.id !== projectId && projectId && isPrivatePersonalClaim(c)) continue;
        if (c.id === "claim.personal_scope") continue;
        if (!hasTag([c.kind, ...parseList(c.code_anchors)], tags)) continue;
        const r = rel(
          `claim:${repo.id}:${c.id}`,
          `${c.id} ${c.kind} ${c.text} ${c.code_anchors}`,
          (c.status ?? "active") === "active",
        );
        if (r === null) continue;
        const score =
          r + recency(c.updated_at, now) + usageBoost(uses.get(c.id) ?? 0) + (Number(c.pinned || 0) > 0 ? 3 : 0) +
          (repo.id === projectId ? 0.5 : 0);
        const item = {
          type: "claim" as const,
          id: c.id,
          scope: scopeById.get(repo.id) ?? "global",
          title: c.kind,
          text: clipText(c.text.replace(/\s+/g, " "), 400),
          status: c.status ?? "active",
          score,
          tokens: 0,
        };
        candidates.push({ ...item, tokens: itemTokens(item) });
      }
    }
  }

  if (types.includes("task")) {
    for (const repo of repos) {
      const tasks: AgentTaskRow[] =
        statusFilter === "all"
          ? listTasks(repo.id, { includeDone: true, limit: 500 })
          : statusFilter && statusFilter !== "active" && statusFilter !== "open"
            ? listTasks(repo.id, { status: statusFilter as AgentTaskRow["status"], includeDone: true, limit: 500 })
            : listTasks(repo.id, { limit: 500 });
      for (const t of tasks) {
        if (!hasTag([t.status, ...parseList(t.anchors)], tags)) continue;
        const r = rel(`task:${repo.id}:${t.id}`, `${t.title} ${t.body}`);
        if (r === null) continue;
        const statusBoost = t.status === "doing" ? 2 : t.status === "next" ? 1.5 : t.status === "blocked" ? 1 : 0;
        const item = {
          type: "task" as const,
          id: t.id,
          scope: scopeById.get(repo.id) ?? "global",
          title: t.title,
          text: t.body ? clipText(t.body.replace(/\s+/g, " "), 200) : "",
          status: t.status,
          score: r + recency(t.updated_at, now) + statusBoost,
          tokens: 0,
        };
        candidates.push({ ...item, tokens: itemTokens(item) });
      }
    }
  }

  if (types.includes("skill")) {
    for (const s of skills) {
      if (isPromptDerivedSkill(s)) continue;
      if (!hasTag(s.tags, tags)) continue;
      const r = rel(`skill:${s.name}`, `${s.name} ${s.description} ${s.tags.join(" ")} ${s.keywords.join(" ")}`);
      if (r === null) continue;
      const item = {
        type: "skill" as const,
        id: s.name,
        scope: "global",
        title: s.name,
        text: clipText((s.description || "").replace(/\s+/g, " "), 160),
        status: "active",
        score: r + recency(s.lastUsedAt, now) + usageBoost(s.uses),
        tokens: 0,
      };
      candidates.push({ ...item, tokens: itemTokens(item) });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  const limited = candidates.slice(0, limit);
  const packed = packToBudget(limited, opts.maxTokens);
  return {
    query,
    engine: useFts ? "fts5" : "keyword",
    items: packed.kept.map((i) => ({ ...i, score: Number(i.score.toFixed(3)) })),
    usedTokens: packed.usedTokens,
    maxTokens: opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : null,
    truncated: packed.truncated || candidates.length > limited.length,
    omitted: candidates.length - packed.kept.length,
  };
}

export function renderRecallMarkdown(result: RecallResult): string {
  if (result.items.length === 0) return `No memory matched "${result.query}".`;
  const lines = result.items.map(renderRecallLine);
  if (result.truncated) {
    lines.push(
      `_${result.omitted} more match(es) left out${result.maxTokens ? ` to stay under max_tokens=${result.maxTokens}` : ""}._`,
    );
  }
  return lines.join("\n");
}

/** Top-level file names in a project root, so skill file triggers fire with no input. */
export function detectProjectFiles(root: string | null | undefined, cap = 200): string[] {
  if (!root) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".git") && e.name !== "node_modules")
      .slice(0, cap)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  } catch {
    return [];
  }
}

export type BootstrapPayload = {
  markdown: string;
  scope: string;
  workspace: string | null;
  tokens: number;
  maxTokens: number;
  truncated: boolean;
  counts: { rules: number; facts: number; tasks: number; skills: number };
  skillHints: SkillHint[];
};

const RULE_KINDS = new Set(["rule", "convention", "preference", "decision", "policy", "constraint"]);

/**
 * Session-start orientation in one call: top global rules, the project's pinned and
 * freshest facts, its open tasks (doing first), and one-line hints for skills whose
 * file or keyword triggers fire. Packed to `maxTokens` (default 350).
 */
export function buildBootstrap(
  repo: RepoRow | null,
  opts: { files?: string[]; text?: string; maxTokens?: number } = {},
): BootstrapPayload {
  const maxTokens = Math.max(80, Math.min(4000, opts.maxTokens ?? 350));
  const personal = getRepoByName(PERSONAL_SLUG);
  const project = repo && !isPersonalRepo(repo) ? repo : null;
  const workspace = project ? (parseWorkspaceSlug(project.remote_url) ?? project.repo_name) : null;

  const rank = (c: ClaimRow) =>
    (Number(c.pinned || 0) > 0 ? 100 : 0) + (RULE_KINDS.has((c.kind || "").toLowerCase()) ? 10 : 0) + recency(c.updated_at, new Date());
  const rules = personal
    ? listClaims(personal.id)
        .filter((c) => c.id !== "claim.personal_scope" && (!project || !isPrivatePersonalClaim(c)))
        .sort((a, b) => rank(b) - rank(a))
        .slice(0, 6)
    : [];
  const facts = project
    ? listClaims(project.id)
        .sort((a, b) => rank(b) - rank(a))
        .slice(0, 8)
    : [];
  const order: Record<string, number> = { doing: 0, blocked: 1, next: 2, backlog: 3 };
  const tasks = project
    ? listOpenTasksForContext(project.id, 12).sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)).slice(0, 6)
    : [];
  let skillHints: SkillHint[] = [];
  try {
    const files = [...(opts.files ?? []), ...detectProjectFiles(project?.root_path)];
    skillHints = matchSkillTriggers(listIndexedSkills(), { files, text: opts.text ?? "" }, 4);
  } catch {
    skillHints = [];
  }

  type Line = { section: string; text: string; tokens: number };
  const line = (section: string, text: string): Line => ({ section, text, tokens: estimateTokensFromText(text) + 1 });
  const lines: Line[] = [];
  // Interleave by priority so a tight budget keeps the best of each section.
  const sections: Array<[string, string[]]> = [
    ["Global rules", rules.map((c) => `- ${clipText(c.text.replace(/\s+/g, " "), 160)}`)],
    ["Active tasks", tasks.map((t) => `- [${t.status}] ${clipText(t.title, 100)} \`${t.id}\``)],
    ["Project facts", facts.map((c) => `- ${clipText(c.text.replace(/\s+/g, " "), 160)}`)],
    [
      "Skill hints",
      skillHints.map((h) => `- **${h.name}** (${h.match}) — ${clipText(h.summary, 90)}`),
    ],
  ];
  const maxLen = Math.max(0, ...sections.map(([, l]) => l.length));
  for (let i = 0; i < maxLen; i += 1) {
    for (const [name, list] of sections) if (list[i]) lines.push(line(name, list[i]!));
  }
  const header = `# amem bootstrap${workspace ? ` · ${workspace}` : ""}`;
  const footer = "_Details: amem_search / amem_context; load a skill with amem_skill_view._";
  const reserve = estimateTokensFromText(header) + estimateTokensFromText(footer) + sections.length * 4 + 4;
  const packed = packToBudget(lines, maxTokens - reserve);
  const kept = new Set(packed.kept);

  const out: string[] = [header];
  for (const [name] of sections) {
    const mine = lines.filter((l) => l.section === name && kept.has(l));
    if (mine.length === 0) continue;
    out.push("", `## ${name}`, ...mine.map((l) => l.text));
  }
  if (!project && rules.length === 0) out.push("", "_No memory yet for this scope. Save facts with amem_remember._");
  if (packed.truncated) out.push("", `_Trimmed to ~${maxTokens} tokens._`);
  out.push("", footer);
  const markdown = out.join("\n");
  const count = (s: string) => packed.kept.filter((l) => l.section === s).length;
  return {
    markdown,
    scope: project ? scopeOf(project) : "global",
    workspace,
    tokens: estimateTokensFromText(markdown),
    maxTokens,
    truncated: packed.truncated,
    counts: { rules: count("Global rules"), facts: count("Project facts"), tasks: count("Active tasks"), skills: count("Skill hints") },
    skillHints,
  };
}
