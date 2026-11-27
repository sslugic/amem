// Memory overview model: one row per memory (level 1) or per anchored file inside a
// memory (level 2), with counts for a bar and small status badges. Pure functions so
// they can be unit tested without a browser.
import { scopeSection, friendlyScopeLabel, homeShort } from "./scope.js";

export const STALE_DAYS = 90;

function anchorsOf(claim) {
  const raw = claim?.code_anchors;
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === "string" && raw.trim()) {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v.filter(Boolean);
    } catch {
      return raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

/** A fact is stale when nobody updated it for STALE_DAYS and no recent query used it. */
export function isStaleClaim(claim, hot, now = Date.now()) {
  if (Number(claim?.pinned || 0) > 0) return false;
  if (hot?.has(claim?.id)) return false;
  const t = Date.parse(claim?.updated_at || claim?.created_at || "");
  return Number.isFinite(t) && now - t > STALE_DAYS * 86_400_000;
}

function summarize(items, hot, now) {
  let pinned = 0;
  let stale = 0;
  let used = false;
  let last = 0;
  for (const c of items) {
    if (Number(c.pinned || 0) > 0) pinned += 1;
    if (isStaleClaim(c, hot, now)) stale += 1;
    if (hot.has(c.id)) used = true;
    const t = Date.parse(c.updated_at || c.created_at || "");
    if (Number.isFinite(t) && t > last) last = t;
  }
  return { facts: items.length, pinned, stale, used, lastUpdated: last ? new Date(last).toISOString() : null };
}

const sorters = {
  facts: (a, b) => b.facts - a.facts || Number(b.used) - Number(a.used) || a.label.localeCompare(b.label),
  recent: (a, b) => String(b.lastUpdated || "").localeCompare(String(a.lastUpdated || "")) || b.facts - a.facts,
};

/**
 * Level 1: one row per memory, grouped Personal / Projects / Workspaces / Temporary
 * with the same classification as the scope picker.
 */
export function memoryRows(claims, repos, { hotIds = [], sort = "facts", now = Date.now() } = {}) {
  const hot = new Set(hotIds);
  const byRepo = new Map();
  for (const c of claims || []) {
    const key = c.repo_id || "";
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key).push(c);
  }
  const repoById = new Map((repos || []).map((r) => [r.id, r]));
  const rows = [...byRepo.entries()].map(([id, items]) => {
    const repo = repoById.get(id) || { id, repo_name: "Unknown memory", root_path: "" };
    return {
      id,
      label: friendlyScopeLabel(repo),
      path: repo.root_path || "",
      pathShort: homeShort(repo.root_path),
      section: scopeSection(repo),
      ...summarize(items, hot, now),
    };
  });
  const order = [
    ["personal", "Personal"],
    ["projects", "Projects"],
    ["workspaces", "Workspaces"],
    ["temporary", "Temporary"],
  ];
  const max = Math.max(1, ...rows.map((r) => r.facts));
  return {
    max,
    sections: order
      .map(([key, title]) => ({
        key,
        title,
        collapsible: key === "temporary",
        rows: rows.filter((r) => r.section === key).sort(sorters[sort] || sorters.facts),
      }))
      .filter((s) => s.rows.length),
  };
}

/** Level 2: one row per anchored file inside one memory (facts with no file get their own row). */
export function fileRows(claims, { hotIds = [], sort = "facts", now = Date.now() } = {}) {
  const hot = new Set(hotIds);
  const byFile = new Map();
  for (const c of claims || []) {
    const files = anchorsOf(c);
    for (const f of files.length ? files : ["(no file yet)"]) {
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(c);
    }
  }
  const rows = [...byFile.entries()].map(([file, items]) => {
    const parts = file.split(/[/\\]/).filter(Boolean);
    return {
      id: file,
      label: parts.length > 2 ? parts.slice(-2).join("/") : file,
      path: file,
      ...summarize(items, hot, now),
    };
  });
  rows.sort(sorters[sort] || sorters.facts);
  return { max: Math.max(1, ...rows.map((r) => r.facts)), rows };
}
