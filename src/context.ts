import {
  getRepoByName,
  listClaims,
  listComponents,
  listConversationNotes,
  listEdges,
  listFlows,
  openDb,
  type ClaimRow,
  type ComponentRow,
  type ConversationNoteRow,
  type FlowRow,
  type UsageEventRow,
} from "./db.js";
import { symbolTokensFromAnchors } from "./anchors.js";
import {
  assessClaimFreshness,
  freshnessScoreMultiplier,
  parseAnchors,
  type ClaimFreshness,
  type FreshnessStatus,
} from "./freshness.js";
import { kindRankBoost } from "./kinds.js";
import {
  ftsBoostFromBm25,
  keywordScoreClaim,
  searchClaimsFts,
  tokenize,
} from "./search.js";
import { embedBoostFromScore, searchClaimsEmbed, searchClaimsEmbedLive } from "./embed.js";
import { FEATURE_LOCAL_EMBED, hasFeature } from "./license.js";
import { PERSONAL_SLUG } from "./personal.js";
import {
  assocBoostMap,
  claimHitCountMap,
  reinforceBoostForClaim,
} from "./reinforce.js";
import {
  findMemoryGaps,
  gapsRelevantToQuery,
  renderGapsMarkdown,
  type MemoryGaps,
} from "./gaps.js";

function scoreNote(note: ConversationNoteRow, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const hay = note.text.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (hay.includes(token)) score += token.length > 4 ? 3 : 2;
  }
  return score;
}

function symbolBoost(claim: ClaimRow, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const symbols = symbolTokensFromAnchors(parseAnchors(claim.code_anchors));
  if (symbols.length === 0) return 0;
  let score = 0;
  for (const token of queryTokens) {
    if (symbols.includes(token)) score += token.length > 4 ? 5 : 3;
  }
  return score;
}

export type RankedClaim = ClaimRow & {
  score: number;
  freshness: ClaimFreshness;
  /** Human-readable ranking factors for "why was this injected?" */
  reasons: string[];
};

export type ContextPacket = {
  query: string;
  claims: RankedClaim[];
  flows: FlowRow[];
  components: ComponentRow[];
  notes: Array<ConversationNoteRow & { score: number }>;
  /** Optional gaps relevant to this query (compact packets may omit). */
  gaps?: MemoryGaps;
};

export type BuildContextOptions = {
  limit?: number;
  rootPath?: string;
  /** Include cross-repo personal prefs (default true). */
  includePersonal?: boolean;
  /** Attach query-relevant memory gaps (default false — use for CLI/API opt-in). */
  includeGaps?: boolean;
};

function rankClaims(
  claims: ClaimRow[],
  query: string,
  queryTokens: string[],
  opts: {
    rootPath?: string;
    ftsBoost: Map<string, number>;
    embedBoost: Map<string, number>;
    hitCounts?: Map<string, number>;
    assocBoosts?: Map<string, number>;
    extraReason?: string;
  },
): RankedClaim[] {
  const hitCounts = opts.hitCounts ?? new Map();
  const assocBoosts = opts.assocBoosts ?? new Map();
  return claims.map((c) => {
    const freshness = assessClaimFreshness(opts.rootPath, c);
    const keyword = keywordScoreClaim(c, queryTokens);
    const sym = symbolBoost(c, queryTokens);
    const boost = opts.ftsBoost.get(c.id) ?? 0;
    const embed = opts.embedBoost.get(c.id) ?? 0;
    const pinBoost = (c.pinned ?? 0) > 0 ? 40 : 0;
    const kindBoost = kindRankBoost(c.kind);
    const { boost: helpBoost, reason: helpReason } = reinforceBoostForClaim(
      c.id,
      hitCounts,
      assocBoosts,
    );
    const matchSignal = keyword + sym + boost + embed + pinBoost + helpBoost;
    const reasons: string[] = [];
    if (opts.extraReason) reasons.push(opts.extraReason);
    if (keyword > 0) reasons.push(`keyword+${keyword}`);
    if (sym > 0) reasons.push(`symbol+${sym}`);
    if (boost > 0) reasons.push(`fts+${boost.toFixed(1)}`);
    if (embed > 0) reasons.push(`embed+${embed.toFixed(1)}`);
    if (helpReason) reasons.push(helpReason);
    if (pinBoost > 0) reasons.push("pinned");
    if (matchSignal > 0 && kindBoost >= 8) reasons.push(`kind:${c.kind}`);
    if (freshness.status === "stale") reasons.push("stale↓");
    else if (freshness.status === "fresh" && matchSignal > 0) reasons.push("fresh");

    const raw = matchSignal > 0 ? matchSignal + kindBoost * 0.35 : 0;
    const withFloor =
      raw > 0
        ? Math.max(
            raw,
            boost > 0 || embed > 0 || helpBoost > 0
              ? boost + embed + pinBoost + helpBoost + kindBoost * 0.35
              : raw,
          )
        : 0;
    const score = withFloor * freshnessScoreMultiplier(freshness.status);
    if (score > 0 && reasons.length === 0) reasons.push("rank");
    return { ...c, score, freshness, reasons };
  });
}

