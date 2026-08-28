import {
  listClaims,
  listConversationNotes,
  listUsageEvents,
  type ClaimRow,
  type UsageEventRow,
} from "./db.js";
import {
  anchorFsPath,
  extractAnchorsFromText,
  normalizeAnchor,
  uniqueAnchorPaths,
} from "./anchors.js";
import { parseAnchors } from "./freshness.js";
import { claimCoversQuery, queryKey } from "./reinforce.js";
import { tokenize } from "./search.js";

export type MissGap = {
  queryKey: string;
  sampleQuery: string;
  count: number;
  lastAt: string;
};

export type UnclaimedPathGap = {
  path: string;
  mentions: number;
  samples: string[];
};

export type MemoryGaps = {
  repoId: string;
  days: number;
  missQueries: MissGap[];
  unclaimedPaths: UnclaimedPathGap[];
  /** One-line hints for agents / UI */
  suggestions: string[];
};

function claimedPaths(claims: ClaimRow[]): Set<string> {
  const set = new Set<string>();
  for (const c of claims) {
    for (const path of uniqueAnchorPaths(parseAnchors(c.code_anchors))) {
      set.add(path);
    }
  }
  return set;
}

function clusterMisses(events: UsageEventRow[], limit: number): MissGap[] {
  const buckets = new Map<
    string,
    { sampleQuery: string; count: number; lastAt: string }
  >();
  for (const e of events) {
    const isMiss =
      e.kind === "server_trip" ||
      (e.claims_count === 0 && e.kind !== "local_hit");
    if (!isMiss) continue;
    const q = (e.query || "").trim();
    if (q.length < 8) continue;
    const key = queryKey(q) || q.toLowerCase().slice(0, 80);
    const cur = buckets.get(key);
    if (!cur) {
      buckets.set(key, { sampleQuery: q, count: 1, lastAt: e.created_at });
    } else {
      cur.count += 1;
      if (e.created_at > cur.lastAt) {
        cur.lastAt = e.created_at;
        cur.sampleQuery = q;
      }
    }
  }
  return [...buckets.entries()]
    .map(([queryKey, v]) => ({ queryKey, ...v }))
    .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
    .slice(0, limit);
}

/**
 * Surfaces where memory is thin: recurring context misses and paths that show
 * up in misses/notes but have no claim anchors.
 */
export function findMemoryGaps(
  repoId: string,
  opts: { days?: number; limit?: number } = {},
): MemoryGaps {
  const days = opts.days ?? 30;
  const limit = opts.limit ?? 8;
  const claims = listClaims(repoId);
  const covered = claimedPaths(claims);
  const events = listUsageEvents({ repoId, days });

  const missQueries = clusterMisses(events, limit).filter((m) => {
    // Drop if an active claim already covers this theme
    return !claims.some((c) => claimCoversQuery(c, m.sampleQuery));
  });

  const pathMentions = new Map<string, { count: number; samples: string[] }>();
  const bump = (path: string, sample: string) => {
    const n = normalizeAnchor(path);
    const p = anchorFsPath(n);
    if (!p || covered.has(p)) return;
    if (!p.includes("/") && !p.includes(".")) return;
    const cur = pathMentions.get(p) ?? { count: 0, samples: [] };
    cur.count += 1;
    if (cur.samples.length < 3 && !cur.samples.includes(sample.slice(0, 120))) {
      cur.samples.push(sample.slice(0, 120));
    }
    pathMentions.set(p, cur);
  };

  for (const e of events) {
    const isMiss = e.kind === "server_trip" || e.claims_count === 0;
    if (!isMiss) continue;
    for (const a of extractAnchorsFromText(e.query || "")) {
      bump(a, e.query);
    }
  }

  const notes = listConversationNotes(repoId, 60);
  for (const note of notes) {
    for (const a of extractAnchorsFromText(note.text)) {
      bump(a, note.text);
    }
  }

  // Paths in miss queries as bare tokens like "webhook" aren't paths — also
  // check miss text for path-like tokens already handled by extractAnchorsFromText.

  const unclaimedPaths = [...pathMentions.entries()]
    .map(([path, v]) => ({ path, mentions: v.count, samples: v.samples }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, limit);

  const suggestions: string[] = [];
  for (const m of missQueries.slice(0, 3)) {
    suggestions.push(
      m.count > 1
        ? `Recurring miss (${m.count}×): “${m.sampleQuery.slice(0, 90)}” — remember a durable fact after the next answer.`
        : `Recent miss: “${m.sampleQuery.slice(0, 90)}” — worth a claim if the answer was durable.`,
    );
  }
  for (const p of unclaimedPaths.slice(0, 3)) {
    suggestions.push(
      `\`${p.path}\` shows up in exploration but has no claim anchors — annotate after the next successful change.`,
    );
  }
  if (suggestions.length === 0 && claims.length === 0) {
    suggestions.push("No claims yet — seed with amem-bootstrap or amem remember after a durable outcome.");
  }

  return { repoId, days, missQueries, unclaimedPaths, suggestions };
}

/** Compact markdown section for context packets / CLI. */
export function renderGapsMarkdown(gaps: MemoryGaps, opts?: { maxItems?: number }): string {
  const max = opts?.maxItems ?? 5;
  const lines: string[] = ["## Memory gaps", ""];
  if (gaps.suggestions.length === 0) {
    lines.push("No hot gaps in the recent window.", "");
    return lines.join("\n");
  }
  for (const s of gaps.suggestions.slice(0, max)) {
    lines.push(`- ${s}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Gaps whose sample query overlaps the current query tokens. */
export function gapsRelevantToQuery(gaps: MemoryGaps, query: string): MemoryGaps {
  const tokens = new Set(tokenize(query));
  if (tokens.size === 0) return { ...gaps, missQueries: [], unclaimedPaths: [], suggestions: [] };
  const missQueries = gaps.missQueries.filter((m) => {
    const mt = tokenize(m.sampleQuery);
    return mt.some((t) => tokens.has(t));
  });
  const unclaimedPaths = gaps.unclaimedPaths.filter((p) => {
    const hay = `${p.path} ${p.samples.join(" ")}`.toLowerCase();
    return [...tokens].some((t) => hay.includes(t));
  });
  const suggestions = gaps.suggestions.filter((s) => {
    const low = s.toLowerCase();
    return [...tokens].some((t) => t.length > 2 && low.includes(t));
  });
  return { ...gaps, missQueries, unclaimedPaths, suggestions };
}
