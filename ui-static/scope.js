// Scope picker model: sorts the memories amem tracks into sections a person can scan,
// hides throwaway folders (scratch dirs, temp dirs, hash-named workspaces) by default,
// and gives each entry a friendly label plus the full path for telling duplicates apart.
// Pure functions only, so they can be unit tested without a browser.

const HASH_ONLY = /^[0-9a-f]{12,}$/i;
const SCRATCH_NAME = /^scratch(pad)?(-\d{4}-\d{2}-\d{2}(-[0-9a-f]+)?)?$/i;
const TEMP_PATH = [
  /^\/tmp(\/|$)/,
  /^\/private\/tmp(\/|$)/,
  /^\/(private\/)?var\/folders\//,
  /\/T(\/|$)/,
  /\/scratch-workspaces\//,
  /\/scratchpad(\/|$)/,
];

export function isPersonalRepo(r) {
  if (!r) return false;
  return Boolean(r.personal) || r.slug === "personal" || String(r.remote_url || "").includes("amem://workspace/personal");
}

export function isWorkspaceRepo(r) {
  if (!r) return false;
  return r.kind === "workspace" || Boolean(r.slug) || String(r.remote_url || "").startsWith("amem://workspace/");
}

/** Throwaway folders: scratch-YYYY-MM-DD-*, /tmp, /private/tmp, macOS temp (.../T), hash-only names. */
export function isTemporaryRepo(r) {
  if (!r || isPersonalRepo(r)) return false;
  const name = String(r.repo_name || "").trim();
  const path = String(r.root_path || "");
  if (HASH_ONLY.test(name) || SCRATCH_NAME.test(name)) return true;
  if (name === "T" || name === "tmp") return true;
  // Named workspaces (amem://workspace/...) live under ~/.amem; only their own name can mark them temporary.
  if (isWorkspaceRepo(r) && String(r.remote_url || "").startsWith("amem://workspace/")) return false;
  return TEMP_PATH.some((re) => re.test(path));
}

export function scopeSection(r) {
  if (isPersonalRepo(r)) return "personal";
  if (isTemporaryRepo(r)) return "temporary";
  if (isWorkspaceRepo(r)) return "workspaces";
  return "projects";
}

function lastSegment(p) {
  return String(p || "").split(/[/\\]/).filter(Boolean).pop() || "";
}

/** A readable name: "users-me-github-docklio" → "docklio", "meetings-ef19bd…" → "meetings". */
export function friendlyScopeLabel(r) {
  if (!r) return "";
  if (isPersonalRepo(r)) return "Personal";
  let name = String(r.repo_name || "").trim() || lastSegment(r.root_path) || "Untitled";
  if (/^users-/.test(name) && r.root_path) name = lastSegment(r.root_path) || name;
  const hashTail = name.match(/^(.+?)-[0-9a-f]{12,}$/i);
  if (hashTail) name = hashTail[1];
  return name;
}

export function homeShort(p) {
  return String(p || "").replace(/^\/Users\/[^/]+/, "~");
}

/**
 * Build picker entries. Entries whose friendly labels collide get a `hint`
 * (the shortest distinguishing parent folder) so each row can be told apart.
 */
export function buildScopeEntries(repos, { pinned = [] } = {}) {
  const pinnedSet = new Set(pinned);
  const entries = (repos || []).map((r) => ({
    id: r.id,
    value: `repo:${r.id}`,
    label: friendlyScopeLabel(r),
    path: r.root_path || "",
    pathShort: homeShort(r.root_path),
    facts: r.counts?.claims ?? 0,
    section: scopeSection(r),
    kind: isWorkspaceRepo(r) ? "workspace" : "project",
    pinned: pinnedSet.has(r.id),
    hint: "",
  }));
  const byLabel = new Map();
  for (const e of entries) {
    const key = e.label.toLowerCase();
    if (!byLabel.has(key)) byLabel.set(key, []);
    byLabel.get(key).push(e);
  }
  for (const group of byLabel.values()) {
    if (group.length < 2) continue;
    for (const e of group) {
      const parts = e.pathShort.split("/").filter(Boolean);
      const parent = parts.length > 1 ? parts[parts.length - 2] : "";
      e.hint = e.section === "temporary" ? "temporary copy" : e.kind === "workspace" ? "workspace" : parent ? `in ${parent}` : "";
    }
  }
  return entries;
}

export function matchesScopeQuery(entry, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  return [entry.label, entry.path, entry.hint].some((s) => String(s || "").toLowerCase().includes(q));
}

/** Group entries into ordered sections. Pinned entries appear in Pinned only. */
export function groupScopeEntries(entries, query = "") {
  const visible = entries.filter((e) => matchesScopeQuery(e, query));
  const sort = (a, b) => b.facts - a.facts || a.label.localeCompare(b.label);
  const pick = (fn) => visible.filter(fn).sort(sort);
  return [
    { key: "personal", title: "Personal", items: pick((e) => e.section === "personal") },
    { key: "pinned", title: "Pinned", items: pick((e) => e.pinned && e.section !== "personal") },
    { key: "projects", title: "Projects", items: pick((e) => !e.pinned && e.section === "projects") },
    { key: "workspaces", title: "Workspaces", items: pick((e) => !e.pinned && e.section === "workspaces") },
    { key: "temporary", title: "Temporary", items: pick((e) => !e.pinned && e.section === "temporary"), collapsible: true },
  ];
}