export function buildContext(
  repoId: string,
  query: string,
  limitOrOpts: number | BuildContextOptions = 12,
): ContextPacket {
  const opts: BuildContextOptions =
    typeof limitOrOpts === "number" ? { limit: limitOrOpts } : limitOrOpts;
  const limit = opts.limit ?? 12;
  const rootPath = opts.rootPath;
  const includePersonal = opts.includePersonal !== false;

  const queryTokens = tokenize(query);
  const db = openDb();
  const allActive = listClaims(repoId);
  const ftsHits = searchClaimsFts(db, repoId, query, Math.max(limit * 2, 24));
  const ftsBoost = new Map<string, number>();
  for (const hit of ftsHits) {
    ftsBoost.set(hit.id, ftsBoostFromBm25(hit.bm25));
  }
  const embedHits = searchClaimsEmbed(db, repoId, query, Math.max(limit * 2, 24));
  const embedBoost = new Map<string, number>();
  for (const hit of embedHits) {
    embedBoost.set(hit.id, embedBoostFromScore(hit.score));
  }
  const hitCounts = claimHitCountMap(repoId);
  const assocBoosts = assocBoostMap(repoId, query);

  const scored = rankClaims(allActive, query, queryTokens, {
    rootPath,
    ftsBoost,
    embedBoost,
    hitCounts,
    assocBoosts,
  })
    .filter((c) => (queryTokens.length === 0 ? true : c.score > 0))
    .sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at));

  // If no keyword/FTS/embed hits, return newest fresh-leaning claims as weak fallback
  let selected: RankedClaim[] =
    scored.length > 0
      ? scored.slice(0, limit)
      : allActive.slice(0, Math.min(5, limit)).map((c) => {
          const freshness = assessClaimFreshness(rootPath, c);
          const reasons = ["fallback:recent"];
          if ((c.pinned ?? 0) > 0) reasons.unshift("pinned");
          return { ...c, score: 0, freshness, reasons };
        });

  // Blend a few personal-prefs claims into project context (not org wiki).
  if (includePersonal) {
    const personal = getRepoByName(PERSONAL_SLUG);
    if (personal && personal.id !== repoId) {
      const personalClaims = listClaims(personal.id).filter(
        (c) => c.id !== "claim.personal_scope",
      );
      if (personalClaims.length > 0) {
        const pFts = new Map<string, number>();
        for (const hit of searchClaimsFts(db, personal.id, query, 12)) {
          pFts.set(hit.id, ftsBoostFromBm25(hit.bm25));
        }
        const pEmbed = new Map<string, number>();
        for (const hit of searchClaimsEmbed(db, personal.id, query, 12)) {
          pEmbed.set(hit.id, embedBoostFromScore(hit.score));
        }
        const personalRanked = rankClaims(personalClaims, query, queryTokens, {
          rootPath: personal.root_path,
          ftsBoost: pFts,
          embedBoost: pEmbed,
          extraReason: "personal",
        })
          .filter((c) => c.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);
        if (personalRanked.length > 0) {
          const room = Math.max(1, Math.min(3, Math.floor(limit / 4) || 1));
          const take = personalRanked.slice(0, room);
          const keep = selected.slice(0, Math.max(0, limit - take.length));
          selected = [...keep, ...take].sort(
            (a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at),
          );
        }
      }
    }
  }

  const edges = listEdges(repoId);
  const flowIds = new Set<string>();
  const componentIds = new Set<string>();

  for (const claim of selected) {
    for (const e of edges) {
      if (e.from_type === "claim" && e.from_id === claim.id && e.to_type === "flow") {
        flowIds.add(e.to_id);
      }
      if (e.to_type === "claim" && e.to_id === claim.id && e.from_type === "flow") {
        flowIds.add(e.from_id);
      }
    }
  }

  for (const flowId of flowIds) {
    for (const e of edges) {
      if (e.from_type === "flow" && e.from_id === flowId && e.to_type === "component") {
        componentIds.add(e.to_id);
      }
      if (e.to_type === "flow" && e.to_id === flowId && e.from_type === "component") {
        componentIds.add(e.from_id);
      }
    }
  }

  const flows = listFlows(repoId).filter((f) => flowIds.has(f.id));
  const components = listComponents(repoId).filter((c) => componentIds.has(c.id));

  const notesRaw = listConversationNotes(repoId, 40)
    .map((n) => ({ ...n, score: scoreNote(n, queryTokens) }))
    .filter((n) => (queryTokens.length === 0 ? true : n.score > 0))
    .sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at))
    .slice(0, 5);
  const notes =
    notesRaw.length > 0
      ? notesRaw
      : listConversationNotes(repoId, 5).map((n) => ({ ...n, score: 0 }));

  let gaps: MemoryGaps | undefined;
  if (opts.includeGaps) {
    gaps = gapsRelevantToQuery(findMemoryGaps(repoId, { days: 30, limit: 6 }), query);
    if (gaps.suggestions.length === 0) gaps = undefined;
  }

  return { query, claims: selected, flows, components, notes, gaps };
}

export type ShowdownClaim = {
  id: string;
  kind: string;
  text: string;
  score: number;
  reasons: string[];
};

export type RetrievalShowdown = {
  query: string;
  free: ShowdownClaim[];
  pro: ShowdownClaim[];
  proLocked: boolean;
  proOnlyIds: string[];
  freeOnlyIds: string[];
};

function toShowdownClaims(ranked: RankedClaim[]): ShowdownClaim[] {
  return ranked.map((c) => ({
    id: c.id,
    kind: c.kind,
    text: c.text,
    score: Math.round(c.score * 10) / 10,
    reasons: c.reasons,
  }));
}

function rankWithLiveEmbed(
  claims: ClaimRow[],
  query: string,
  queryTokens: string[],
  ftsBoost: Map<string, number>,
  backend: "hash" | "ngram",
  rootPath: string | undefined,
  limit: number,
): RankedClaim[] {
  const embedBoost = new Map<string, number>();
  for (const hit of searchClaimsEmbedLive(claims, query, backend, Math.max(limit * 2, 24))) {
    embedBoost.set(hit.id, embedBoostFromScore(hit.score));
  }
  return rankClaims(claims, query, queryTokens, {
    rootPath,
    ftsBoost,
    embedBoost,
    extraReason: backend === "ngram" ? "embed:ngram" : "embed:hash",
  })
    .filter((c) => (queryTokens.length === 0 ? true : c.score > 0))
    .sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at))
    .slice(0, limit);
}

/** Side-by-side free hash vs Pro n-gram retrieval for the same query. */
export function buildRetrievalShowdown(
  repoId: string,
  query: string,
  limitOrOpts: number | BuildContextOptions = 8,
): RetrievalShowdown {
  const opts: BuildContextOptions =
    typeof limitOrOpts === "number" ? { limit: limitOrOpts } : limitOrOpts;
  const limit = opts.limit ?? 8;
  const rootPath = opts.rootPath;
  const queryTokens = tokenize(query);
  const db = openDb();
  const allActive = listClaims(repoId);
  const ftsBoost = new Map<string, number>();
  for (const hit of searchClaimsFts(db, repoId, query, Math.max(limit * 2, 24))) {
    ftsBoost.set(hit.id, ftsBoostFromBm25(hit.bm25));
  }

  const freeRanked = rankWithLiveEmbed(allActive, query, queryTokens, ftsBoost, "hash", rootPath, limit);
  const free = toShowdownClaims(freeRanked);

  const proLocked = !hasFeature(FEATURE_LOCAL_EMBED);
  let pro: ShowdownClaim[] = [];
  if (!proLocked) {
    const proRanked = rankWithLiveEmbed(allActive, query, queryTokens, ftsBoost, "ngram", rootPath, limit);
    pro = toShowdownClaims(proRanked);
  }

  const freeIds = new Set(free.map((c) => c.id));
  const proIds = new Set(pro.map((c) => c.id));
  return {
    query,
    free,
    pro,
    proLocked,
    proOnlyIds: pro.filter((c) => !freeIds.has(c.id)).map((c) => c.id),
    freeOnlyIds: free.filter((c) => !proIds.has(c.id)).map((c) => c.id),
  };
}

function freshnessLabel(status: FreshnessStatus): string | null {
  switch (status) {
    case "stale":
      return "stale";
    case "missing_anchor":
      return "missing_anchor";
    default:
      return null;
  }
}

export type RenderContextOptions = {
  /** Dense packet for MCP / hooks — fewer tokens, same facts. */
  compact?: boolean;
  /** Append relevant memory gaps (default: true when packet.gaps set). */
  includeGaps?: boolean;
};

/** Keyword match only. Fallback packets (score 0) are misses — the model call still happens. */
export function classifyLookup(query: string, claims: ClaimRow[]): "local_hit" | "server_trip" {
  const tokens = tokenize(query);
  if (tokens.length === 0) return "server_trip";
  return claims.some((c) => keywordScoreClaim(c, tokens) > 0) ? "local_hit" : "server_trip";
}

export function decorateUsageEvent(e: UsageEventRow, claims: ClaimRow[]): UsageEventRow {
  let ids: string[] = [];
  try {
    ids = JSON.parse(e.claim_ids || "[]") as string[];
  } catch {
    ids = [];
  }
  const subset = ids.length ? claims.filter((c) => ids.includes(c.id)) : [];
  const kind = classifyLookup(e.query || "", subset);
  if (kind === "local_hit") return { ...e, kind };
  return {
    ...e,
    kind,
    estimated_tokens_saved: 0,
    estimated_ms_saved: 0,
  };
}

export function decorateUsageEvents(events: UsageEventRow[]): UsageEventRow[] {
  const cache = new Map<string, ClaimRow[]>();
  return events.map((e) => {
    let claims = cache.get(e.repo_id);
    if (!claims) {
      claims = listClaims(e.repo_id);
      cache.set(e.repo_id, claims);
    }
    return decorateUsageEvent(e, claims);
  });
}

function renderClaimCompact(claim: RankedClaim): string[] {
  const lines: string[] = [];
  const why = claim.reasons?.length ? ` · ${claim.reasons.slice(0, 4).join(",")}` : "";
  const fl = freshnessLabel(claim.freshness.status);
  const pin = (claim.pinned ?? 0) > 0 ? " · pin" : "";
  const fresh = fl ? ` · ${fl}` : "";
  lines.push(`### ${claim.id} · ${claim.kind}${pin}${fresh}${why}`);
  const text = claim.text.replace(/\s+/g, " ").trim();
  lines.push(text.length > 220 ? `${text.slice(0, 217)}…` : text);
  let anchors: string[] = [];
  try {
    anchors = JSON.parse(claim.code_anchors) as string[];
  } catch {
    anchors = [];
  }
  if (anchors.length > 0) {
    lines.push(`→ ${anchors.slice(0, 6).map((a) => `\`${a}\``).join(" ")}`);
  }
  lines.push("");
  return lines;
}

export function renderContextMarkdown(
  packet: ContextPacket,
  opts: RenderContextOptions = {},
): string {
  const compact = Boolean(opts.compact);
  if (compact) {
    const lines: string[] = ["# amem", `Q: ${packet.query}`, ""];
    if (packet.claims.length === 0 && packet.notes.length === 0) {
      lines.push("No claims yet. Seed with bootstrap or remember after a durable outcome.");
      return lines.join("\n");
    }
    for (const claim of packet.claims) {
      lines.push(...renderClaimCompact(claim));
    }
    if (packet.components.length > 0) {
      lines.push(
        `Components: ${packet.components
          .slice(0, 4)
          .map((c) => c.name)
          .join("; ")}`,
        "",
      );
    }
    if (packet.notes.length > 0 && packet.claims.length < 3) {
      for (const note of packet.notes.slice(0, 2)) {
        lines.push(`- ${note.text.replace(/\s+/g, " ").slice(0, 160)}`);
      }
      lines.push("");
    }
    const showGaps = opts.includeGaps !== false && packet.gaps?.suggestions.length;
    if (showGaps && packet.gaps) {
      lines.push(renderGapsMarkdown(packet.gaps, { maxItems: 3 }).trimEnd(), "");
    }
    lines.push("_Local `~/.amem`. Verify anchors before edits._");
    return lines.join("\n");
  }

  const lines: string[] = ["# Agent Memory Context", "", `Query: ${packet.query}`, ""];

  if (packet.claims.length === 0 && packet.notes.length === 0) {
    lines.push("No claims stored for this repository yet.", "");
    lines.push("Seed memory with the `amem-bootstrap` skill or `amem propose apply <file>`.");
    return lines.join("\n");
  }

  if (packet.claims.length === 0) {
    lines.push("No durable claims yet — using recent conversation memory.", "");
  }

  const staleCount = packet.claims.filter((c) => c.freshness.status === "stale").length;
  if (staleCount > 0) {
    lines.push(
      `_${staleCount} claim(s) marked stale — anchored files changed after the claim was written. Verify before trusting._`,
      "",
    );
  }

  if (packet.claims.length > 0) {
    lines.push("## Best Claims", "");
    for (const claim of packet.claims) {
      lines.push(`### ${claim.id}`);
      lines.push(`Kind: \`${claim.kind}\``);
      if ((claim.pinned ?? 0) > 0) {
        lines.push(`Pinned: \`yes\``);
      }
      const fl = freshnessLabel(claim.freshness.status);
      if (fl) {
        const detail =
          claim.freshness.staleAnchors.length > 0
            ? ` — ${claim.freshness.staleAnchors.map((a) => `\`${a}\``).join(", ")} changed after claim`
            : claim.freshness.missingAnchors.length > 0
              ? ` — missing ${claim.freshness.missingAnchors.map((a) => `\`${a}\``).join(", ")}`
              : "";
        lines.push(`Freshness: \`${fl}\`${detail}`);
      }
      if (claim.reasons?.length) {
        lines.push(`Why: ${claim.reasons.map((r) => `\`${r}\``).join(", ")}`);
      }
      lines.push("");
      lines.push(claim.text);
      lines.push("");
      let anchors: string[] = [];
      try {
        anchors = JSON.parse(claim.code_anchors) as string[];
      } catch {
        anchors = [];
      }
      if (anchors.length > 0) {
        lines.push(`Anchors: ${anchors.map((a) => `\`${a}\``).join(", ")}`);
        lines.push("");
      }
    }
  }

  if (packet.flows.length > 0) {
    lines.push("## Related Flows", "");
    for (const flow of packet.flows) {
      lines.push(`- \`${flow.id}\`: ${flow.name}`);
    }
    lines.push("");
  }

  if (packet.components.length > 0) {
    lines.push("## Related Components", "");
    for (const component of packet.components) {
      const anchor = component.code_anchor ? ` — \`${component.code_anchor}\`` : "";
      lines.push(`- \`${component.id}\`: ${component.name}${anchor}`);
    }
    lines.push("");
  }

  if (packet.notes.length > 0) {
    lines.push("## Recent conversation memory", "");
    for (const note of packet.notes) {
      const label = note.role === "user" ? "You asked" : note.role === "assistant" ? "Prior answer" : note.role;
      lines.push(`- (${label}) ${note.text.replace(/\s+/g, " ").slice(0, 280)}`);
    }
    lines.push("");
  }

  if (opts.includeGaps !== false && packet.gaps?.suggestions.length) {
    lines.push(renderGapsMarkdown(packet.gaps, { maxItems: 4 }).trimEnd(), "");
  }

  lines.push(
    "_Memory is personal and local (`~/.amem`). Prefer these anchors over broad exploration. Verify current code before changing anything._",
  );
  return lines.join("\n");
}
