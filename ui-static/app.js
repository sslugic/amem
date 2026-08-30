import { createOrbitViz } from "./orbit.js";

const PLATFORM_STORAGE = "amem.selectedPlatforms";
const WELCOME_STORAGE = "amem.welcome.dismissed";
const BRAIN_SCOPE_STORAGE = "amem.brain.scope";
const MEMORY_VIZ_STORAGE = "amem.memory.viz";
const TABS = ["setup", "dashboard", "brain", "analytics", "stats", "tasks", "skills"];
const VIZ_MODES = ["map", "blocks", "orbit"];
const FALLBACK_CLIENTS = [
  { id: "cursor", label: "Cursor", hint: "Rules, skills, hooks" },
  { id: "claude", label: "Claude Code", hint: "Skills and settings hooks" },
  { id: "copilot", label: "GitHub Copilot", hint: "MCP / HTTP API" },
  { id: "codex", label: "ChatGPT / Codex", hint: "MCP / HTTP API" },
  { id: "gemini", label: "Gemini", hint: "MCP / HTTP API" },
  { id: "windsurf", label: "Windsurf", hint: "MCP / HTTP API" },
  { id: "grok", label: "Grok", hint: "MCP / HTTP API" },
];

function parsePlatformList(raw) {
  if (Array.isArray(raw)) return raw.filter((p) => typeof p === "string" && p.trim());
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string" && p.trim()) : [];
  } catch {
    return [];
  }
}

function loadStoredPlatforms() {
  try {
    return parsePlatformList(localStorage.getItem(PLATFORM_STORAGE));
  } catch {
    return [];
  }
}

function persistPlatforms() {
  try {
    localStorage.setItem(PLATFORM_STORAGE, JSON.stringify([...state.selected]));
  } catch {
    /* ignore quota / private mode */
  }
}

function hydratePlatforms(status) {
  const stored = loadStoredPlatforms();
  const fromSetup = parsePlatformList(status?.setup?.platforms);
  if (stored.length) {
    state.selected = new Set(stored);
    return;
  }
  if (fromSetup.length) {
    state.selected = new Set(fromSetup);
    persistPlatforms();
  }
}

function knownClients() {
  const fromStatus = state.status?.clients;
  if (Array.isArray(fromStatus) && fromStatus.length) return fromStatus;
  return FALLBACK_CLIENTS;
}

const initialUrl = new URLSearchParams(location.search);
const storedPlatforms = loadStoredPlatforms();

function welcomeDismissed() {
  try {
    return localStorage.getItem(WELCOME_STORAGE) === "1";
  } catch {
    return false;
  }
}

function dismissWelcome() {
  try {
    localStorage.setItem(WELCOME_STORAGE, "1");
  } catch {
    /* ignore */
  }
}

function initialTab() {
  const fromUrl = initialUrl.get("tab");
  if (fromUrl === "stats") return "analytics";
  if (TABS.includes(fromUrl)) return fromUrl;
  return "dashboard";
}

/** All features are free and unlocked. */
function isPaidLicenseCached() {
  return true;
}

function persistLicenseTier(tier) {
  try {
    if (tier) localStorage.setItem("amem.license.tier", String(tier).toLowerCase());
  } catch {
    /* ignore */
  }
}

function loadBrainAll() {
  const fromUrl = initialUrl.get("scope");
  const hasTrackedRepo = Boolean(initialUrl.get("repo"));
  if (fromUrl === "all" || !hasTrackedRepo) return true;
  if (fromUrl === "current") return false;
  try {
    return localStorage.getItem(BRAIN_SCOPE_STORAGE) !== "current";
  } catch {
    return true;
  }
}

function persistBrainAll(all) {
  try {
    localStorage.setItem(BRAIN_SCOPE_STORAGE, all ? "all" : "current");
  } catch {
    /* ignore */
  }
}

function loadMemoryViz() {
  try {
    const v = localStorage.getItem(MEMORY_VIZ_STORAGE);
    if (v === "neural") return "orbit";
    if (VIZ_MODES.includes(v)) return v;
  } catch {
    /* ignore */
  }
  return "map";
}

function persistMemoryViz(mode) {
  try {
    localStorage.setItem(MEMORY_VIZ_STORAGE, VIZ_MODES.includes(mode) ? mode : "map");
  } catch {
    /* ignore */
  }
}

let orbitViz = null;

function stopOrbitViz() {
  if (orbitViz) {
    orbitViz.stop();
    orbitViz = null;
  }
}

function stopAllViz() {
  stopOrbitViz();
}

function setMemoryViz(mode) {
  const next = VIZ_MODES.includes(mode) ? mode : "map";
  state.memoryViz = next;
  persistMemoryViz(next);
  if (next !== "orbit") stopOrbitViz();
  if (next !== "map" && (state.brainFilter === "drafts" || state.brainFilter === "review")) {
    state.brainFilter = "files";
    state.selectedNode = null;
  }
}

function vizToggleHtml() {
  const mode = state.memoryViz || "map";
  return `<div class="viz-toggle" role="group" aria-label="Memory visualization">
    <button type="button" data-viz="map" class="${mode === "map" ? "active" : ""}" title="Plain list of facts by file">Files</button>
    <button type="button" data-viz="blocks" class="${mode === "blocks" ? "active" : ""}" title="Treemap: each block is a file, sized by facts">Blocks</button>
    <button type="button" data-viz="orbit" class="${mode === "orbit" ? "active" : ""}" title="Hub and spoke by memory">Orbit</button>
  </div>`;
}

function bindVizToggle(root = document) {
  root.querySelectorAll(".viz-toggle [data-viz]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const mode = btn.dataset.viz;
      if (!VIZ_MODES.includes(mode)) return;
      setMemoryViz(mode);
      renderBrain();
    });
  });
}

const state = {
  tab: (() => {
    const t = initialTab();
    return t === "stats" ? "analytics" : t;
  })(),
  repoId: initialUrl.get("repo") || null,
  path: initialUrl.get("path") || null,
  status: null,
  repos: [],
  graph: null,
  usage: null,
  selected: new Set(storedPlatforms.length ? storedPlatforms : ["cursor"]),
  picked: new Set(),
  scan: null,
  scanFilter: "",
  scanLoading: false,
  service: null,
  selectedNode: null,
  activeEventId: null,
  brainFilter: "files",
  skills: [],
  skillDrafts: [],
  skillsDir: "",
  draftSelected: {},
  selectedFile: null,
  brainSearch: "",
  memoryViz: loadMemoryViz(),
  anim: 0,
  graphTick: 0,
  vault: null,
  vaultError: null,
  recipe: null,
  license: null,
  shop: null,
  embed: null,
  prefs: null,
  brainAll: loadBrainAll(),
  brainError: null,
  setupStep: 1,
  setupEdit: false,
  statsDays: 30,
  showdown: null,
  showdownQuery: "",
  showdownOpen: false,
};

function scopedPath(path, repoId = state.repoId) {
  const url = new URL(path, location.origin);
  if (repoId) url.searchParams.set("repo", repoId);
  else if (state.path && !state.brainAll) url.searchParams.set("path", state.path);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

async function api(path, options = {}) {
  const { repoId, ...rest } = options;
  const res = await fetch(scopedPath(path, repoId), {
    headers: { "Content-Type": "application/json", ...(rest.headers || {}) },
    ...rest,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function apiUnscoped(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function $(sel) {
  return document.querySelector(sel);
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => String(p).replace(/[/\\]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function listedRepos() {
  const fromList = Array.isArray(state.repos) ? state.repos : [];
  const fromStatus = Array.isArray(state.status?.repos) ? state.status.repos : [];
  const byId = new Map();
  for (const r of [...fromStatus, ...fromList]) {
    if (r?.id) byId.set(r.id, r);
  }
  if (state.status?.repo?.id) byId.set(state.status.repo.id, { ...state.status.repo, ...byId.get(state.status.repo.id) });
  return [...byId.values()];
}

function matchBoundRepo() {
  const repos = listedRepos();
  if (state.repoId) {
    const byId = repos.find((r) => r.id === state.repoId);
    if (byId) return byId;
  }
  if (state.status?.repo?.id) {
    const byStatus = repos.find((r) => r.id === state.status.repo.id);
    if (byStatus) return byStatus;
    return state.status.repo;
  }
  const path = state.status?.identity?.rootPath || state.path;
  if (path) {
    const byPath = repos.find((r) => samePath(r.root_path, path));
    if (byPath) return byPath;
  }
  return null;
}

function writeUrlState() {
  const q = new URLSearchParams();
  q.set("tab", state.tab);
  q.set("scope", state.brainAll ? "all" : "current");
  if (state.repoId && !state.brainAll) q.set("repo", state.repoId);
  if (state.path && !state.brainAll) q.set("path", state.path);
  history.replaceState(null, "", `?${q.toString()}`);
}

function setTab(tab) {
  if (tab === "stats") tab = "analytics";
  // Paid licenses: Plans is a sell page — don't open it; Setup still has Apply license.
  if (tab === "welcome" && isPaidLicense()) tab = "dashboard";
  if (tab === "brain") {
    state.brainAll = true;
    persistBrainAll(true);
    state.brainError = null;
    resetBrainView();
  } else if (tab === "tasks") {
    // Agents file tasks against whatever repo they were working in, which is rarely the
    // folder the UI was launched from. Default to every memory or the board looks empty.
    state.brainAll = true;
    persistBrainAll(true);
    stopAllViz();
  } else {
    stopAllViz();
  }
  state.tab = tab;
  document.querySelectorAll("#tabs button[data-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  writeUrlState();
  render();
}

// Memory is scoped by a sticky file/search/selection. Carrying those across a tab
// switch makes Memory look like it only loaded part of the store.
function resetBrainView() {
  state.selectedFile = null;
  state.selectedNode = null;
  state.activeEventId = null;
  state.draftSelected = {};
  state.brainSearch = "";
  const search = $("#brainSearch");
  if (search) search.value = "";
}

function syncFocusFromStatus() {
  const identity = state.status?.identity;
  const repo = state.status?.repo || matchBoundRepo();
  if (repo) {
    state.repoId = repo.id;
    state.path = repo.root_path;
  } else if (identity?.rootPath) {
    state.path = identity.rootPath;
    state.repoId = null;
  }
  writeUrlState();
}

async function refreshRepos() {
  try {
    const data = await apiUnscoped("/api/repos");
    state.repos = Array.isArray(data.repos) ? data.repos : [];
  } catch {
    if (Array.isArray(state.status?.repos)) state.repos = state.status.repos;
  }
}

async function refreshStatus() {
  state.status = await api("/api/status");
  await refreshRepos();
  const match = matchBoundRepo();
  if (!state.status?.repo && match && state.repoId !== match.id) {
    state.repoId = match.id;
    state.path = match.root_path;
    state.status = await api("/api/status");
  }
  syncFocusFromStatus();
  hydratePlatforms(state.status);
  state.prefs = state.status?.prefs || state.prefs;
  await refreshVault();
}

async function refreshVault() {
  try {
    state.vault = await apiUnscoped("/api/vault");
    state.vaultError = null;
  } catch (e) {
    state.vault = state.status?.vault || null;
    state.vaultError = e?.message || String(e);
  }
  if (!state.recipe) {
    try {
      state.recipe = await apiUnscoped("/api/recipe");
    } catch {
      state.recipe = null;
    }
  }
  try {
    state.license = await apiUnscoped("/api/license");
  } catch {
    state.license = state.status?.license || null;
  }
  paintPlansNavVisibility(isPaidLicense());
  try {
    state.embed = await apiUnscoped("/api/embed");
  } catch {
    state.embed = state.status?.embed || null;
  }
  paintEmbedIndexBanner();
  try {
    state.shop = await apiUnscoped("/api/shop");
  } catch {
    state.shop = { url: "https://getamem.com", enabled: true, proUrl: "https://getamem.com/buy/pro", itUrl: "https://getamem.com/buy/it" };
  }
  paintVault();
}

function vaultSummaryText() {
  if (state.vaultError && /unknown route/i.test(state.vaultError)) {
    return "This amem UI is outdated — stop the process on port 7843 and run amem ui again";
  }
  const v = state.vault;
  if (!v) return "Vault…";
  const lock = v.encryptedAtRest ? "Locked" : v.encCopyPresent ? "Unlocked" : "Plaintext";
  const backup = v.backup?.last
    ? `Backup ${String(v.backup.last.mtime).slice(0, 10)}`
    : v.backup?.scheduled
      ? "Backup scheduled"
      : "Backup off";
  const bits = [lock, backup];
  if (state.license?.tier) bits.push(`License ${state.license.tier}`);
  if (state.embed?.backend) bits.push(`Embed ${state.embed.backend}`);
  bits.push("Local only");
  return bits.join(" · ");
}

function paintVault() {
  const chips = $("#vaultChips");
  if (chips) chips.textContent = vaultSummaryText();
  const detail = $("#vaultDetail");
  if (detail && state.vault) {
    const last = state.vault.backup?.last;
    detail.textContent = last
      ? `Last backup: ${last.name} · ${last.encrypted ? "encrypted" : "plaintext"} · stays in ${state.vault.backup.dir}`
      : `Backups go to ${state.vault.backup?.dir || "~/.amem/backups"} on this machine.`;
  }
}

async function focusPersonal() {
  const existing = listedRepos().find(isPersonal);
  if (existing) {
    await focusRepo({ repoId: existing.id, tab: state.tab === "setup" ? "setup" : state.tab });
    return;
  }
  try {
    const created = await apiUnscoped("/api/workspaces/personal", { method: "POST", body: "{}" });
    state.repos = (await apiUnscoped("/api/repos")).repos || [];
    await focusRepo({ repoId: created.repo?.id, tab: "brain" });
  } catch (e) {
    alert(e.message);
  }
}

function vaultPassphrase() {
  return $("#vaultPass")?.value || "";
}

function clearVaultPass() {
  const input = $("#vaultPass");
  if (input) input.value = "";
}

async function vaultAction(path, extra = {}) {
  const passphrase = vaultPassphrase();
  try {
    const body = { ...extra };
    if (passphrase) body.passphrase = passphrase;
    const result = await apiUnscoped(path, { method: "POST", body: JSON.stringify(body) });
    state.vault = result.vault || result;
    paintVault();
    clearVaultPass();
    if (path.includes("/lock") || path.includes("/unlock")) {
      await refreshStatus().catch(() => {});
      await render();
    }
  } catch (e) {
    alert(e.message);
  }
}

function emptyGraph(scope = "all") {
  return {
    claims: [],
    components: [],
    flows: [],
    edges: [],
    drafts: [],
    pendingDraftTotal: 0,
    recentClaimIds: [],
    recentEvents: [],
    activity: null,
    scope,
  };
}

async function refreshGraph() {
  state.brainError = null;
  try {
    if (state.brainAll) {
      state.graph = await apiUnscoped("/api/graph?scope=all&days=30");
      return;
    }
    if (!state.status?.repo) {
      state.graph = emptyGraph("current");
      return;
    }
    state.graph = await api("/api/graph?days=30");
  } catch (e) {
    const message = e?.message || String(e);
    if (state.brainAll && state.status?.repo) {
      try {
        state.graph = await api("/api/graph?days=30");
        return;
      } catch {
        /* keep the original error */
      }
    }
    state.brainError = message;
    state.graph = emptyGraph(state.brainAll ? "all" : "current");
  }
}

function statsScope() {
  return state.brainAll ? "all" : "current";
}

function statsFocusLabel() {
  if (state.brainAll) return "All memory";
  const repo = state.status?.repo || matchBoundRepo();
  if (!repo) return "this folder (not tracking yet)";
  if (isPersonal(repo)) return "Personal";
  if (isWorkspace(repo)) return `${repo.repo_name} (workspace)`;
  return repo.repo_name;
}

async function refreshUsage(scope = statsScope(), days = state.statsDays || 30) {
  state.statsDays = days;
  if (scope === "all") {
    state.usage = await apiUnscoped(`/api/usage?scope=all&days=${days}`);
    return;
  }
  if (!state.status?.repo) {
    state.usage = null;
    return;
  }
  state.usage = await api(`/api/usage?days=${days}`);
}

function isTrackingPath(path) {
  return listedRepos().some((r) => samePath(r.root_path, path));
}

async function loadScan({ force = false } = {}) {
  if (state.scan && !force) return;
  state.scanLoading = true;
  if (state.tab === "setup") renderSetup();
  try {
    const [scan, service] = await Promise.all([
      apiUnscoped("/api/scan"),
      apiUnscoped("/api/service"),
    ]);
    state.scan = scan;
    state.service = service;
    if (state.picked.size === 0) {
      for (const r of scan.repos || []) {
        if (r.tracking || samePath(r.path, state.path)) state.picked.add(r.path);
      }
    }
  } catch (e) {
    state.scan = { repos: [], truncated: false, scannedRoots: [] };
    throw e;
  } finally {
    state.scanLoading = false;
  }
}

function isWorkspace(r) {
  if (!r) return false;
  return r.kind === "workspace" || Boolean(r.slug) || String(r.remote_url || "").startsWith("amem://workspace/");
}

function isPersonal(r) {
  if (!r) return false;
  return Boolean(r.personal) || r.slug === "personal" || String(r.remote_url || "").includes("amem://workspace/personal");
}

function shortPath(p) {
  if (!p) return "";
  const home = String(p).replace(/^\/Users\/[^/]+/, "~");
  const parts = home.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 3) return home;
  return `…/${parts.slice(-3).join("/")}`;
}

function memoryLabel(repoId) {
  const r = listedRepos().find((x) => x.id === repoId);
  if (!r) return "unknown";
  if (isPersonal(r)) return "Personal";
  if (isWorkspace(r)) return `${r.repo_name} · workspace`;
  return `${r.repo_name} · repo`;
}

function switcherLabel(r) {
  const n = r.counts?.claims ?? 0;
  const facts = `${n} fact${n === 1 ? "" : "s"}`;
  if (isWorkspace(r)) {
    const slug = r.slug || r.repo_name;
    if (String(r.repo_name).toLowerCase() !== String(slug).toLowerCase()) {
      return `${r.repo_name} · ${slug} · ${facts}`;
    }
    return `${r.repo_name} · ${facts}`;
  }
  return `${r.repo_name} · ${shortPath(r.root_path)}`;
}

function fillRepoSelect() {
  const select = $("#repoSelect");
  if (!select) return;
  const previous = select.value;
  select.replaceChildren();

  const repos = listedRepos();
  const bound = matchBoundRepo();
  const currentId = bound?.id || state.status?.repo?.id || state.repoId;
  const currentPath = state.status?.identity?.rootPath || state.path;
  const inList = Boolean(bound || (currentId && repos.some((r) => r.id === currentId)));

  const addGroup = (label, items) => {
    if (!items.length) return;
    const group = document.createElement("optgroup");
    group.label = label;
    for (const r of items) {
      const opt = document.createElement("option");
      opt.value = `repo:${r.id}`;
      opt.textContent = switcherLabel(r);
      if (!state.brainAll && (r.id === currentId || samePath(r.root_path, currentPath))) opt.selected = true;
      group.appendChild(opt);
    }
    select.appendChild(group);
  };

  const allOpt = document.createElement("option");
  allOpt.value = "__all__";
  allOpt.textContent = "All memory";
  if (state.brainAll) allOpt.selected = true;
  select.appendChild(allOpt);

  addGroup(
    "Personal",
    repos.filter(isPersonal),
  );
  addGroup(
    "Git repos",
    repos.filter((r) => !isWorkspace(r)),
  );
  addGroup(
    "Workspaces",
    repos.filter((r) => isWorkspace(r) && !isPersonal(r)),
  );

  if (!inList && currentPath) {
    const opt = document.createElement("option");
    opt.value = `path:${currentPath}`;
    opt.textContent = `${state.status?.identity?.repoName || currentPath} · not initialized`;
    if (!state.brainAll) opt.selected = true;
    select.appendChild(opt);
  }

  const add = document.createElement("option");
  add.value = "__add__";
  add.textContent = "Add git repo…";
  select.appendChild(add);

  if (!select.value && previous && previous !== "__add__") {
    select.value = previous;
  }

  const renameBtn = $("#renameWsBtn");
  if (renameBtn) {
    const current = repos.find((r) => `repo:${r.id}` === select.value) || matchBoundRepo() || state.status?.repo;
    renameBtn.classList.toggle("hidden", !isWorkspace(current));
  }
}

async function renameWorkspaceUi(repo) {
  if (!repo?.id || !isWorkspace(repo)) return;
  const slug = repo.slug || "";
  const next = prompt(
    slug
      ? `Display name for this workspace.\nMCP still uses workspace=${slug} — memory is unchanged.`
      : "Display name for this workspace",
    repo.repo_name || "",
  );
  if (next == null) return;
  const name = next.trim();
  if (!name || name === repo.repo_name) return;
  try {
    await apiUnscoped("/api/workspaces/rename", {
      method: "POST",
      body: JSON.stringify({ repoId: repo.id, name }),
    });
    state.repos = (await apiUnscoped("/api/repos")).repos || [];
    await refreshStatus();
    await render();
  } catch (e) {
    alert(e.message);
  }
}

function setAddPanel(open) {
  $("#addRepoPanel")?.classList.toggle("hidden", !open);
  if (open) {
    const input = $("#addRepoPath");
    if (input) {
      input.value = "";
      input.focus();
    }
  }
}

async function focusRepo({ repoId = null, path = null, tab = "setup" } = {}) {
  state.repoId = repoId;
  state.path = path;
  state.tab = tab;
  state.graph = null;
  state.usage = null;
  state.activeEventId = null;
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  writeUrlState();
  await refreshStatus();
  await render();
}

async function openAddedPath() {
  const path = $("#addRepoPath")?.value.trim();
  if (!path) return;
  try {
    await focusRepo({ path, tab: "setup" });
    setAddPanel(false);
  } catch (e) {
    alert(e.message);
  }
}

function defaultProposal() {
  const name = state.status?.identity?.repoName || "app";
  return JSON.stringify(
    {
      components: [
        {
          id: `component.${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
          name: `${name} root`,
          code_anchor: "README.md",
        },
      ],
      flows: [{ id: "flow.local_dev", name: "Local development loop" }],
      claims: [
        {
          id: "claim.readme_entry",
          kind: "structure",
          text: "Repository entry documentation lives in README.md.",
          code_anchors: ["README.md"],
        },
      ],
      edges: [
        {
          from_id: "claim.readme_entry",
          from_type: "claim",
          to_id: "flow.local_dev",
          to_type: "flow",
          kind: "about",
        },
      ],
    },
    null,
    2,
  );
}

function renderWelcome() {
  dismissWelcome();
  setTab("dashboard");
}

const SETUP_STEPS = [
  { id: 1, title: "Clients", hint: "Which apps use local memory" },
  { id: 2, title: "Git repos", hint: "Folders amem should watch" },
  { id: 3, title: "Workspaces", hint: "Optional named spaces" },
  { id: 4, title: "Connect", hint: "Paste the recipe into any host" },
];

function setupIsComplete() {
  return listedRepos().length > 0 || Boolean(state.status?.setup?.setup_completed_at);
}

function selectedClientLabels() {
  return knownClients()
    .filter((c) => state.selected.has(c.id))
    .map((c) => c.label);
}

function setupContext() {
  const s = state.status;
  const bound = matchBoundRepo();
  const repos = listedRepos();
  const gitBound = repos.filter((r) => !isWorkspace(r));
  const workspaces = repos.filter(isWorkspace);
  const scanned = state.scan?.repos || [];
  const filter = state.scanFilter.trim().toLowerCase();
  const visible = scanned.filter((r) => {
    if (!filter) return true;
    return `${r.name} ${r.path} ${r.remote || ""}`.toLowerCase().includes(filter);
  });
  return {
    s,
    bound,
    repos,
    gitBound,
    workspaces,
    scanned,
    visible,
    pickedCount: [...state.picked].length,
    serviceOn: Boolean(state.service?.installed),
    focused: bound || s?.repo,
    issues: (s?.doctor || []).filter((i) => !(bound && i === "Repo not initialized")),
  };
}

function clientsBlockHtml() {
  return `<div class="platform-row">
    ${knownClients()
      .map(
        (p) => `<button class="chip ${state.selected.has(p.id) ? "selected" : ""}" data-platform="${esc(p.id)}" type="button">
      <strong>${esc(p.label)}</strong>
      <span>${esc(p.hint)}</span>
    </button>`,
      )
      .join("")}
  </div>`;
}

function autostartBlockHtml() {
  const serviceOn = Boolean(state.service?.installed);
  if (state.service?.supported === false) {
    return `<p class="note">Login auto-start is not supported on this OS.</p>`;
  }
  const extra =
    state.service?.servicePlatform === "linux"
      ? " (systemd user unit)"
      : state.service?.servicePlatform === "win32"
        ? " (Startup folder)"
        : "";
  return `<label class="autostart"><input type="checkbox" id="autostart" ${serviceOn ? "checked" : ""}/> Start amem ui when this computer logs in${extra}</label>`;
}

function gitScanBlockHtml(ctx) {
  const { scanned, visible, gitBound, pickedCount } = ctx;
  return `
    <div class="scan-head">
      <div>
        <strong>Git repos on this Mac</strong>
        <div class="note" style="margin:0.25rem 0 0">${
          state.scanLoading
            ? "Scanning your home folder…"
            : `${scanned.length} found · ${gitBound.length} git repo${gitBound.length === 1 ? "" : "s"} tracking${state.scan?.truncated ? " · scan capped" : ""}`
        }</div>
      </div>
      <div class="scan-actions">
        <input id="scanFilter" type="search" placeholder="Filter repos" value="${state.scanFilter.replaceAll('"', "&quot;")}" />
        <button class="btn secondary small" id="rescanBtn" type="button">Rescan</button>
      </div>
    </div>
    <div class="repo-list" id="repoList">
      ${
        state.scanLoading && scanned.length === 0
          ? `<div class="note">Scanning…</div>`
          : visible.length === 0
            ? `<div class="note">No git repos found in your home folder.</div>`
            : visible
                .map((r) => {
                  const tracking = r.tracking || isTrackingPath(r.path);
                  const checked = state.picked.has(r.path);
                  return `<label class="repo-row ${tracking ? "tracking" : ""}">
                    <input type="checkbox" data-path="${r.path.replaceAll('"', "&quot;")}" ${checked ? "checked" : ""} />
                    <span>
                      <b>${r.name}</b>
                      ${tracking ? `<em>tracking</em>` : ""}
                      <small>${r.path}</small>
                    </span>
                  </label>`;
                })
                .join("")
      }
    </div>
    <div class="actions">
      <button class="btn" id="trackBtn">Start tracking selected (${pickedCount || visible.filter((r) => r.tracking).length})</button>
    </div>`;
}

function workspaceBlockHtml(ctx) {
  const { workspaces, focused } = ctx;
  return `
    <div class="scan-head">
      <div>
        <strong>Named workspaces</strong>
        <div class="note" style="margin:0.25rem 0 0">Not git checkouts. Rename the label anytime — the MCP id and memory stay put.</div>
      </div>
    </div>
    <div class="repo-list" id="workspaceList">
      ${
        workspaces.length === 0
          ? `<div class="note">None yet. Create one below for Luna or any MCP host.</div>`
          : workspaces
              .map((w) => {
                const slug = w.slug || "";
                const n = w.counts?.claims ?? 0;
                const active = focused?.id === w.id;
                return `<div class="repo-row workspace-row ${active ? "tracking" : ""}" data-focus-ws="${esc(w.id)}">
                  <span>
                    <b>${esc(w.repo_name)}</b>
                    <em>workspace</em>
                    <small>MCP id ${esc(slug)} · ${n} fact${n === 1 ? "" : "s"}</small>
                  </span>
                  <button class="btn secondary small" type="button" data-rename-ws="${esc(w.id)}">Rename</button>
                </div>`;
              })
              .join("")
      }
    </div>
    <div class="workspace-add">
      <label class="note">Create a workspace (no git repo required)</label>
      <div class="add-repo-row">
        <input id="wsName" type="text" placeholder="Luna Client" />
        <button class="btn secondary" id="wsBtn" type="button">Create workspace</button>
      </div>
      <p class="note">Any MCP host: keep this UI running, then connect to <code>http://127.0.0.1:7843/mcp?workspace=SLUG</code> (not a bare <code>amem</code> command — GUI apps often cannot see Homebrew on PATH).</p>
    </div>`;
}

function isPaidLicense() {
  return true;
}

/** Paid users don't need the Plans sell tab in the sidebar (Setup still has Apply license). */
function paintPlansNavVisibility(paid) {
  const btn = document.querySelector('#tabs button[data-tab="welcome"]');
  if (!btn) return;
  btn.classList.add("hidden");
}

function licenseApplyHtml(idPrefix = "lic") {
  return `
    <div class="license-apply" id="${idPrefix}ApplyBox">
      <h2>Apply license</h2>
      <p class="note">After checkout, paste <code>amem-license.json</code> or choose the downloaded file. Memory never uploads.</p>
      <textarea id="${idPrefix}LicenseText" rows="5" placeholder='{"kind":"signed","payload":{…},"signature":"…"}'></textarea>
      <div class="license-apply-actions">
        <label class="btn secondary small license-file-label">Choose file
          <input type="file" id="${idPrefix}LicenseFile" accept="application/json,.json" hidden />
        </label>
        <button class="btn" type="button" id="${idPrefix}LicenseApply">Apply license</button>
      </div>
      <p class="note" id="${idPrefix}LicenseMsg"></p>
    </div>`;
}

function proOnboardHtml(idPrefix = "onboard") {
  if (!isPaidLicense()) return "";
  const backend = state.embed?.backend || "hash";
  const ngramOn = backend === "ngram" || backend === "external";
  const done = loadProOnboardDone();
  const hygieneDone = Boolean(done.hygiene) || Boolean(state.hygieneSchedule?.installed);
  const rulesDone = Boolean(done.rules);
  const steps = [
    { id: "embed", done: ngramOn || Boolean(done.embed), label: "Pro retrieval (n-gram)" },
    { id: "reindex", done: ngramOn || Boolean(done.reindex), label: "Reindex embeddings" },
    { id: "hygiene", done: hygieneDone, label: "Weekly hygiene schedule" },
    { id: "rules", done: rulesDone, label: "Sync pinned → Cursor rules" },
  ];
  const allDone = steps.every((s) => s.done);
  return `
    <div class="pro-onboard" id="${idPrefix}Onboard">
      <h2>${allDone ? "Pro is on" : "Turn on Pro"}</h2>
      <p class="note">${
        allDone
          ? "Checklist complete on this machine. Open Memory anytime for Compare retrieval or Cleanup."
          : "Paying should change defaults immediately — enable richer retrieval, then clean and sync."
      }</p>
      <ol class="pro-onboard-steps">
        ${steps
          .map(
            (s) =>
              `<li class="${s.done ? "done" : ""}"><span class="setup-check" aria-hidden="true">${s.done ? "✓" : "·"}</span> ${esc(s.label)}</li>`,
          )
          .join("")}
      </ol>
      ${
        allDone
          ? ""
          : `<label class="autostart brain-auto" style="margin:0.5rem 0 0.75rem;display:flex">
        <input type="checkbox" id="${idPrefix}HygieneSched" checked /> Also schedule weekly hygiene (Sunday)
      </label>
      <div class="actions">
        <button class="btn" type="button" id="${idPrefix}EnablePro">Turn on Pro retrieval</button>
        <button class="btn secondary" type="button" id="${idPrefix}OpenReview">Open Cleanup</button>
        ${
          state.license?.features?.includes("rules_sync") && !state.brainAll
            ? `<button class="btn secondary" type="button" id="${idPrefix}RulesSync">Sync pinned rules</button>`
            : ""
        }
      </div>`
      }
      <p class="note" id="${idPrefix}OnboardMsg"></p>
    </div>`;
}

const PRO_ONBOARD_STORAGE = "amem.proOnboard.done";

function loadProOnboardDone() {
  try {
    return JSON.parse(localStorage.getItem(PRO_ONBOARD_STORAGE) || "{}") || {};
  } catch {
    return {};
  }
}

function markProOnboardDone(keys) {
  const cur = loadProOnboardDone();
  for (const k of keys) cur[k] = true;
  try {
    localStorage.setItem(PRO_ONBOARD_STORAGE, JSON.stringify(cur));
  } catch {
    /* ignore */
  }
}

async function applyLicenseFromUi(text, msgEl) {
  const raw = String(text || "").trim();
  if (!raw) {
    if (msgEl) msgEl.textContent = "Paste license JSON or choose a file first.";
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (msgEl) msgEl.textContent = "That is not valid JSON.";
    return false;
  }
  try {
    const status = await apiUnscoped("/api/license/apply", {
      method: "POST",
      body: JSON.stringify({ json: parsed }),
    });
    state.license = status;
    try {
      state.embed = await apiUnscoped("/api/embed");
    } catch {
      /* keep */
    }
    if (msgEl) msgEl.textContent = `Applied ${status.tier} license.`;
    return true;
  } catch (e) {
    if (msgEl) msgEl.textContent = e?.message || String(e);
    return false;
  }
}

function wireLicenseApply(idPrefix, onApplied) {
  const msg = $(`#${idPrefix}LicenseMsg`);
  const area = $(`#${idPrefix}LicenseText`);
  $(`#${idPrefix}LicenseFile`)?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    if (area) area.value = text;
  });
  $(`#${idPrefix}LicenseApply`)?.addEventListener("click", async () => {
    const ok = await applyLicenseFromUi(area?.value || "", msg);
    if (ok && onApplied) await onApplied();
  });
}

function wireProOnboard(idPrefix) {
  const msg = $(`#${idPrefix}OnboardMsg`);
  $(`#${idPrefix}EnablePro`)?.addEventListener("click", async () => {
    try {
      if (msg) msg.textContent = "Enabling n-gram…";
      state.embed = await apiUnscoped("/api/embed", {
        method: "POST",
        body: JSON.stringify({ backend: "ngram" }),
      });
      if (msg) msg.textContent = "Reindexing…";
      await apiUnscoped("/api/embed/reindex", { method: "POST", body: "{}" });
      markProOnboardDone(["embed", "reindex"]);
      const schedOn = Boolean($(`#${idPrefix}HygieneSched`)?.checked);
      if (schedOn) {
        if (msg) msg.textContent = "Scheduling weekly hygiene…";
        try {
          await apiUnscoped("/api/hygiene/schedule", {
            method: "POST",
            body: JSON.stringify({ hour: 4 }),
          });
          markProOnboardDone(["hygiene"]);
        } catch (schedErr) {
          if (msg) msg.textContent = `Pro retrieval is on. Hygiene schedule failed: ${schedErr?.message || schedErr}`;
          if (state.tab === "welcome") renderWelcome();
          else if (state.tab === "setup") renderSetup();
          return;
        }
      }
      if (msg) {
        msg.textContent = schedOn
          ? "Pro retrieval is on and weekly hygiene is scheduled. Run a showdown in Memory anytime."
          : "Pro retrieval is on. Run a showdown in Memory anytime.";
      }
      if (state.tab === "welcome") renderWelcome();
      else if (state.tab === "setup") renderSetup();
    } catch (e) {
      if (msg) msg.textContent = e?.message || String(e);
    }
  });
  $(`#${idPrefix}OpenReview`)?.addEventListener("click", () => {
    state.brainFilter = "review";
    setTab("brain");
  });
  $(`#${idPrefix}RulesSync`)?.addEventListener("click", async () => {
    try {
      const result = await api("/api/rules/sync", { method: "POST", body: "{}" });
      markProOnboardDone(["rules"]);
      if (msg) msg.textContent = result?.path ? `Wrote ${result.path}` : "Rules synced.";
      if (state.tab === "setup") renderSetup();
    } catch (e) {
      if (msg) msg.textContent = e?.message || String(e);
    }
  });
}

function shopBuyCardHtml() {
  return `
    <div class="setup-shop">
      <div class="setup-shop-head">
        <div>
          <h2>All Features Unlocked</h2>
          <p class="note">amem is 100% free and private. Pro retrieval (n-gram semantic search), memory hygiene, rules sync, security attest, and tasks are all active on this machine.</p>
        </div>
      </div>
      ${proOnboardHtml("setup")}
      ${itPackCardHtml()}
    </div>`;
}

function itPackCardHtml() {
  return `
    <div class="it-pack-card" id="itPackCard">
      <h2>Security & Ops pack (local)</h2>
      <p class="note">Writes policy, MDM plist, SBOM, and offboard script under <code>~/.amem/it-pack</code>. Full <code>amem doctor --attest</code> packet is included.</p>
      <div class="actions">
        <button class="btn secondary" type="button" id="genItPack">Generate security pack</button>
        <button class="btn secondary" type="button" id="runAttest">Show attest summary</button>
      </div>
      <pre class="it-pack-out hidden" id="itPackOut"></pre>
    </div>`;
}

function recipeBlockHtml() {
  return `
    <div class="recipe-card">
      <div class="scan-head">
        <div>
          <strong>Remember contract (any MCP host)</strong>
          <div class="note" style="margin:0.25rem 0 0">Read first, then write. Same tools for every client — not a per-app fork.</div>
        </div>
        <button class="btn secondary small" id="copyRecipe" type="button">Copy recipe</button>
      </div>
      <pre id="recipePaste">${esc(state.recipe?.paste || "amem recipe")}</pre>
    </div>`;
}

function connectExtrasHtml(ctx) {
  const { s, focused, issues } = ctx;
  const focusedWs = isWorkspace(focused);
  const focusedSlug = focused?.slug || "";
  return `
    ${
      focused
        ? `<div class="status-grid" style="margin-top:1.5rem">
      <div class="stat-line"><span>Focused ${focusedWs ? "workspace" : "git repo"}</span><b>${esc(focused?.repo_name || s?.identity?.repoName || "—")}</b></div>
      ${focusedWs && focusedSlug && focusedSlug !== focused?.repo_name ? `<div class="stat-line"><span>MCP id</span><b>${esc(focusedSlug)}</b></div>` : ""}
      <div class="stat-line"><span>Claims</span><b>${s?.counts?.claims ?? 0}</b></div>
      <div class="stat-line"><span>License</span><b>${esc(s?.license?.tier || state.license?.tier || "free")}</b></div>
    </div>`
        : ""
    }
    ${issues.length ? `<div class="issues">${issues.map((i) => `• ${i}`).join("<br/>")}</div>` : ""}
    ${
      focused
        ? `<div class="bootstrap">
      <label class="note">Bootstrap proposal (applied only to the focused ${focusedWs ? "workspace" : "repo"})</label>
      <textarea id="proposal">${defaultProposal()}</textarea>
      <div class="actions">
        <button class="btn" id="applyBootstrap">Apply bootstrap</button>
      </div>
    </div>`
        : `<p class="note">Track a git repo or create a workspace first if you want to apply a bootstrap proposal.</p>`
    }`;
}

function setupStepperHtml(current) {
  return `<ol class="setup-steps">
    ${SETUP_STEPS.map((step) => {
      const cls = ["setup-step", step.id === current ? "active" : "", step.id < current ? "done" : ""]
        .filter(Boolean)
        .join(" ");
      return `<li>
        <button type="button" class="${cls}" data-setup-step="${step.id}">
          <span class="setup-num">${step.id < current ? "✓" : step.id}</span>
          <span>
            <strong>${esc(step.title)}</strong>
            <em>${esc(step.hint)}</em>
          </span>
        </button>
      </li>`;
    }).join("")}
  </ol>`;
}

function setupDoneHtml(ctx) {
  const { gitBound, workspaces, serviceOn, focused } = ctx;
  const clients = selectedClientLabels();
  const mcpHint = focused?.slug
    ? `http://127.0.0.1:7843/mcp?workspace=${focused.slug}`
    : "http://127.0.0.1:7843/mcp?workspace=personal";
  const rows = [
    {
      title: "Clients",
      detail: clients.length ? clients.join(", ") : "None selected",
    },
    {
      title: "Git repos",
      detail:
        gitBound.length === 0
          ? "None tracking"
          : `${gitBound.length} tracking · ${gitBound
              .slice(0, 3)
              .map((r) => r.repo_name)
              .join(", ")}${gitBound.length > 3 ? "…" : ""}`,
    },
    {
      title: "Workspaces",
      detail:
        workspaces.length === 0
          ? "Skipped — add one anytime"
          : `${workspaces.length} named · ${workspaces.map((w) => w.repo_name).join(", ")}`,
    },
    {
      title: "Connect",
      detail: serviceOn
        ? "Recipe ready · UI starts at login · MCP on 127.0.0.1:7843"
        : "Recipe ready · MCP on 127.0.0.1:7843",
    },
  ];
  return `
    <section class="hero">
      <div class="hero-inner setup-wide">
        <h1>You're set up</h1>
        <p>Memory stays in ~/.amem and never leaves this machine. Every step below is done — change any of them if you need to.</p>
        <ol class="setup-done">
          ${rows
            .map(
              (row, i) => `<li>
            <span class="setup-check" aria-hidden="true">✓</span>
            <div>
              <strong>${i + 1}. ${esc(row.title)}</strong>
              <p>${esc(row.detail)}</p>
            </div>
          </li>`,
            )
            .join("")}
        </ol>
        <div class="setup-verify" id="setupVerify">
          <strong>Verify MCP context</strong>
          <p class="note">Green when a sample query returns at least one claim from this machine.</p>
          <div class="add-repo-row">
            <button class="btn secondary small" type="button" id="probeContext">Test amem_context</button>
            <code class="mcp-url-chip">${esc(mcpHint)}</code>
          </div>
          <p class="note" id="probeContextMsg">Not tested yet.</p>
        </div>
        <div class="actions">
          <button class="btn" id="openBrain" type="button">Open memory</button>
          <button class="btn secondary" id="editSetup" type="button">Change setup</button>
        </div>
        ${recipeBlockHtml()}
        ${shopBuyCardHtml()}
      </div>
    </section>`;
}

function setupWizardHtml(ctx) {
  const step = Math.min(4, Math.max(1, state.setupStep || 1));
  const titles = {
    1: { h: "Which apps?", p: "Pick every agent that should read and write local memory. You can change this later." },
    2: { h: "Which git repos?", p: "Select folders to track. Chats in those folders will use this machine's memory." },
    3: { h: "Named workspaces?", p: "Optional. Use these when there is no git checkout — Luna, a GUI host, or a personal space." },
    4: { h: "Connect a host", p: "Keep this UI running. Paste the recipe into any MCP client. Then open Memory to see what's stored." },
  };
  const copy = titles[step];
  const body =
    step === 1
      ? `${clientsBlockHtml()}${autostartBlockHtml()}`
      : step === 2
        ? gitScanBlockHtml(ctx)
        : step === 3
          ? workspaceBlockHtml(ctx)
          : `${recipeBlockHtml()}${connectExtrasHtml(ctx)}`;
  const back = step > 1 ? `<button class="btn secondary" id="setupBack" type="button">Back</button>` : "";
  const next =
    step === 4
      ? `<button class="btn" id="openBrain" type="button">Open memory</button>`
      : `<button class="btn${step === 1 ? "" : " secondary"}" id="setupNext" type="button">${step === 1 ? "Continue" : "Skip for now"}</button>`;
  return `
    <section class="hero">
      <div class="hero-inner setup-wide">
        <h1>Setup</h1>
        <p>Four short steps. Memory stays in ~/.amem and never leaves localhost.</p>
        ${setupStepperHtml(step)}
        <div class="setup-panel">
          <h2>${esc(copy.h)}</h2>
          <p class="note setup-lead">${esc(copy.p)}</p>
          ${body}
        </div>
        <div class="actions setup-nav">
          ${back}
          ${next}
          ${setupIsComplete() ? `<button class="btn secondary" id="setupFinish" type="button">Done</button>` : ""}
        </div>
      </div>
    </section>`;
}

function renderSetup() {
  const ctx = setupContext();
  const main = $("#main");
  setMainMode("page");
  renderPageInsight();
  const showDone = setupIsComplete() && !state.setupEdit;
  main.innerHTML = showDone ? setupDoneHtml(ctx) : setupWizardHtml(ctx);
  bindSetupEvents(main, ctx);
}

function goSetupStep(step) {
  state.setupStep = Math.min(4, Math.max(1, step));
  renderSetup();
}

function bindSetupEvents(main, ctx) {
  const { workspaces, focused } = ctx;
  main.querySelectorAll("[data-setup-step]").forEach((el) => {
    el.addEventListener("click", () => {
      const next = Number(el.dataset.setupStep);
      if (!Number.isFinite(next)) return;
      if (next > (state.setupStep || 1) && !setupIsComplete()) return;
      goSetupStep(next);
    });
  });
  $("#setupNext")?.addEventListener("click", () => {
    if (state.setupStep === 1) persistPlatforms();
    goSetupStep((state.setupStep || 1) + 1);
  });
  $("#setupBack")?.addEventListener("click", () => goSetupStep((state.setupStep || 1) - 1));
  $("#editSetup")?.addEventListener("click", () => {
    state.setupEdit = true;
    state.setupStep = 1;
    renderSetup();
  });
  $("#setupFinish")?.addEventListener("click", () => {
    state.setupEdit = false;
    renderSetup();
  });
  main.querySelectorAll("[data-platform]").forEach((el) => {
    el.addEventListener("click", () => {
      const p = el.dataset.platform;
      if (!p) return;
      if (state.selected.has(p)) {
        if (state.selected.size === 1) return;
        state.selected.delete(p);
      } else {
        state.selected.add(p);
      }
      persistPlatforms();
      renderSetup();
    });
  });
  $("#autostart")?.addEventListener("change", async (e) => {
    try {
      const enabled = e.target.checked;
      const result = await apiUnscoped("/api/service", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
      state.service = { ...(state.service || {}), ...result };
    } catch (err) {
      alert(err.message);
      e.target.checked = !e.target.checked;
    }
  });
  $("#scanFilter")?.addEventListener("input", (e) => {
    state.scanFilter = e.target.value;
    renderSetup();
    const input = $("#scanFilter");
    if (input) {
      input.focus();
      const len = input.value.length;
      input.setSelectionRange(len, len);
    }
  });
  $("#rescanBtn")?.addEventListener("click", async () => {
    try {
      await loadScan({ force: true });
      renderSetup();
    } catch (err) {
      alert(err.message);
      renderSetup();
    }
  });
  main.querySelectorAll("input[data-path]").forEach((el) => {
    el.addEventListener("change", () => {
      const path = el.dataset.path;
      if (el.checked) state.picked.add(path);
      else state.picked.delete(path);
      const btn = $("#trackBtn");
      if (btn) btn.textContent = `Start tracking selected (${state.picked.size})`;
    });
  });
  $("#trackBtn")?.addEventListener("click", async () => {
    const platforms = [...state.selected];
    if (!platforms.length) return alert("Pick at least one platform");
    const paths = [...state.picked];
    if (!paths.length) return alert("Select at least one git repo");
    const btn = $("#trackBtn");
    btn.disabled = true;
    btn.textContent = "Tracking…";
    try {
      const tracked = await apiUnscoped("/api/track", {
        method: "POST",
        body: JSON.stringify({ paths, platforms }),
      });
      persistPlatforms();
      state.repos = tracked.repos || [];
      if (tracked.tracked?.[0]?.id) {
        state.repoId = tracked.tracked[0].id;
        state.path = tracked.tracked[0].root_path;
      }
      await refreshStatus();
      await loadScan({ force: true });
      alert(`Tracking ${tracked.tracked?.length ?? paths.length} repo(s).`);
      state.setupStep = 3;
      state.setupEdit = true;
      render();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
      btn.textContent = "Start tracking selected";
    }
  });
  $("#wsBtn")?.addEventListener("click", async () => {
    const name = $("#wsName")?.value?.trim();
    if (!name) return alert("Name a workspace, e.g. luna");
    try {
      const created = await apiUnscoped("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name, platform: "app" }),
      });
      state.repos = (await apiUnscoped("/api/repos")).repos || [];
      if (created.repo?.id) {
        state.repoId = created.repo.id;
        state.path = created.repo.root_path;
      }
      await refreshStatus();
      const checks = (created.ready?.checks || []).join("\n");
      const label = created.name || created.workspace;
      const mcpUrl = created.mcp?.url || `http://127.0.0.1:7843/mcp?workspace=${created.workspace}`;
      const slugNote =
        created.workspace && created.workspace !== label ? `\nMCP id stays: ${created.workspace}` : "";
      alert(
        `Workspace "${label}" is ready.${checks ? `\n${checks}` : ""}${slugNote}\n\nMCP URL:\n${mcpUrl}`,
      );
      state.setupStep = 4;
      state.setupEdit = true;
      render();
    } catch (err) {
      alert(err.message);
    }
  });
  $("#applyBootstrap")?.addEventListener("click", async () => {
    try {
      const proposal = JSON.parse($("#proposal").value);
      await api("/api/bootstrap", {
        method: "POST",
        body: JSON.stringify({ proposal }),
      });
      await refreshStatus();
      await refreshGraph();
      alert("Baseline memory applied locally.");
      render();
    } catch (e) {
      alert(e.message);
    }
  });
  $("#openBrain")?.addEventListener("click", () => setTab("brain"));
  $("#seePlans")?.addEventListener("click", () => setTab("welcome"));
  wireLicenseApply("setup", async () => {
    await refreshVault();
    renderSetup();
  });
  wireProOnboard("setup");
  wireItPackCard();
  $("#probeContext")?.addEventListener("click", () => probeSetupContext());
  $("#copyRecipe")?.addEventListener("click", async () => {
    const text = state.recipe?.paste || $("#recipePaste")?.textContent || "";
    try {
      await navigator.clipboard.writeText(text);
      const btn = $("#copyRecipe");
      if (btn) btn.textContent = "Copied";
    } catch {
      alert(text);
    }
  });
  main.querySelectorAll("[data-rename-ws]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = el.dataset.renameWs;
      const repo = workspaces.find((w) => w.id === id);
      if (repo) renameWorkspaceUi(repo);
    });
  });
  main.querySelectorAll("[data-focus-ws]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.focusWs;
      if (id && id !== focused?.id) focusRepo({ repoId: id, tab: "setup" });
    });
  });
}

async function probeSetupContext() {
  const msg = $("#probeContextMsg");
  const box = $("#setupVerify");
  if (msg) msg.textContent = "Calling /api/context…";
  try {
    const packet = await api("/api/context", {
      method: "POST",
      body: JSON.stringify({ query: "what should I know about this project" }),
    });
    const n = Array.isArray(packet?.claims) ? packet.claims.length : 0;
    if (n > 0) {
      if (box) box.classList.add("ok");
      if (msg) {
        msg.textContent = `OK — ${n} claim${n === 1 ? "" : "s"} returned. Paste the MCP URL into your host and call amem_context the same way.`;
      }
      noteContextHit();
    } else {
      if (box) box.classList.remove("ok");
      if (msg) {
        msg.textContent =
          "Reachable, but no claims yet. Add a fact in Memory or run bootstrap, then retry.";
      }
    }
  } catch (e) {
    if (box) box.classList.remove("ok");
    if (msg) msg.textContent = e?.message || String(e);
  }
}

function wireItPackCard() {
  $("#genItPack")?.addEventListener("click", async () => {
    const out = $("#itPackOut");
    try {
      const result = await apiUnscoped("/api/it-pack", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (out) {
        out.classList.remove("hidden");
        out.textContent = `Wrote ${result.files?.length || 0} files → ${result.dir}\n\nChecklist:\n1. Deploy policy.toml as /etc/amem/policy.toml\n2. Attach sbom.json + amem doctor --attest --json\n3. Offboard with mdm-offboard.sh when needed`;
      }
    } catch (e) {
      if (out) {
        out.classList.remove("hidden");
        out.textContent = e?.message || String(e);
      }
    }
  });
  $("#runAttest")?.addEventListener("click", async () => {
    const out = $("#itPackOut");
    try {
      const report = await apiUnscoped("/api/attest");
      if (out) {
        out.classList.remove("hidden");
        const sku = report.sku ? JSON.stringify(report.sku, null, 2) : "(no IT sku — Pro/Free)";
        out.textContent = `license: ${report.license?.tier || "?"}\nissues: ${(report.issues || []).length}\n\nsku:\n${sku}`;
      }
    } catch (e) {
      if (out) {
        out.classList.remove("hidden");
        out.textContent = e?.message || String(e);
      }
    }
  });
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function claimAnchors(claim) {
  try {
    const parsed = JSON.parse(claim.code_anchors || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function claimPreview(claim, max = 140) {
  const text = String(claim.text || claim.id || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}…`;
}

function isSessionClaim(claim) {
  return claim.kind === "session" || String(claim.id || "").startsWith("claim.session_");
}

function formatWhen(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const s = (Date.now() - t) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function eventKindOf(ev) {
  if (ev.kind === "local_hit" || ev.kind === "server_trip") return ev.kind;
  return Number(ev.claims_count) > 0 ? "local_hit" : "server_trip";
}

function eventClaimIds(ev) {
  try {
    const ids = JSON.parse(ev.claim_ids || "[]");
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

function eventQueryLabel(ev) {
  const q = String(ev.query || "").trim();
  if (!q || q === "(session start)") return "Session start";
  return q;
}

function relatedForClaim(claimId) {
  const g = state.graph || {};
  const flows = [];
  const components = [];
  for (const e of g.edges || []) {
    const other =
      e.from_id === claimId ? { id: e.to_id, type: e.to_type } : e.to_id === claimId ? { id: e.from_id, type: e.from_type } : null;
    if (!other) continue;
    if (other.type === "flow") {
      const f = (g.flows || []).find((x) => x.id === other.id);
      if (f && !flows.some((x) => x.id === f.id)) flows.push(f);
    }
    if (other.type === "component") {
      const c = (g.components || []).find((x) => x.id === other.id);
      if (c && !components.some((x) => x.id === c.id)) components.push(c);
    }
  }
  return { flows, components };
}

function visibleClaims() {
  const g = state.graph || {};
  const claims = g.claims || [];
  const hot = new Set(g.recentClaimIds || []);
  const filter = state.brainFilter || "files";
  const q = (state.brainSearch || "").trim().toLowerCase();
  return claims.filter((c) => {
    if (q) {
      const hay = `${c.id} ${c.kind || ""} ${c.text || ""} ${claimAnchors(c).join(" ")} ${memoryLabel(c.repo_id)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filter === "durable") return !isSessionClaim(c);
    if (filter === "files") return true;
    if (filter === "chats") return isSessionClaim(c);
    if (filter === "used") return hot.has(c.id);
    if (filter === "pinned") return Number(c.pinned || 0) > 0;
    if (filter === "drafts") return false; // drafts render separately
    return true;
  });
}

// Across all memories the same path exists in several repos, so the group key
// carries the memory. Anything that selects a file must build the key this way.
function fileGroupKey(claim, file) {
  return state.brainAll ? `${memoryLabel(claim.repo_id)} · ${file}` : file;
}

function fileGroups(claims) {
  const groups = new Map();
  for (const c of claims) {
    const anchors = claimAnchors(c);
    const keys = (anchors.length ? anchors : ["(no file yet)"]).map((file) => fileGroupKey(c, file));
    for (const key of keys) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
  }
  const hot = new Set(state.graph?.recentClaimIds || []);
  return [...groups.entries()]
    .map(([file, items]) => ({
      file,
      items,
      used: items.some((c) => hot.has(c.id)),
    }))
    .sort((a, b) => Number(b.used) - Number(a.used) || b.items.length - a.items.length || a.file.localeCompare(b.file));
}

function setMainMode(mode) {
  const main = $("#main");
  if (!main) return;
  main.classList.toggle("tab-brain", mode === "brain");
  syncShellChrome(mode);
}

function syncShellChrome(mode) {
  const isBrain = mode === "brain";
  $("#topSearchWrap")?.classList.toggle("hidden", !isBrain);
  document.querySelectorAll(".top-mem-only").forEach((el) => {
    if (el.id === "rulesSyncBtn") return;
    el.classList.toggle("hidden", !isBrain);
  });
  const rules = $("#rulesSyncBtn");
  if (rules) {
    const show = isBrain && state.license?.features?.includes("rules_sync") && !state.brainAll;
    rules.classList.toggle("hidden", !show);
  }
  const search = $("#brainSearch");
  if (search) {
    if (isBrain) search.value = state.brainSearch || "";
    else search.value = "";
  }
  const auto = $("#autoApplyAll");
  if (auto && isBrain) auto.checked = Boolean(state.prefs?.autoApplyAll);
  const sd = $("#showdownToggle");
  if (sd && isBrain) sd.textContent = state.showdownOpen ? "Hide compare" : "Compare retrieval";
}

function renderPageInsight() {
  const el = $("#rightPanel");
  if (!el) return;
  const tier = state.license?.tier || "free";
  const locked = Boolean(state.vault?.locked);
  const embed = state.embed?.backend || "hashing";
  const repo = state.status?.repo?.repo_name || (state.brainAll ? "All memory" : "—");
  el.innerHTML = `
    <h2>Overview</h2>
    <div class="fact-kpis">
      <div class="fact-kpi"><b>${esc(String(tier))}</b><span>License</span></div>
      <div class="fact-kpi"><b>${locked ? "Yes" : "No"}</b><span>Vault locked</span></div>
      <div class="fact-kpi"><b>${esc(embed)}</b><span>Embedder</span></div>
      <div class="fact-kpi"><b>${(state.graph?.claims || []).length || "—"}</b><span>Facts loaded</span></div>
    </div>
    <div class="insight-card">
      <strong>Focus</strong>
      <p>${esc(repo)}</p>
    </div>
    <div class="insight-card">
      <strong>Local only</strong>
      <p>Memory stays in <code>~/.amem</code>. Use Lock / backup in the sidebar for passphrase protection.</p>
    </div>`;
}

function renderBrainRight() {
  const el = $("#rightPanel");
  if (!el) return;
  const g = state.graph || emptyGraph(state.brainAll ? "all" : "current");
  const events = g.recentEvents || [];
  const hits = events.filter((e) => eventKindOf(e) === "local_hit").length;
  const files = new Set((g.claims || []).flatMap(claimAnchors)).size;
  const drafts = (g.drafts || []).filter((d) => d.status === "pending");
  const pendingTotal = Number(g.pendingDraftTotal ?? drafts.length);
  const pinned = (g.claims || []).filter((c) => Number(c.pinned || 0) > 0).length;
  const drawerOpen = Boolean(state.selectedNode);
  el.innerHTML = `
    <h2>What amem knows</h2>
    <div class="fact-kpis">
      <div class="fact-kpi"><b>${g.claims?.length ?? 0}</b><span>Facts</span></div>
      <div class="fact-kpi"><b>${pendingTotal}</b><span>Waiting</span></div>
      <div class="fact-kpi"><b>${pinned}</b><span>Pinned</span></div>
      <div class="fact-kpi"><b>${hits}</b><span>Hits</span></div>
    </div>
    <p class="note brain-guide"><b>Pin:</b> Memory → <b>Files</b> → click <em>☆ Pin</em> on a fact row (or in this panel after clicking a file). Pinned facts rank higher.</p>
    ${state.brainError ? `<p class="note">${esc(brainErrorNote())}</p>` : ""}
    <div class="right-section">
      <aside class="brain-feed" id="brainFeed"></aside>
    </div>
    <div class="right-section">
      <aside class="drawer ${drawerOpen ? "" : ""}" id="drawer"></aside>
    </div>`;
}

function brainErrorNote() {
  const m = String(state.brainError || "");
  if (!m) return "";
  if (/unknown route|outdated/i.test(m)) {
    return "This amem UI process is outdated. Stop the process on port 7843 and run amem ui again.";
  }
  if (/not initialized/i.test(m)) {
    return "All-memory needs a current amem ui. Track a repo in Setup, or restart the UI on port 7843.";
  }
  return m;
}

function showdownColumnHtml(title, claims) {
  if (!claims?.length) {
    return `<div class="showdown-col"><h3>${esc(title)}</h3><p class="note">No ranked hits.</p></div>`;
  }
  return `<div class="showdown-col">
    <h3>${esc(title)}</h3>
    <ol class="showdown-list">
      ${claims
        .map(
          (c) =>
            `<li><strong>${esc(c.id)}</strong> <span class="note">${esc(String(c.score))}</span>
            <div>${esc((c.text || "").slice(0, 160))}${(c.text || "").length > 160 ? "…" : ""}</div>
            ${c.reasons?.length ? `<div class="note">Why: ${esc(c.reasons.slice(0, 3).join(", "))}</div>` : ""}
            </li>`,
        )
        .join("")}
    </ol>
  </div>`;
}

function paintShowdownResult(data) {
  const el = $("#showdownResult");
  if (!el) return;
  if (!data) {
    el.innerHTML = "";
    return;
  }
  const proOnly = data.proOnlyIds?.length || 0;
  el.innerHTML = `
    <div class="showdown-result-bar">
      <p class="note">Semantic (n-gram) unique hits in top results: <b>${proOnly}</b></p>
      <button class="btn secondary small" type="button" id="showdownClear">Clear</button>
    </div>
    <div class="showdown-grid">
      ${showdownColumnHtml("Hash (128-dim)", data.free)}
      ${showdownColumnHtml("Pro n-gram (256-dim)", data.pro)}
    </div>`;
  $("#showdownClear")?.addEventListener("click", () => clearRetrievalShowdown());
}

function clearRetrievalShowdown() {
  state.showdown = null;
  state.showdownQuery = "";
  const input = $("#showdownQuery");
  if (input) input.value = "";
  paintShowdownResult(null);
}

async function runRetrievalShowdown() {
  const input = $("#showdownQuery");
  const q = String(input?.value || state.showdownQuery || "").trim();
  state.showdownQuery = q;
  const el = $("#showdownResult");
  if (!q) {
    clearRetrievalShowdown();
    return;
  }
  if (el) el.innerHTML = `<p class="note">Running…</p>`;
  try {
    const data = await api("/api/retrieval/showdown", {
      method: "POST",
      body: JSON.stringify({ query: q, limit: 6 }),
    });
    state.showdown = data;
    paintShowdownResult(data);
  } catch (e) {
    if (el) el.innerHTML = `<p class="note">${esc(e?.message || String(e))}</p>`;
  }
}

function softPaywallDismissed() {
  try {
    return sessionStorage.getItem("amem.softPaywall.dismissed") === "1";
  } catch {
    return false;
  }
}

function dismissSoftPaywall() {
  try {
    sessionStorage.setItem("amem.softPaywall.dismissed", "1");
  } catch {
    /* ignore */
  }
  $("#softPaywall")?.classList.add("hidden");
}

async function loadSoftPaywall() {
  const el = $("#softPaywall");
  if (el) {
    el.classList.add("hidden");
    el.innerHTML = "";
  }
}

function maybeNudgeShowdown() {
  if (isPaidLicense() || state.showdownOpen) return;
  try {
    if (sessionStorage.getItem("amem.showdown.nudged") === "1") return;
    const hits = Number(sessionStorage.getItem("amem.context.hits") || "0");
    if (hits < 3) return;
    sessionStorage.setItem("amem.showdown.nudged", "1");
    state.showdownOpen = true;
  } catch {
    /* ignore */
  }
}

function noteContextHit() {
  try {
    const n = Number(sessionStorage.getItem("amem.context.hits") || "0") + 1;
    sessionStorage.setItem("amem.context.hits", String(n));
    if (n === 3 || n === 10) maybeNudgeShowdown();
  } catch {
    /* ignore */
  }
}

function paintEmbedIndexBanner() {
  const el = $("#embedIndexBanner");
  if (!el) return;
  const health = state.embed?.index;
  const stale = Number(health?.stale || 0);
  if (!health || stale <= 0) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const from = (health.strandedBy || [])
    .map((s) => `${s.backend}/${s.dim}`)
    .join(", ");
  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="embed-index-banner-inner">
      <div>
        <strong>Embeddings need a reindex</strong>
        <p class="note" style="margin:0.25rem 0 0">${stale} of ${health.total} facts are indexed as ${esc(from || "another backend")} but active retrieval is <b>${esc(health.active)}/${health.dim}</b>. Semantic search skips them until you reindex.</p>
      </div>
      <div class="embed-index-banner-actions">
        <button class="btn small" type="button" id="embedIndexReindex">Reindex now</button>
      </div>
    </div>`;
  $("#embedIndexReindex")?.addEventListener("click", async () => {
    const btn = $("#embedIndexReindex");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Reindexing…";
    }
    try {
      await apiUnscoped("/api/embed/reindex", { method: "POST", body: "{}" });
      state.embed = await apiUnscoped("/api/embed");
      paintEmbedIndexBanner();
    } catch (e) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Reindex now";
      }
      el.querySelector(".note") &&
        (el.querySelector(".note").textContent = e?.message || String(e));
    }
  });
}

function renderBrain() {
  const main = $("#main");
  state.graphTick += 1;
  setMainMode("brain");
  const drafts = (state.graph?.drafts || []).filter((d) => d.status === "pending");
  const pendingTotal = Number(state.graph?.pendingDraftTotal ?? drafts.length);
  const totalClaims = (state.graph?.claims || []).length;
  const showdownOpen = Boolean(state.showdownOpen);
  const filterHelp = {
    files: "Everything stored, grouped by file — what amem can inject instead of searching.",
    drafts: "Session captures waiting for you. Approve good ones; dismiss junk in bulk.",
    chats: "Takeaways from chats (session facts).",
    used: "Facts that were actually injected into a recent Cursor/Claude query.",
    pinned: "Pinned facts rank higher in retrieval and can sync to Cursor rules (Pro).",
    review: "Pro cleanup: unused facts and near-duplicates.",
  }[state.brainFilter] || "";

  main.innerHTML = `
    <div class="brain-v2">
      <div class="brain-chrome">
        <div class="brain-filters" id="brainFilters" role="tablist" aria-label="Memory views">
          <button type="button" data-filter="files" class="${state.brainFilter === "files" ? "active" : ""}" title="Every stored fact, grouped by file">Files${totalClaims ? ` (${totalClaims})` : ""}</button>
          <button type="button" data-filter="drafts" class="${state.brainFilter === "drafts" ? "active" : ""}" title="Approve session captures">Approve${pendingTotal ? ` (${pendingTotal})` : ""}</button>
          <button type="button" data-filter="chats" class="${state.brainFilter === "chats" ? "active" : ""}" title="Chat takeaways">Chats</button>
          <button type="button" data-filter="used" class="${state.brainFilter === "used" ? "active" : ""}" title="Recently injected">Injected</button>
          <button type="button" data-filter="pinned" class="${state.brainFilter === "pinned" ? "active" : ""}" title="Pinned / boosted facts">Pinned</button>
          <button type="button" data-filter="review" class="${state.brainFilter === "review" ? "active" : ""}" title="Unused & duplicates">Cleanup</button>
        </div>
        ${vizToggleHtml()}
      </div>
      <p class="brain-filter-help">${esc(filterHelp)}</p>
      <div id="softPaywall" class="soft-paywall hidden"></div>
      <div class="showdown-panel ${showdownOpen ? "open" : "closed"}" id="showdownPanel">
        <div class="showdown-run">
          <input id="showdownQuery" type="search" placeholder="Same query · free hash vs Pro n-gram…" value="${esc(state.showdownQuery || "")}" />
          <button class="btn secondary small" type="button" id="showdownBtn">Run</button>
          <button class="btn secondary small ${state.showdown ? "" : "hidden"}" type="button" id="showdownClearTop">Clear</button>
        </div>
        <div id="showdownResult" class="showdown-result"></div>
      </div>
      <div class="brain-body">
        <section class="brain-map" id="brainMap"></section>
      </div>
    </div>`;

  renderBrainRight();
  loadSoftPaywall();

  $("#showdownBtn")?.addEventListener("click", () => runRetrievalShowdown());
  $("#showdownClearTop")?.addEventListener("click", () => clearRetrievalShowdown());
  $("#showdownQuery")?.addEventListener("input", (e) => {
    if (!String(e.target.value || "").trim() && state.showdown) clearRetrievalShowdown();
  });
  $("#showdownQuery")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runRetrievalShowdown();
    if (e.key === "Escape") clearRetrievalShowdown();
  });
  if (state.showdown) paintShowdownResult(state.showdown);
  $("#brainFilters")?.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.brainFilter = btn.dataset.filter;
      state.selectedNode = null;
      state.selectedFile = null;
      if (state.brainFilter !== "drafts") state.draftSelected = {};
      renderBrain();
    });
  });
  bindVizToggle(main);
  try {
    paintBrain();
  } catch (e) {
    const map = $("#brainMap");
    if (map) map.innerHTML = `<p class="note">${esc(e.message || e)}</p>`;
  }
}
function paintBrain() {
  renderBrainFeed();
  renderBrainMap();
  bindCoverageResize();
  if (state.selectedNode) showBrainDetail(state.selectedNode);
  else showBrainOverview();
}

function renderBrainFeed() {
  const el = $("#brainFeed");
  if (!el) return;
  const drafts = (state.graph?.drafts || []).filter((d) => d.status === "pending").slice(0, 12);
  const events = (state.graph?.recentEvents || []).slice(0, 16);
  const draftBlock =
    drafts.length === 0
      ? ""
      : `<h2>Waiting for approval</h2>${drafts
          .map((d) => {
            const active = state.selectedNode?.type === "draft" && state.selectedNode.id === d.id;
            return `<button type="button" class="feed-item draft ${active ? "active" : ""}" data-draft="${esc(d.id)}">
              <div class="feed-top"><span>${esc(d.platform || "agent")} · ${esc(formatWhen(d.created_at))}</span><span class="pill ${d.quality?.label === "high" ? "" : "warn"}">${esc(d.quality?.label || "approve?")}${d.conflicts?.length ? " · conflict" : ""}</span></div>
              <div class="feed-q">${esc(d.title || d.id)}</div>
              <div class="feed-meta">${state.brainAll ? `${esc(memoryLabel(d.repo_id))} · ` : ""}${d.quality ? `Confidence ${d.quality.score}` : "Session capture"} — open Approve tab for bulk actions</div>
            </button>`;
          })
          .join("")}`;

  if (!events.length && !drafts.length) {
    el.innerHTML = `<h2>Recent uses</h2><p class="note" style="margin:0">No <code>amem context</code> hits yet. Ask Cursor something in this repo — local hits show up here. Session-end drafts for approval also land here.</p>`;
    return;
  }
  el.innerHTML = `${draftBlock}<h2>Recent uses</h2>${
    events.length
      ? events
          .map((e) => {
            const kind = eventKindOf(e);
            const ids = eventClaimIds(e);
            const active = state.activeEventId === e.id;
            return `<button type="button" class="feed-item ${kind} ${active ? "active" : ""}" data-event="${esc(e.id)}">
        <div class="feed-top"><span>${esc(e.platform || "agent")} · ${esc(formatWhen(e.created_at))}</span><span class="pill ${kind === "local_hit" ? "ok" : "warn"}">${kind === "local_hit" ? "local hit" : "had to explore"}</span></div>
        <div class="feed-q">${esc(eventQueryLabel(e))}</div>
        <div class="feed-meta">${kind === "local_hit" ? `${ids.length} fact${ids.length === 1 ? "" : "s"} · ~${formatTokens(e.estimated_tokens_saved)} tok` : "amem had nothing useful"}</div>
      </button>`;
          })
          .join("")
      : `<p class="note" style="margin:0">No context hits yet.</p>`
  }`;
  el.querySelectorAll("[data-draft]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const draft = (state.graph.drafts || []).find((x) => x.id === btn.dataset.draft);
      if (!draft) return;
      state.activeEventId = null;
      state.selectedNode = { type: "draft", id: draft.id, detail: draft };
      paintBrain();
    });
  });
  el.querySelectorAll("[data-event]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ev = (state.graph.recentEvents || []).find((x) => x.id === btn.dataset.event);
      if (!ev) return;
      state.activeEventId = ev.id;
      try {
        state.graph.recentClaimIds = eventClaimIds(ev);
      } catch {
        state.graph.recentClaimIds = [];
      }
      state.selectedNode = { type: "event", id: ev.id, detail: ev };
      const files = [...eventFiles(ev)];
      state.selectedFile = files[0] || null;
      paintBrain();
    });
  });
}

function fileLabel(path) {
  const parts = String(path || "").split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return parts.slice(-2).join("/");
}

function coverageGroups() {
  return fileGroups(state.graph?.claims || []);
}

function orbitMemoryLabel(repoId) {
  const r = listedRepos().find((x) => x.id === repoId);
  if (!r) return "unknown";
  if (isPersonal(r)) return "Personal";
  return isWorkspace(r) ? `${r.repo_name} (ws)` : r.repo_name;
}

// Across all memories the ring must be one node per memory: every repo anchors most
// of its facts to README.md, so grouping on the raw path merges five repos into one
// node and hides the smaller ones entirely.
function orbitClaims() {
  const base = visibleClaims().length ? visibleClaims() : state.graph?.claims || [];
  return base.map((c) => {
    const file = claimAnchors(c)[0] || "(no file yet)";
    return state.brainAll
      ? {
          ...c,
          _group: c.repo_id,
          _groupLabel: orbitMemoryLabel(c.repo_id),
          _sub: fileGroupKey(c, file),
          _subLabel: fileLabel(file),
        }
      : { ...c, _group: file, _sub: null };
  });
}

function orbitFocusMemory() {
  if (state.selectedNode?.type === "memory") return state.selectedNode.id;
  if (state.selectedNode?.type === "claim") return state.selectedNode.detail?.repo_id || null;
  return null;
}

function matchingFiles() {
  return new Set(fileGroups(visibleClaims()).map((g) => g.file));
}

function eventFiles(ev) {
  const ids = eventClaimIds(ev);
  const files = new Set();
  for (const id of ids) {
    const claim = (state.graph?.claims || []).find((c) => c.id === id);
    if (!claim) continue;
    for (const a of claimAnchors(claim)) files.add(a);
  }
  return files;
}

function layoutTreemap(items, x, y, w, h) {
  if (!items.length) return [];
  if (items.length === 1) return [{ ...items[0], x, y, w, h }];
  const total = items.reduce((s, i) => s + i.weight, 0) || 1;
  let acc = 0;
  let split = 1;
  for (let i = 0; i < items.length; i++) {
    acc += items[i].weight;
    split = i + 1;
    if (acc >= total / 2) break;
  }
  const left = items.slice(0, split);
  const right = items.slice(split);
  if (!right.length) return [{ ...left[0], x, y, w, h }];
  const leftW = left.reduce((s, i) => s + i.weight, 0);
  const frac = Math.min(0.85, Math.max(0.15, leftW / total));
  if (w >= h) {
    const lw = w * frac;
    return [...layoutTreemap(left, x, y, lw, h), ...layoutTreemap(right, x + lw, y, w - lw, h)];
  }
  const lh = h * frac;
  return [...layoutTreemap(left, x, y, w, lh), ...layoutTreemap(right, x, y + lh, w, h - lh)];
}

let coverageRo = null;
function bindCoverageResize() {
  const host = $("#coverageHost");
  if (coverageRo) {
    coverageRo.disconnect();
    coverageRo = null;
  }
  if (!host || typeof ResizeObserver === "undefined") return;
  coverageRo = new ResizeObserver(() => renderCoverageMap());
  coverageRo.observe(host);
}

function renderCoverageMap() {
  const host = $("#coverageHost");
  if (!host) return;
  const legendH = 28;
  const pad = 2;
  // Clamp: an unbounded host makes the treemap taller than the viewport, so only
  // the single largest tile is ever on screen.
  const w = Math.min(2400, Math.max(160, Math.floor(host.clientWidth)));
  const h = Math.min(1400, Math.max(140, Math.floor(host.clientHeight - legendH)));
  const groups = coverageGroups();
  const matching = matchingFiles();
  const hot = new Set(state.graph?.recentClaimIds || []);
  const selectedFile = state.selectedFile;
  const eventHotFiles =
    state.selectedNode?.type === "event" ? eventFiles(state.selectedNode.detail) : new Set();

  if (!groups.length) {
    host.innerHTML = `
      <div class="coverage-legend">No files in memory yet — bootstrap on Setup or keep working in this repo.</div>
      <svg class="coverage-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Empty coverage map">
        <rect x="8" y="8" width="${w - 16}" height="${h - 16}" rx="10" fill="none" stroke="rgba(232,238,242,0.14)" stroke-dasharray="6 6"/>
        <text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="#8fa3b0" font-size="13">amem has no file coverage here</text>
      </svg>`;
    return;
  }

  const items = groups.map((g) => ({
    file: g.file,
    weight: Math.max(1, g.items.length),
    count: g.items.length,
    used: g.used,
    session: g.items.every(isSessionClaim),
  }));
  const gap = 3;
  const rects = layoutTreemap(items, pad, pad, w - pad * 2, h - pad * 2).map((r) => ({
    ...r,
    x: r.x + gap / 2,
    y: r.y + gap / 2,
    w: Math.max(2, r.w - gap),
    h: Math.max(2, r.h - gap),
  }));

  const tiles = rects
    .map((r, i) => {
      const match = matching.has(r.file);
      const selected = selectedFile === r.file;
      const fromEvent = eventHotFiles.has(r.file);
      const classes = [
        "cov-tile",
        r.used || fromEvent ? "used" : "",
        r.session ? "session" : "",
        match ? "" : "dim",
        selected ? "selected" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const showLabel = r.w > 72 && r.h > 32;
      const showCount = r.w > 72 && r.h > 48;
      const label = fileLabel(r.file);
      const clipId = `cov-clip-${i}`;
      return `<g class="${classes}" data-file="${esc(r.file)}" role="button" tabindex="0">
        <title>${esc(r.file)} · ${r.count} fact${r.count === 1 ? "" : "s"}${r.used ? " · used recently" : ""}</title>
        <clipPath id="${clipId}"><rect x="${r.x.toFixed(1)}" y="${r.y.toFixed(1)}" width="${r.w.toFixed(1)}" height="${r.h.toFixed(1)}" rx="7"/></clipPath>
        <rect x="${r.x.toFixed(1)}" y="${r.y.toFixed(1)}" width="${r.w.toFixed(1)}" height="${r.h.toFixed(1)}" rx="7"/>
        <g clip-path="url(#${clipId})">
        ${
          showLabel
            ? `<text class="cov-name" x="${(r.x + 8).toFixed(1)}" y="${(r.y + 18).toFixed(1)}">${esc(label)}</text>`
            : ""
        }
        ${
          showCount
            ? `<text class="cov-count" x="${(r.x + 8).toFixed(1)}" y="${(r.y + 34).toFixed(1)}">${r.count} fact${r.count === 1 ? "" : "s"}</text>`
            : ""
        }
        </g>
      </g>`;
    })
    .join("");

  host.innerHTML = `
    <div class="coverage-legend">
      <span class="swatch used"></span> used recently
      <span class="swatch file"></span> known file
      <span class="swatch dim"></span> hidden by this tab
      <span class="legend-note">tile size = facts</span>
    </div>
    <svg class="coverage-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="File coverage map">${tiles}</svg>`;

  host.querySelectorAll("[data-file]").forEach((node) => {
    const pick = () => {
      const file = node.getAttribute("data-file");
      const group = coverageGroups().find((g) => g.file === file);
      if (!group) return;
      state.selectedFile = file;
      state.selectedNode = { type: "file", id: file, detail: group };
      paintBrain();
    };
    node.addEventListener("click", pick);
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick();
      }
    });
  });
}

function renderBrainMap() {
  const el = $("#brainMap");
  if (!el) return;

  if (state.brainFilter === "review" || state.brainFilter === "drafts") {
    stopAllViz();
  }

  if (state.brainFilter === "review") {
    el.innerHTML = `<div class="brain-empty">Loading cleanup inbox…</div>`;
    api("/api/hygiene")
      .then((h) => {
        const stale = h.stale || [];
        const dups = h.duplicates || [];
        if (!stale.length && !dups.length) {
          el.innerHTML = `<div class="brain-empty">Nothing to clean up. Unused facts (90 days) and near-duplicates show up here on Pro/IT.${
            h.schedule?.installed ? " Weekly hygiene is scheduled." : ""
          }</div>`;
          return;
        }
        el.innerHTML = `
          <div class="draft-toolbar">
            <button class="btn small" type="button" id="acceptSafe">Accept safe cleanups</button>
            <button class="btn secondary small" type="button" id="decayStale">Decay ${stale.length} unused</button>
            ${
              h.schedule?.installed
                ? `<button class="btn secondary small" type="button" id="hygieneUnsched">Unschedule weekly</button>`
                : `<button class="btn secondary small" type="button" id="hygieneSched">Schedule weekly</button>`
            }
          </div>
          ${
            dups.length
              ? `<h2>Near-duplicates</h2>${dups
                  .map(
                    (d) =>
                      `<div class="draft-card"><strong>${esc(d.keepId)}</strong> vs ${esc(d.dropId)} · ${Math.round((d.similarity || 0) * 100)}%<div class="drawer-actions"><button class="btn secondary small" type="button" data-merge-keep="${esc(d.keepId)}" data-merge-drop="${esc(d.dropId)}">Merge into keep</button></div></div>`,
                  )
                  .join("")}`
              : ""
          }
          ${
            stale.length
              ? `<h2>Unused ${stale.length}</h2>${stale
                  .slice(0, 24)
                  .map((c) => `<div class="draft-card"><strong>${esc(c.id)}</strong><span class="meta">${esc((c.text || "").slice(0, 160))}</span></div>`)
                  .join("")}`
              : ""
          }`;
        $("#acceptSafe")?.addEventListener("click", async () => {
          try {
            const result = await api("/api/hygiene/accept-safe", { method: "POST", body: "{}" });
            await refreshGraph();
            renderBrain();
            alert(
              `Decayed ${result.decayed?.length || 0}; merged ${result.merged?.length || 0}.`,
            );
          } catch (err) {
            alert(err.message);
          }
        });
        $("#decayStale")?.addEventListener("click", async () => {
          try {
            const result = await api("/api/hygiene/decay", { method: "POST", body: "{}" });
            await refreshGraph();
            renderBrain();
            alert(`Decayed ${result.decayed?.length || 0} facts.`);
          } catch (err) {
            alert(err.message);
          }
        });
        $("#hygieneSched")?.addEventListener("click", async () => {
          try {
            await apiUnscoped("/api/hygiene/schedule", {
              method: "POST",
              body: JSON.stringify({ hour: 4 }),
            });
            renderBrain();
          } catch (err) {
            alert(err.message);
          }
        });
        $("#hygieneUnsched")?.addEventListener("click", async () => {
          try {
            await apiUnscoped("/api/hygiene/unschedule", { method: "POST", body: "{}" });
            renderBrain();
          } catch (err) {
            alert(err.message);
          }
        });
        el.querySelectorAll("[data-merge-keep]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            try {
              await api("/api/hygiene/merge", {
                method: "POST",
                body: JSON.stringify({ keepId: btn.dataset.mergeKeep, dropId: btn.dataset.mergeDrop }),
              });
              await refreshGraph();
              renderBrain();
            } catch (err) {
              alert(err.message);
            }
          });
        });
      })
      .catch((err) => {
        el.innerHTML = `<div class="brain-empty">${esc(err.message)}</div>`;
      });
    return;
  }

  if (state.brainFilter === "drafts") {
    const drafts = (state.graph?.drafts || []).filter((d) => d.status === "pending");
    const pendingTotal = Number(state.graph?.pendingDraftTotal ?? drafts.length);
    const selectedId = state.selectedNode?.type === "draft" ? state.selectedNode.id : null;
    const selectedIds = Object.keys(state.draftSelected || {}).filter((id) => state.draftSelected[id]);
    const counts = { high: 0, medium: 0, low: 0, reject: 0 };
    for (const d of drafts) {
      const label = d.quality?.label || "medium";
      if (counts[label] != null) counts[label] += 1;
    }
    const highN = counts.high;
    const junkN = counts.low + counts.reject;

    if (drafts.length === 0) {
      el.innerHTML = `<div class="brain-empty">
        <strong>Nothing waiting</strong>
        <p>When a Cursor session ends, amem queues a short capture here. Approve to store it as a fact, or dismiss.</p>
        <p class="note">Tip: turn on <b>Auto-approve</b> in the top bar if you trust most captures.</p>
      </div>`;
      return;
    }

    el.innerHTML = `
      <div class="draft-inbox">
        <div class="draft-inbox-head">
          <div>
            <h2>Approve captures <span>${pendingTotal} waiting${pendingTotal > drafts.length ? ` · showing ${drafts.length}` : ""}</span></h2>
            <p class="note">These are proposed facts from sessions — not stored until you approve. Use bulk actions so you don’t open 400 one-by-one.</p>
          </div>
          <div class="draft-quality-pills">
            <span class="pill ok">${highN} high</span>
            <span class="pill">${counts.medium} medium</span>
            <span class="pill warn">${junkN} low/junk</span>
          </div>
        </div>
        <div class="draft-toolbar">
          <button class="btn small" type="button" id="approveHigh" ${highN ? "" : "disabled"}>Approve all high (${highN})</button>
          <button class="btn secondary small" type="button" id="dismissJunk" ${junkN ? "" : "disabled"}>Dismiss junk (${junkN})</button>
          <button class="btn secondary small" type="button" id="dismissAllDrafts">Dismiss all ${pendingTotal}</button>
          <span class="draft-sel-meta">${selectedIds.length ? `${selectedIds.length} selected` : "or select rows"}</span>
          <button class="btn secondary small" type="button" id="applySelected" ${selectedIds.length ? "" : "disabled"}>Approve selected</button>
          <button class="btn secondary small" type="button" id="dismissSelected" ${selectedIds.length ? "" : "disabled"}>Dismiss selected</button>
          <button class="btn secondary small" type="button" id="selectAllDrafts">Select all shown</button>
          <button class="btn secondary small" type="button" id="clearDraftSel" ${selectedIds.length ? "" : "disabled"}>Clear</button>
        </div>
        <div class="draft-grid">${drafts
          .map((d) => {
            const checked = Boolean(state.draftSelected?.[d.id]);
            const q = d.quality?.label || "unscored";
            return `<div class="draft-card ${selectedId === d.id ? "selected" : ""}" data-draft-map="${esc(d.id)}">
              <label class="draft-check" title="Select for bulk">
                <input type="checkbox" data-draft-check="${esc(d.id)}" ${checked ? "checked" : ""} />
              </label>
              <button type="button" class="draft-card-main" data-draft-open="${esc(d.id)}">
                <strong>${esc(d.title || d.id)}</strong>
                <span class="meta">${esc(d.platform || "agent")} · ${esc(formatWhen(d.created_at))} · <em class="q-${esc(q)}">${esc(q)}${d.quality ? ` ${d.quality.score}` : ""}</em>${d.conflicts?.length ? " · conflict" : ""}</span>
              </button>
            </div>`;
          })
          .join("")}</div>
      </div>`;

    const runBulk = async (action, extra = {}) => {
      try {
        const result = await api("/api/drafts/bulk", {
          method: "POST",
          body: JSON.stringify({
            action,
            scope: state.brainAll ? "all" : undefined,
            ...extra,
          }),
        });
        state.draftSelected = {};
        state.selectedNode = null;
        await refreshGraph();
        renderBrain();
        const parts = [];
        if (result.appliedCount) parts.push(`approved ${result.appliedCount}`);
        if (result.dismissedCount) parts.push(`dismissed ${result.dismissedCount}`);
        if (result.skipped?.length) parts.push(`skipped ${result.skipped.length}`);
        if (parts.length) alert(parts.join(" · "));
      } catch (err) {
        alert(err.message);
      }
    };

    $("#approveHigh")?.addEventListener("click", () => runBulk("approve_high"));
    $("#dismissJunk")?.addEventListener("click", () => runBulk("dismiss_junk"));
    $("#dismissAllDrafts")?.addEventListener("click", () => {
      if (!confirm(`Dismiss all ${pendingTotal} waiting captures? This cannot be undone.`)) return;
      runBulk("dismiss_all", { confirm: true });
    });
    $("#applySelected")?.addEventListener("click", () => {
      const ids = Object.keys(state.draftSelected || {}).filter((id) => state.draftSelected[id]);
      if (!ids.length) return;
      runBulk("apply_ids", { ids, resolve: "keep" });
    });
    $("#dismissSelected")?.addEventListener("click", () => {
      const ids = Object.keys(state.draftSelected || {}).filter((id) => state.draftSelected[id]);
      if (!ids.length) return;
      runBulk("dismiss_ids", { ids });
    });
    $("#selectAllDrafts")?.addEventListener("click", () => {
      state.draftSelected = Object.fromEntries(drafts.map((d) => [d.id, true]));
      renderBrain();
    });
    $("#clearDraftSel")?.addEventListener("click", () => {
      state.draftSelected = {};
      renderBrain();
    });
    el.querySelectorAll("[data-draft-check]").forEach((box) => {
      box.addEventListener("click", (e) => e.stopPropagation());
      box.addEventListener("change", () => {
        const id = box.dataset.draftCheck;
        state.draftSelected = { ...(state.draftSelected || {}), [id]: box.checked };
        renderBrain();
      });
    });
    el.querySelectorAll("[data-draft-open]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const draft = (state.graph.drafts || []).find((x) => x.id === btn.dataset.draftOpen);
        if (!draft) return;
        state.selectedNode = { type: "draft", id: draft.id, detail: draft };
        paintBrain();
      });
    });
    return;
  }

  const claims = visibleClaims();
  const groups = fileGroups(claims);
  const selectedFile = state.selectedFile;
  const shown = selectedFile
    ? coverageGroups().filter((g) => g.file === selectedFile)
    : groups;
  const hot = new Set(state.graph?.recentClaimIds || []);
  const selectedId = state.selectedNode?.type === "claim" ? state.selectedNode.id : null;
  const filterHint =
    state.brainFilter === "used"
      ? "Only facts injected in a recent query."
      : state.brainFilter === "chats"
        ? "Chat takeaways. Other files stay on the map, dimmed."
        : state.brainFilter === "pinned"
          ? "Pinned facts only — click Pin on any row to boost retrieval."
          : "Each tile is a file amem can inject. Use ★ Pin on a row to boost it.";

  const list =
    shown.length === 0
      ? `<div class="brain-empty">${
          state.brainFilter === "used"
            ? "Nothing in this repo has been injected yet — the map still shows what is stored."
            : state.brainFilter === "chats"
              ? "No session takeaways yet. Approve a capture or keep chatting."
              : state.brainFilter === "pinned"
                ? "No pinned facts yet. On any fact row, click <b>Pin</b> — pinned facts rank higher and fill this view."
                : state.brainSearch
                  ? "No facts match that filter. Clear the search box to see everything again."
                  : "No facts yet. Apply a bootstrap on Setup, or keep working in this repo."
        }</div>`
      : shown
          .map((group) => {
            const usedClass = group.used ? "used" : "";
            return `<article class="file-card ${usedClass}">
        <header>
          <code>${esc(group.file)}</code>
          <span>${group.items.length} fact${group.items.length === 1 ? "" : "s"}${group.used ? " · used recently" : ""}</span>
        </header>
        <ul>
          ${group.items
            .map((c) => {
              const rel = relatedForClaim(c.id);
              const isPinned = Number(c.pinned || 0) > 0;
              const tags = [
                isPinned ? "pinned" : null,
                c.kind,
                ...rel.flows.map((f) => f.name),
                ...rel.components.map((x) => x.name),
              ]
                .filter(Boolean)
                .slice(0, 4);
              return `<li class="claim-li">
                <button type="button" class="claim-row ${hot.has(c.id) ? "hot" : ""} ${selectedId === c.id ? "selected" : ""}" data-claim="${esc(c.id)}">
                  <span class="claim-text">${esc(claimPreview(c))}</span>
                  <span class="claim-tags">${tags.map((t) => `<em>${esc(t)}</em>`).join("")}</span>
                </button>
                ${pinButtonHtml(c)}
              </li>`;
            })
            .join("")}
        </ul>
      </article>`;
          })
          .join("");

  const mode = state.memoryViz || "map";
  const scopeLabel = state.brainAll
    ? "All memory"
    : state.status?.repo?.repo_name || "Memory";

  const vizBlock =
    mode === "orbit"
      ? `<div class="orbit-host viz-host" id="orbitHost">
            <div class="viz-banner">
              <span>${esc(scopeLabel)} · ${state.brainAll ? "click a memory, then a file" : "click a file, then a fact"}</span>
            </div>
            <canvas id="orbitCanvas" aria-label="Orbit memory map"></canvas>
            <div class="viz-legend">
              <span><i class="sw teal"></i> Used recently</span>
              <span><i class="sw gold"></i> Has pinned</span>
              <span><i class="sw blue"></i> ${state.brainAll ? "Other memories" : "Other files"}</span>
            </div>
          </div>`
      : mode === "blocks"
        ? `<div class="coverage-host viz-host" id="coverageHost"></div>`
        : "";

  // Files is the plain list; Blocks and Orbit put their visual on top of it.
  el.innerHTML =
    mode === "map"
      ? `<div class="brain-facts">
      <div class="pin-howto">
        <strong>Pin a fact</strong>
        <span>Click <em>☆ Pin</em> on any row below — pinned facts rank higher in retrieval and fill the Pinned tab.</span>
      </div>
      <h2>${selectedFile ? esc(fileLabel(selectedFile)) : "Facts"} <span>${esc(filterHint)}</span></h2>
      ${list}
    </div>`
      : `${vizBlock}
    <div class="brain-facts">
      <h2>${selectedFile ? esc(fileLabel(selectedFile)) : "Facts"} <span>${esc(filterHint)}</span></h2>
      ${list}
    </div>`;

  stopAllViz();
  if (mode === "orbit") {
    const canvas = $("#orbitCanvas");
    if (canvas) {
      try {
        orbitViz = createOrbitViz(canvas, {
          onSelectFile: (file) => {
            state.selectedFile = file;
            const group = coverageGroups().find((g) => g.file === file);
            state.selectedNode = group
              ? { type: "file", id: file, detail: group }
              : { type: "file", id: file, detail: { file, items: [] } };
            showBrainDetail(state.selectedNode);
            // Across memories the ring is focused on a memory, so keep it there
            // when the click came from a file on the outer ring.
            if (!state.brainAll) orbitViz?.setFocus(file);
          },
          onSelectClaim: (claim) => {
            if (!claim) return;
            const anchors = claimAnchors(claim);
            if (anchors[0]) state.selectedFile = anchors[0];
            state.selectedNode = { type: "claim", id: claim.id, detail: claim };
            showBrainDetail(state.selectedNode);
            orbitViz?.setSelectedClaim(claim.id);
            el.querySelectorAll(".claim-row").forEach((row) => {
              row.classList.toggle("selected", row.dataset.claim === claim.id);
            });
          },
          onSelectGroup: state.brainAll
            ? (group) => {
                state.selectedFile = null;
                state.selectedNode = { type: "memory", id: group.id, detail: group };
                showBrainDetail(state.selectedNode);
                orbitViz?.setFocus(group.id);
              }
            : null,
        });
        orbitViz.setData({
          claims: orbitClaims(),
          recentClaimIds: state.graph?.recentClaimIds || [],
          selectedFile: state.brainAll ? orbitFocusMemory() : state.selectedFile,
          selectedClaim: selectedId,
          label: scopeLabel,
          ringLabel: state.brainAll ? "memories" : "files",
        });
        orbitViz.start();
      } catch (err) {
        const host = $("#orbitHost");
        if (host) host.innerHTML = `<div class="brain-empty">Orbit view failed: ${esc(err.message || err)}</div>`;
      }
    }
  } else if (mode === "blocks") {
    renderCoverageMap();
  }
  bindClaimClicks(el);
  bindPinButtons(el);
  bindVizToggle(el);
}

function bindClaimClicks(root) {
  root.querySelectorAll("[data-claim]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const claim = (state.graph.claims || []).find((c) => c.id === btn.dataset.claim);
      if (!claim) return;
      const anchors = claimAnchors(claim);
      if (anchors[0]) state.selectedFile = anchors[0];
      state.selectedNode = { type: "claim", id: claim.id, detail: claim };
      renderBrain();
    });
  });
}

async function toggleClaimPin(id, repoId) {
  const claim = (state.graph.claims || []).find((c) => c.id === id);
  if (!claim) return;
  const pinned = !(Number(claim.pinned || 0) > 0);
  await api("/api/claims/pin", {
    method: "POST",
    repoId: claim.repo_id || repoId,
    body: JSON.stringify({ id, pinned }),
  });
  await refreshGraph();
  if (state.selectedNode?.type === "claim" && state.selectedNode.id === id) {
    const updated = (state.graph.claims || []).find((c) => c.id === id);
    if (updated) state.selectedNode = { type: "claim", id, detail: updated };
  }
  paintBrain();
}

function bindPinButtons(root = document) {
  root.querySelectorAll("[data-pin]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await toggleClaimPin(btn.dataset.pin, btn.dataset.repo);
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

function pinButtonHtml(c) {
  const isPinned = Number(c.pinned || 0) > 0;
  return `<button type="button" class="claim-pin ${isPinned ? "on" : ""}" data-pin="${esc(c.id)}" data-repo="${esc(c.repo_id || "")}" title="${isPinned ? "Unpin — stop boosting this fact" : "Pin — boost this fact in retrieval"}" aria-label="${isPinned ? "Unpin fact" : "Pin fact"}">${isPinned ? "★ Pinned" : "☆ Pin"}</button>`;
}

function showBrainOverview() {
  const drawer = $("#drawer");
  if (!drawer) return;
  const g = state.graph || {};
  const durable = (g.claims || []).filter((c) => !isSessionClaim(c)).length;
  const chats = (g.claims || []).filter(isSessionClaim).length;
  const title = state.brainAll
    ? "All memory"
    : state.status?.repo?.repo_name || "Memory";
  drawer.innerHTML = `
    <h2>${esc(title)}</h2>
    <div class="meta">Local memory map</div>
    <p><b>To pin:</b> stay on <b>Files</b>, find a fact in the list (top of the main panel), click <b>☆ Pin</b> on the right of that row.</p>
    <p>The map below shows files amem can inject. Bigger tiles have more facts. Teal = used in a recent query.</p>
    <div class="meta">${durable} durable facts · ${chats} chat takeaways · ${g.flows?.length ?? 0} flows · ${g.components?.length ?? 0} components</div>`;
}

function showPinRulesCta(claim) {
  const drawer = $("#drawer");
  if (!drawer || drawer.querySelector("#pinRulesCta")) return;
  const preview = String(claim?.text || "").slice(0, 160);
  const box = document.createElement("div");
  box.id = "pinRulesCta";
  box.className = "pin-rules-cta";
  box.innerHTML = `
    <strong>Sync pinned → Cursor rules (Pro)</strong>
    <p class="note" style="margin:0.35rem 0">Would write a line like: <code>${esc(preview)}${preview.length >= 160 ? "…" : ""}</code> into <code>.cursor/rules/amem-pinned.mdc</code></p>
    <button class="btn small" type="button" id="pinRulesSyncNow">Sync pinned rules</button>`;
  drawer.appendChild(box);
  $("#pinRulesSyncNow")?.addEventListener("click", async () => {
    try {
      const result = await api("/api/rules/sync", { method: "POST", body: "{}" });
      markProOnboardDone(["rules"]);
      box.innerHTML = `<p class="note">Wrote ${esc(result.path || "rules")} (${result.pinned || 0} pinned).</p>`;
    } catch (e) {
      box.innerHTML = `<p class="note">${esc(e?.message || String(e))}</p>`;
    }
  });
}

function showBrainDetail(node) {
  const drawer = $("#drawer");
  if (!drawer) return;
  const d = node.detail || {};
  if (node.type === "event") {
    const kind = eventKindOf(d);
    const ids = eventClaimIds(d);
    const claims = ids
      .map((id) => (state.graph.claims || []).find((c) => c.id === id))
      .filter(Boolean);
    drawer.innerHTML = `
      <h2>${kind === "local_hit" ? "Local hit" : "Had to explore"}</h2>
      <div class="meta">${esc(d.platform || "agent")} · ${esc(formatWhen(d.created_at))}</div>
      <p>${esc(eventQueryLabel(d))}</p>
      <div class="meta">${kind === "local_hit" ? `Injected ${claims.length} fact(s) · ~${formatTokens(d.estimated_tokens_saved)} tokens estimated avoided` : "amem returned nothing useful, so Cursor likely grepped or read files."}</div>
      ${
        claims.length
          ? `<ul class="detail-list detail-list-pin">${claims
              .map(
                (c) =>
                  `<li><div class="detail-pin-row"><strong>${esc(claimPreview(c, 90))}</strong>${pinButtonHtml(c)}</div><div class="meta">${claimAnchors(c).map((a) => `<code>${esc(a)}</code>`).join(" ") || ""}</div></li>`,
              )
              .join("")}</ul>`
          : ""
      }`;
    bindPinButtons(drawer);
    return;
  }
  if (node.type === "memory") {
    const items = node.detail?.items || [];
    const byFile = new Map();
    for (const c of items) {
      const file = claimAnchors(c)[0] || "(no file yet)";
      const key = fileGroupKey(c, file);
      const entry = byFile.get(key) || { label: fileLabel(file), path: file, n: 0 };
      entry.n += 1;
      byFile.set(key, entry);
    }
    const files = [...byFile.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12);
    const pinned = items.filter((c) => Number(c.pinned || 0) > 0).length;
    drawer.innerHTML = `
      <h2>${esc(orbitMemoryLabel(node.id))}</h2>
      <div class="meta">${items.length} fact${items.length === 1 ? "" : "s"} · ${pinned} pinned</div>
      <p>Click a dot on the outer ring to open one of these files. Switch the sidebar to this memory to work on it alone.</p>
      ${
        files.length
          ? `<ul class="detail-list">${files
              .map(
                ([key, f]) =>
                  `<li><button type="button" class="link-row" data-orbit-file="${esc(key)}"><strong>${esc(f.label)}</strong></button><div class="meta">${f.n} fact${f.n === 1 ? "" : "s"} · <code>${esc(f.path)}</code></div></li>`,
              )
              .join("")}</ul>`
          : `<p class="note">No anchored files in this memory yet.</p>`
      }`;
    drawer.querySelectorAll("[data-orbit-file]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const file = btn.dataset.orbitFile;
        state.selectedFile = file;
        const group = coverageGroups().find((g) => g.file === file);
        state.selectedNode = { type: "file", id: file, detail: group || { file, items: [] } };
        showBrainDetail(state.selectedNode);
      });
    });
    return;
  }
  if (node.type === "file") {
    const group = node.detail || coverageGroups().find((g) => g.file === node.id);
    const items = group?.items || [];
    drawer.innerHTML = `
      <h2>${esc(fileLabel(node.id))}</h2>
      <div class="meta"><code>${esc(node.id)}</code> · ${items.length} fact${items.length === 1 ? "" : "s"}</div>
      <p>Pin any fact here to boost it in retrieval. Teal on the map means a recent query already used one of them.</p>
      ${
        items.length
          ? `<ul class="detail-list detail-list-pin">${items
              .map(
                (c) =>
                  `<li><div class="detail-pin-row"><strong>${esc(claimPreview(c, 90))}</strong>${pinButtonHtml(c)}</div><div class="meta">${esc(c.kind || "fact")}</div></li>`,
              )
              .join("")}</ul>`
          : ""
      }`;
    bindPinButtons(drawer);
    return;
  }
  if (node.type === "draft") {
    let proposal = {};
    try {
      proposal = JSON.parse(d.proposal_json || "{}");
    } catch {
      proposal = {};
    }
    const claims = Array.isArray(proposal.claims) ? proposal.claims : [];
    const conflicts = Array.isArray(d.conflicts) ? d.conflicts : [];
    const quality = d.quality;
    drawer.innerHTML = `
      <h2>Pending draft</h2>
      <div class="meta">${esc(memoryLabel(d.repo_id))} · ${esc(d.platform || "agent")} · ${esc(formatWhen(d.created_at))} · ${esc(d.source || "session-end")}${quality ? ` · ${esc(quality.label)} ${quality.score}` : ""}</div>
      <p>${esc(d.title || d.id)}</p>
      ${quality?.reasons?.length ? `<p class="note">${quality.reasons.map((r) => esc(r)).join(" · ")}</p>` : ""}
      ${
        claims.length
          ? `<ul class="detail-list">${claims
              .map(
                (c) =>
                  `<li><strong>${esc((c.text || "").slice(0, 160))}</strong><div class="meta">${esc(c.kind || "fact")} · ${(c.code_anchors || []).map((a) => `<code>${esc(a)}</code>`).join(" ")}</div></li>`,
              )
              .join("")}</ul>`
          : `<p class="note">Empty proposal</p>`
      }
      ${
        conflicts.length
          ? `<div class="conflict-box"><strong>May replace older facts</strong>${conflicts
              .map(
                (c) =>
                  `<p class="note"><code>${esc(c.otherId)}</code> (${Math.round((c.similarity || 0) * 100)}% similar)${c.otherText ? ` — ${esc(c.otherText.slice(0, 120))}` : ""}</p>`,
              )
              .join("")}</div>`
          : ""
      }
      <div class="drawer-actions">
        ${conflicts.length ? `<button class="btn" type="button" id="draftSupersede">Apply and replace older</button>` : ""}
        <button class="btn ${conflicts.length ? "secondary" : ""}" type="button" id="draftApply">Apply ${conflicts.length ? "anyway" : "to memory"}</button>
        <button class="btn secondary" type="button" id="draftDismiss">Dismiss</button>
      </div>`;
    const applyDraft = async (resolve) => {
      try {
        await api("/api/drafts/apply", {
          method: "POST",
          repoId: d.repo_id,
          body: JSON.stringify({ id: d.id, resolve, scope: state.brainAll ? "all" : undefined }),
        });
        state.selectedNode = null;
        await refreshGraph();
        renderBrain();
      } catch (err) {
        alert(err.message);
      }
    };
    $("#draftApply")?.addEventListener("click", () => applyDraft(conflicts.length ? "keep" : undefined));
    $("#draftSupersede")?.addEventListener("click", () => applyDraft("supersede"));
    $("#draftDismiss")?.addEventListener("click", async () => {
      try {
        await api("/api/drafts/dismiss", {
          method: "POST",
          repoId: d.repo_id,
          body: JSON.stringify({ id: d.id, scope: state.brainAll ? "all" : undefined }),
        });
        state.selectedNode = null;
        await refreshGraph();
        renderBrain();
      } catch (err) {
        alert(err.message);
      }
    });
    return;
  }
  if (node.type === "claim") {
    const anchors = claimAnchors(d);
    const rel = relatedForClaim(d.id);
    const pinned = Number(d.pinned || 0) > 0;
    drawer.innerHTML = `
      <h2>${esc(d.kind || "fact")}${pinned ? " · pinned" : ""}</h2>
      <div class="meta">${esc(memoryLabel(d.repo_id))} · ${esc(d.id)}</div>
      <label class="drawer-label">Text</label>
      <textarea id="claimText" rows="6">${esc(d.text || "")}</textarea>
      <label class="drawer-label">Kind</label>
      <input id="claimKind" type="text" value="${esc(d.kind || "")}" />
      <label class="drawer-label">Anchors (comma-separated)</label>
      <input id="claimAnchors" type="text" value="${esc(anchors.join(", "))}" />
      <div class="drawer-actions">
        <button class="btn" type="button" id="claimSave">Save</button>
        <button class="btn secondary" type="button" id="claimPin">${pinned ? "Unpin ★" : "Pin ★"}</button>
        <button class="btn secondary" type="button" id="claimClose">Close</button>
        <button class="btn secondary danger" type="button" id="claimDelete">Delete</button>
      </div>
      ${rel.flows.length ? `<div class="meta">Flows: ${rel.flows.map((f) => esc(f.name)).join(", ")}</div>` : ""}
      ${rel.components.length ? `<div class="meta">Components: ${rel.components.map((c) => esc(c.name)).join(", ")}</div>` : ""}
      <p class="note" style="margin:0"><b>Pin</b> boosts this fact in <code>amem context</code>. Use the Pin button on each row, or here. Pinned facts appear under the Pinned filter and can sync to Cursor rules (Pro).</p>`;
    $("#claimSave")?.addEventListener("click", async () => {
      try {
        const text = $("#claimText")?.value ?? "";
        const kind = $("#claimKind")?.value ?? "";
        const anchorsRaw = $("#claimAnchors")?.value ?? "";
        const code_anchors = anchorsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const result = await api("/api/claims", {
          method: "PATCH",
          repoId: d.repo_id,
          body: JSON.stringify({ id: d.id, text, kind, code_anchors }),
        });
        state.selectedNode = { type: "claim", id: d.id, detail: result.claim };
        await refreshGraph();
        paintBrain();
      } catch (err) {
        alert(err.message);
      }
    });
    $("#claimPin")?.addEventListener("click", async () => {
      try {
        const nextPinned = !pinned;
        const result = await api("/api/claims/pin", {
          method: "POST",
          repoId: d.repo_id,
          body: JSON.stringify({ id: d.id, pinned: nextPinned }),
        });
        state.selectedNode = { type: "claim", id: d.id, detail: result.claim };
        await refreshGraph();
        paintBrain();
        if (nextPinned && state.license?.features?.includes("rules_sync") && !state.brainAll) {
          showPinRulesCta(result.claim);
        }
      } catch (err) {
        alert(err.message);
      }
    });
    $("#claimClose")?.addEventListener("click", () => {
      state.selectedNode = null;
      renderBrain();
    });
    $("#claimDelete")?.addEventListener("click", async () => {
      if (!confirm(`Delete ${d.id} from local memory?`)) return;
      try {
        await api(`/api/claims?id=${encodeURIComponent(d.id)}`, { method: "DELETE", repoId: d.repo_id });
        state.selectedNode = null;
        await refreshGraph();
        renderBrain();
      } catch (err) {
        alert(err.message);
      }
    });
    return;
  }
  showBrainOverview();
}

function formatTokens(n) {
  return Number(n || 0).toLocaleString();
}

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  if (n < 3600000) return `${(n / 60000).toFixed(1)}m`;
  return `${(n / 3600000).toFixed(1)}h`;
}

function formatPct(n) {
  if (!Number.isFinite(Number(n))) return "—";
  return `${Math.round(Number(n) * 100)}%`;
}

function formatUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return "$0";
  // Savings can be negative now (a packet that returned little still cost
  // input tokens). Rendering that as "$0" would hide exactly the case worth
  // seeing, so show the sign.
  const sign = v < 0 ? "-" : "~";
  const abs = Math.abs(v);
  if (abs < 0.01) return `${sign}$${abs.toFixed(3)}`;
  return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * How much to trust the savings figures. Until a real reported saving exists
 * these are model output, and the UI should say so rather than implying the
 * number was measured.
 */
function savingsCaveat(agg) {
  const p = agg?.pricing;
  if (p?.calibrated) return "calibrated against reported savings";
  const perFile = p?.assumedTokensPerFile ?? 4000;
  return `modelled, never calibrated · assumes ${formatTokens(perFile)} tok per file avoided`;
}

function formatChartDay(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderStats() {
  return renderAnalytics();
}

const TASK_COLS = [
  { id: "backlog", label: "Backlog" },
  { id: "next", label: "Next" },
  { id: "doing", label: "Doing" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
];

async function refreshTasks() {
  const scopeQuery = state.brainAll ? "?scope=all&include_done=1" : "?include_done=1";
  const data = state.brainAll
    ? await apiUnscoped(`/api/tasks${scopeQuery}`)
    : await api(`/api/tasks${scopeQuery}`);
  state.tasks = data.tasks || [];
  state.taskCounts = data.counts || {};
  return data;
}

/** Skills are a global library, so this never uses the repo-scoped api() helper. */
async function refreshSkills() {
  const [list, drafts] = await Promise.all([
    apiUnscoped("/api/skills"),
    apiUnscoped("/api/skills/drafts"),
  ]);
  state.skills = list.skills || [];
  state.skillsDir = list.dir || "";
  state.skillDrafts = drafts.drafts || [];
  return list;
}

function skillCardHtml(s) {
  const desc = s.description
    ? `<p class="skill-card-desc">${esc(String(s.description).slice(0, 200))}</p>`
    : `<p class="skill-card-desc muted">No description — agents rank on this, so add one.</p>`;
  const tags = (s.tags || [])
    .slice(0, 4)
    .map((t) => `<span class="skill-tag">${esc(t)}</span>`)
    .join("");
  const uses = s.uses > 0 ? `<span class="skill-uses">used ${s.uses}×</span>` : "";
  return `
    <article class="skill-card" data-name="${esc(s.name)}">
      <header class="skill-card-head">
        <h3>${esc(s.name)}</h3>
        ${uses}
      </header>
      ${desc}
      <div class="skill-card-tags">${tags}</div>
      <div class="skill-card-actions">
        <button type="button" class="btn secondary small skill-view">View</button>
        <button type="button" class="btn secondary small skill-del" title="Delete">✕</button>
      </div>
    </article>`;
}

function skillDraftHtml(d) {
  const why = (d.reasons || []).length
    ? `<p class="skill-draft-why">${esc(d.reasons.join(" · "))}</p>`
    : "";
  const label =
    d.kind === "revision"
      ? `Revise <strong>${esc(d.target_skill || "")}</strong>`
      : d.kind === "create"
        ? "Staged for review"
        : "Suggested";
  // A suggestion has no body yet: only an agent can write one, so do not offer Approve.
  const approve = d.has_content
    ? `<button type="button" class="btn small skill-draft-apply">Approve</button>`
    : "";
  const hint = d.has_content
    ? ""
    : `<p class="skill-draft-hint">Ask your agent to write this up — it will see the nudge in its next context packet.</p>`;
  return `
    <article class="skill-draft" data-id="${esc(d.id)}">
      <span class="skill-draft-kind">${label}</span>
      <h4>${esc(d.title)}</h4>
      ${why}
      ${hint}
      <div class="skill-draft-actions">
        ${approve}
        <button type="button" class="btn secondary small skill-draft-dismiss">Dismiss</button>
      </div>
    </article>`;
}

function renderSkills() {
  const main = $("#main");
  setMainMode("page");
  stopAllViz();

  const skills = state.skills || [];
  const drafts = state.skillDrafts || [];
  const draftsHtml = drafts.length
    ? `<section class="skill-drafts">
         <h2>Pending (${drafts.length})</h2>
         <p class="note">Procedures amem noticed, or agent writes waiting on approval.</p>
         <div class="skill-draft-list">${drafts.map(skillDraftHtml).join("")}</div>
       </section>`
    : "";

  const listHtml = skills.length
    ? `<div class="skill-grid">${skills.map(skillCardHtml).join("")}</div>`
    : `<div class="skill-empty">
         <h2>No skills yet</h2>
         <p>Skills are procedures agents load only when relevant — longer than a memory fact, and kept out of every prompt until needed.</p>
         <p class="note">Create one with <code>amem skills new &lt;name&gt;</code>, or let an agent save one with <code>amem_skill_save</code> after it solves something worth repeating.</p>
       </div>`;

  main.innerHTML = `
    <section class="dash-page">
      <header class="dash-head">
        <div>
          <h1>Skills</h1>
          <p class="sub">Procedural memory — ${skills.length} skill(s) agents can load on demand. Facts live in Memory.</p>
        </div>
        <div class="dash-actions">
          <button class="btn secondary small" type="button" data-go="brain">Open Memory</button>
          <button class="btn secondary small" type="button" data-go="tasks">Tasks</button>
        </div>
      </header>
      <p class="note">Stored in <code>${esc(state.skillsDir || "~/.amem/skills")}</code> · agents see names and descriptions only until they load one</p>
      ${draftsHtml}
      ${listHtml}
      <div class="skill-detail" id="skillDetail" hidden></div>
    </section>`;

  renderPageInsight();

  main.querySelectorAll("[data-go]").forEach((b) => {
    b.addEventListener("click", () => {
      const tab = b.getAttribute("data-go");
      if (tab) setTab(tab);
    });
  });

  main.querySelectorAll(".skill-view").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.closest(".skill-card")?.getAttribute("data-name");
      if (!name) return;
      try {
        const data = await apiUnscoped(`/api/skills/view?name=${encodeURIComponent(name)}`);
        const host = $("#skillDetail");
        host.hidden = false;
        host.innerHTML = `
          <header class="skill-detail-head">
            <h2>${esc(data.name)}</h2>
            <button type="button" class="btn secondary small" id="skillDetailClose">Close</button>
          </header>
          <pre class="skill-detail-body">${esc(data.content || "")}</pre>`;
        $("#skillDetailClose")?.addEventListener("click", () => {
          host.hidden = true;
          host.innerHTML = "";
        });
        host.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch (e) {
        alert(e.message || e);
      }
    });
  });

  main.querySelectorAll(".skill-del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.closest(".skill-card")?.getAttribute("data-name");
      if (!name || !confirm(`Delete skill "${name}"? This removes the file from disk.`)) return;
      try {
        await apiUnscoped(`/api/skills?name=${encodeURIComponent(name)}`, { method: "DELETE" });
        await refreshSkills();
        renderSkills();
      } catch (e) {
        alert(e.message || e);
      }
    });
  });

  const draftAction = async (btn, path) => {
    const id = btn.closest(".skill-draft")?.getAttribute("data-id");
    if (!id) return;
    try {
      await apiUnscoped(path, { method: "POST", body: JSON.stringify({ id }) });
      await refreshSkills();
      renderSkills();
    } catch (e) {
      alert(e.message || e);
    }
  };
  main.querySelectorAll(".skill-draft-apply").forEach((btn) => {
    btn.addEventListener("click", () => draftAction(btn, "/api/skills/drafts/apply"));
  });
  main.querySelectorAll(".skill-draft-dismiss").forEach((btn) => {
    btn.addEventListener("click", () => draftAction(btn, "/api/skills/drafts/dismiss"));
  });
}

/** Where a task created from this board will be filed. */
function currentRepoLabel() {
  const repo = state.status?.repo || matchBoundRepo();
  return repo?.repo_name || "this folder";
}

function taskCardHtml(t) {
  const body = t.body ? `<p class="tasks-card-body">${esc(String(t.body).slice(0, 160))}</p>` : "";
  const opts = TASK_COLS.map(
    (c) => `<option value="${c.id}" ${c.id === t.status ? "selected" : ""}>${esc(c.label)}</option>`,
  ).join("");
  // Across memories a bare title is ambiguous — say which memory the task came from.
  const owner =
    state.brainAll && t.repo_name
      ? `<span class="tasks-card-repo" title="Memory this task belongs to">${esc(t.repo_name)}</span>`
      : "";
  return `
    <article class="tasks-card" data-id="${esc(t.id)}" draggable="true">
      ${owner}
      <h3>${esc(t.title)}</h3>
      ${body}
      <div class="tasks-card-actions">
        <select class="tasks-status" aria-label="Move status">${opts}</select>
        <button type="button" class="btn secondary small tasks-del" title="Delete">✕</button>
      </div>
    </article>`;
}

function renderTasks() {
  const main = $("#main");
  setMainMode("page");
  stopAllViz();
  renderPageInsight();
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const focus = statsFocusLabel();
  const openCount = Number(state.taskCounts?.open ?? tasks.filter((t) => t.status !== "done").length);
  const byStatus = Object.fromEntries(TASK_COLS.map((c) => [c.id, []]));
  for (const t of tasks) {
    if (byStatus[t.status]) byStatus[t.status].push(t);
    else byStatus.backlog.push(t);
  }
  // Done: keep last 12
  byStatus.done = byStatus.done.slice(0, 12);

  main.innerHTML = `
    <section class="dash-page">
      <header class="dash-head">
        <div>
          <h1>Tasks</h1>
          <p class="sub">Deferred work for <strong>${esc(focus)}</strong> — agents park items here so they do not die in chat. Facts still live in Memory.</p>
        </div>
        <div class="dash-actions">
          <button class="btn secondary small" type="button" id="tasksScope">${
            state.brainAll ? "Show this folder only" : "Show all memory"
          }</button>
          <button class="btn secondary small" type="button" data-go="brain">Open Memory</button>
          <button class="btn secondary small" type="button" data-go="dashboard">Dashboard</button>
        </div>
      </header>
      <p class="note">${openCount} open · use MCP <code>amem_task_add</code> / <code>amem_task_update</code> or the form below${
        state.brainAll ? ` · new tasks land in <strong>${esc(currentRepoLabel())}</strong>` : ""
      }</p>
      <form class="tasks-add" id="tasksAddForm">
        <input id="tasksTitle" type="text" placeholder="New task title" maxlength="200" required autocomplete="off"/>
        <input id="tasksBody" type="text" placeholder="Why / notes (optional)" maxlength="400" autocomplete="off"/>
        <button class="btn" type="submit">Add to backlog</button>
      </form>
      <div class="tasks-board" id="tasksBoard">
        ${TASK_COLS.map((col) => {
          const list = byStatus[col.id] || [];
          return `
            <section class="tasks-col" data-status="${col.id}">
              <header><h2>${esc(col.label)}</h2><span>${list.length}</span></header>
              <div class="tasks-col-body">${list.map(taskCardHtml).join("") || `<p class="tasks-empty">Empty</p>`}</div>
            </section>`;
        }).join("")}
      </div>
    </section>`;

  main.querySelectorAll("[data-go]").forEach((b) => {
    b.addEventListener("click", () => {
      const tab = b.getAttribute("data-go");
      if (tab) setTab(tab);
    });
  });

  $("#tasksScope")?.addEventListener("click", async () => {
    state.brainAll = !state.brainAll;
    persistBrainAll(state.brainAll);
    writeUrlState();
    try {
      await refreshTasks();
    } catch (err) {
      alert(err.message || err);
    }
    renderTasks();
  });

  $("#tasksAddForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#tasksTitle")?.value?.trim();
    if (!title) return;
    const body = $("#tasksBody")?.value?.trim() || "";
    try {
      const bound = state.status?.repo || matchBoundRepo();
      const repoId = bound?.id || state.repoId || undefined;
      await api("/api/tasks", {
        method: "POST",
        repoId,
        body: JSON.stringify({ title, body, status: "backlog", source: "ui" }),
      });
      const titleInput = $("#tasksTitle");
      const bodyInput = $("#tasksBody");
      if (titleInput) titleInput.value = "";
      if (bodyInput) bodyInput.value = "";
      await refreshTasks();
      renderTasks();
    } catch (err) {
      alert(err.message || err);
    }
  });

  main.querySelectorAll(".tasks-card").forEach((card) => {
    const id = card.getAttribute("data-id");
    card.querySelector(".tasks-status")?.addEventListener("change", async (ev) => {
      const status = ev.target.value;
      try {
        const url = state.brainAll ? "/api/tasks?scope=all" : "/api/tasks";
        await (state.brainAll ? apiUnscoped : api)(url, {
          method: "PATCH",
          body: JSON.stringify({ id, status, scope: state.brainAll ? "all" : undefined }),
        });
        await refreshTasks();
        renderTasks();
      } catch (err) {
        alert(err.message || err);
      }
    });
    card.querySelector(".tasks-del")?.addEventListener("click", async () => {
      if (!confirm("Delete this task?")) return;
      try {
        const url = state.brainAll
          ? `/api/tasks?scope=all&id=${encodeURIComponent(id)}`
          : `/api/tasks?id=${encodeURIComponent(id)}`;
        await (state.brainAll ? apiUnscoped : api)(url, { method: "DELETE" });
        await refreshTasks();
        renderTasks();
      } catch (err) {
        alert(err.message || err);
      }
    });
    card.addEventListener("dragstart", (ev) => {
      ev.dataTransfer.setData("text/task-id", id);
      ev.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });

  main.querySelectorAll(".tasks-col").forEach((col) => {
    const status = col.getAttribute("data-status");
    col.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      col.classList.remove("drag-over");
      const id = ev.dataTransfer.getData("text/task-id");
      if (!id || !status) return;
      try {
        const url = state.brainAll ? "/api/tasks?scope=all" : "/api/tasks";
        await (state.brainAll ? apiUnscoped : api)(url, {
          method: "PATCH",
          body: JSON.stringify({ id, status, scope: state.brainAll ? "all" : undefined }),
        });
        await refreshTasks();
        renderTasks();
      } catch (err) {
        alert(err.message || err);
      }
    });
  });
}

function renderDashboard() {
  const main = $("#main");
  setMainMode("page");
  stopAllViz();
  const g = state.graph || emptyGraph(state.brainAll ? "all" : "current");
  const agg = state.usage?.aggregate;
  const totals = agg?.totals || {};
  const drafts = (g.drafts || []).filter((d) => d.status === "pending");
  const pendingTotal = Number(g.pendingDraftTotal ?? drafts.length);
  const claims = g.claims || [];
  const pinned = claims.filter((c) => Number(c.pinned || 0) > 0).length;
  const events = g.recentEvents || [];
  const hits = events.filter((e) => eventKindOf(e) === "local_hit");
  const misses = events.filter((e) => eventKindOf(e) !== "local_hit");
  const focus = statsFocusLabel();
  const tier = state.license?.tier || "free";
  const highDrafts = drafts.filter((d) => d.quality?.label === "high").length;
  const junkDrafts = drafts.filter((d) => d.quality?.reject || d.quality?.label === "low").length;
  const topFiles = fileGroups(claims)
    .slice()
    .sort((a, b) => b.items.length - a.items.length)
    .slice(0, 6);

  renderPageInsight();
  main.innerHTML = `
    <section class="dash-page">
      <header class="dash-head">
        <div>
          <h1>Dashboard</h1>
          <p class="sub">What matters right now for <strong>${esc(focus)}</strong>. Memory stays on this machine.</p>
        </div>
        <div class="dash-actions">
          <button class="btn secondary small" type="button" data-go="brain">Open Memory</button>
          <button class="btn secondary small" type="button" data-go="tasks">Open Tasks</button>
          <button class="btn secondary small" type="button" data-go="analytics">Open Analytics</button>
        </div>
      </header>

      <div class="dash-kpis">
        <button type="button" class="dash-kpi" data-go="brain" data-filter="files">
          <b>${claims.length}</b><span>Facts stored</span>
        </button>
        <button type="button" class="dash-kpi ${pendingTotal ? "warn" : ""}" data-go="brain" data-filter="drafts">
          <b>${pendingTotal}</b><span>Waiting to approve</span>
        </button>
        <button type="button" class="dash-kpi" data-go="brain" data-filter="pinned">
          <b>${pinned}</b><span>Pinned</span>
        </button>
        <button type="button" class="dash-kpi" data-go="analytics">
          <b>${formatPct(totals.hitRate)}</b><span>Hit rate · ${totals.localHits ?? 0} hits</span>
        </button>
        <div class="dash-kpi static">
          <b>${esc(String(tier))}</b><span>License</span>
        </div>
        <div class="dash-kpi static">
          <b>${formatUsd(totals.estimatedUsdSaved)}</b><span>Est. $ saved · ${esc(savingsCaveat(agg))}</span>
        </div>
      </div>

      <div class="dash-grid">
        <article class="dash-panel">
          <h2>Needs attention</h2>
          ${
            pendingTotal
              ? `<p>${pendingTotal} session capture${pendingTotal === 1 ? "" : "s"} waiting · ${highDrafts} high · ${junkDrafts} junk.</p>
                 <div class="drawer-actions">
                   <button class="btn small" type="button" data-go="brain" data-filter="drafts">Review Approve queue</button>
                 </div>`
              : `<p class="note">No pending captures. New session-end drafts will show up here.</p>`
          }
          ${
            misses.length
              ? `<h3>Recent misses</h3><ul class="dash-list">${misses
                  .slice(0, 5)
                  .map(
                    (e) =>
                      `<li><strong>${esc(eventQueryLabel(e))}</strong><span class="meta">${esc(e.platform || "agent")} · ${esc(formatWhen(e.created_at))}</span></li>`,
                  )
                  .join("")}</ul>`
              : `<p class="note">No recent misses in the feed.</p>`
          }
        </article>
        <article class="dash-panel">
          <h2>Working well</h2>
          <p>${hits.length} local hit${hits.length === 1 ? "" : "s"} in recent uses · ~${formatTokens(totals.estimatedTokensSaved ?? 0)} tokens estimated avoided (${state.usage?.days ?? 30}d).</p>
          ${
            hits.length
              ? `<ul class="dash-list">${hits
                  .slice(0, 5)
                  .map(
                    (e) =>
                      `<li><strong>${esc(eventQueryLabel(e))}</strong><span class="meta">${eventClaimIds(e).length} facts · ${esc(formatWhen(e.created_at))}</span></li>`,
                  )
                  .join("")}</ul>`
              : `<p class="note">Ask Cursor something in a tracked repo — hits appear after <code>amem context</code> runs.</p>`
          }
        </article>
        <article class="dash-panel">
          <h2>Densest files</h2>
          ${
            topFiles.length
              ? `<ul class="dash-list">${topFiles
                  .map(
                    (f) =>
                      `<li><button type="button" class="linkish" data-file="${esc(f.file)}"><code>${esc(fileLabel(f.file))}</code></button><span class="meta">${f.items.length} fact${f.items.length === 1 ? "" : "s"}</span></li>`,
                  )
                  .join("")}</ul>`
              : `<p class="note">No facts yet.</p>`
          }
          <div class="drawer-actions">
            <button class="btn secondary small" type="button" data-go="brain" data-viz="orbit">View as Orbit</button>
            <button class="btn secondary small" type="button" data-go="brain" data-filter="pinned">Pinned facts</button>
          </div>
        </article>
      </div>
    </section>`;

  main.querySelectorAll("[data-go]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.go;
      if (btn.dataset.filter) state.brainFilter = btn.dataset.filter;
      if (btn.dataset.viz) {
        setMemoryViz(btn.dataset.viz);
      }
      setTab(tab);
    });
  });
  main.querySelectorAll("[data-file]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selectedFile = btn.dataset.file;
      state.brainFilter = "files";
      setTab("brain");
    });
  });
}

function renderAnalytics() {
  const main = $("#main");
  setMainMode("page");
  stopAllViz();
  renderPageInsight();
  if (!state.brainAll && !state.status?.repo) {
    main.innerHTML = `<section class="hero"><div class="hero-inner"><h1>Analytics</h1><p>Pick <strong>All memory</strong> in the header, or a tracked repo, to see usage analytics.</p></div></section>`;
    return;
  }
  const agg = state.usage?.aggregate;
  const totals = agg?.totals || {};
  const currentDays = String(state.usage?.days ?? state.statsDays ?? 30);
  const focus = statsFocusLabel();
  const byDay = agg?.byDay || [];
  const g = state.graph || {};
  const claimUse = new Map();
  for (const e of state.usage?.events || g.recentEvents || []) {
    for (const id of eventClaimIds(e)) {
      claimUse.set(id, (claimUse.get(id) || 0) + 1);
    }
  }
  const topClaims = [...claimUse.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id, n]) => {
      const c = (g.claims || []).find((x) => x.id === id);
      return { id, n, text: c ? claimPreview(c, 100) : id };
    });

  main.innerHTML = `
    <section class="stats-page analytics-page">
      <h1>Analytics</h1>
      <p class="sub">Deeper usage for <strong>${esc(focus)}</strong>. Hit rate is local memory success — not Cursor→model API trips. Time and $ are proxies.</p>
      <div class="filters">
        <select id="days" aria-label="Analytics time range">
          <option value="7" ${currentDays === "7" ? "selected" : ""}>7 days</option>
          <option value="30" ${currentDays === "30" ? "selected" : ""}>30 days</option>
          <option value="90" ${currentDays === "90" ? "selected" : ""}>90 days</option>
        </select>
        <button class="btn secondary small" type="button" data-export="json">Export JSON</button>
        <button class="btn secondary small" type="button" data-export="md">Export markdown</button>
        <button class="btn secondary small" type="button" data-export="pdf">Export PDF</button>
      </div>

      <div class="analytics-split">
        <div class="chart-wrap">
          <h2>Hits vs misses by day</h2>
          <div class="chart-stage">
            <canvas id="hitMissChart"></canvas>
          </div>
        </div>
        <div class="chart-wrap">
          <h2>Estimated tokens saved by day</h2>
          <div class="chart-stage">
            <canvas id="savingsChart"></canvas>
            <div class="chart-tooltip hidden" id="chartTooltip"></div>
          </div>
        </div>
      </div>

      <div class="platform-cards" id="speedCards"></div>
      <h2 class="stats-heading">Monthly projection</h2>
      <div class="platform-cards" id="monthlyCards"></div>
      <div class="platform-cards" id="cards"></div>

      <div class="analytics-split">
        <article class="dash-panel">
          <h2>Top injected facts</h2>
          ${
            topClaims.length
              ? `<ul class="dash-list">${topClaims
                  .map(
                    (c) =>
                      `<li><strong>${esc(c.text)}</strong><span class="meta">${c.n}× · <code>${esc(c.id)}</code></span></li>`,
                  )
                  .join("")}</ul>`
              : `<p class="note">No claim injections logged in this window.</p>`
          }
        </article>
        <article class="dash-panel">
          <h2>By platform</h2>
          <ul class="dash-list" id="platformList"></ul>
        </article>
      </div>
      <p class="note">Tokens: max(0, anchors×4000 + claims×200 − packet tokens). Time: anchors×1.2s + claims×80ms. Money: tokens × $${agg?.pricing?.usdPerMillionInputTokens ?? 3}/1M input tokens. “Server trips” = empty amem lookups, not model API calls.</p>
    </section>`;

  const speedCards = $("#speedCards");
  speedCards.innerHTML = `
    <div class="platform-card"><div class="label">Estimated time saved</div><div class="value">~${formatDuration(totals.estimatedMsSaved)}</div><div class="meta">proxy vs tool round-trips · not model latency</div></div>
    <div class="platform-card"><div class="label">Estimated money saved</div><div class="value">${formatUsd(totals.estimatedUsdSaved)}</div><div class="meta">at $${agg?.pricing?.usdPerMillionInputTokens ?? 3}/1M input tokens · ${esc(savingsCaveat(agg))}</div></div>
    <div class="platform-card"><div class="label">Local lookup</div><div class="value">${totals.avgLocalMs != null ? formatDuration(totals.avgLocalMs) : "—"}</div><div class="meta">measured SQLite / localhost avg</div></div>
    <div class="platform-card"><div class="label">Hit rate</div><div class="value">${formatPct(totals.hitRate)}</div><div class="meta">${totals.localHits ?? 0} keyword hits · ${totals.serverTrips ?? 0} misses · not model API calls</div></div>
    <div class="platform-card"><div class="label">Avoided file reads</div><div class="value">${formatTokens(totals.anchorsAvoided ?? 0)}</div><div class="meta">unique anchors returned in packets</div></div>`;

  const monthly = agg?.monthly || {};
  const monthlyCards = $("#monthlyCards");
  const trend = monthly.trendDays || 0;
  monthlyCards.innerHTML = `
    <div class="platform-card accented"><div class="label">Est. tokens / month</div><div class="value">~${formatTokens(monthly.estimatedTokensSaved ?? 0)}</div><div class="meta">${trend ? `from ${monthly.sampleQueries} calls over ${trend} day${trend === 1 ? "" : "s"} × 30` : "no usage yet"} · proxy, not a bill</div></div>
    <div class="platform-card accented"><div class="label">Est. $ / month</div><div class="value">${formatUsd(monthly.estimatedUsdSaved)}</div><div class="meta">same token proxy at $${agg?.pricing?.usdPerMillionInputTokens ?? 3}/1M input · ${esc(savingsCaveat(agg))}</div></div>
    <div class="platform-card accented"><div class="label">Est. time / month</div><div class="value">~${formatDuration(monthly.estimatedMsSaved)}</div><div class="meta">avoided tool round-trips at current pace</div></div>
    <div class="platform-card accented"><div class="label">Est. calls / month</div><div class="value">${formatTokens(monthly.queries ?? 0)}</div><div class="meta">amem context hits if this rate holds</div></div>
    <div class="platform-card accented"><div class="label">Est. file reads / month</div><div class="value">${formatTokens(monthly.anchorsAvoided ?? 0)}</div><div class="meta">anchors that would be skipped</div></div>`;

  const cards = $("#cards");
  const platforms = agg?.byPlatform?.length
    ? agg.byPlatform
    : [{ platform: "—", queries: 0, estimatedTokensSaved: 0, reportedTokensSaved: 0 }];
  cards.innerHTML = `
    <div class="platform-card"><div class="label">Total estimated</div><div class="value">~${formatTokens(agg?.totals?.estimatedTokensSaved ?? 0)}</div><div class="meta">${formatUsd(agg?.totals?.estimatedUsdSaved)} · ${agg?.totals?.queries ?? 0} context queries · proxy, not billed savings</div></div>
    ${platforms
      .map(
        (p) => `<div class="platform-card"><div class="label">${p.platform}</div><div class="value">~${formatTokens(p.estimatedTokensSaved)}</div><div class="meta">${p.queries} ${p.queries === 1 ? "query" : "queries"} · ~${formatDuration(p.estimatedMsSaved)}${p.avgLocalMs != null ? ` · ${formatDuration(p.avgLocalMs)} local` : ""}${p.reportedTokensSaved ? ` · reported ${formatTokens(p.reportedTokensSaved)}` : ""}</div></div>`,
      )
      .join("")}`;

  const platformList = $("#platformList");
  if (platformList) {
    platformList.innerHTML = platforms
      .map(
        (p) =>
          `<li><strong>${esc(p.platform)}</strong><span class="meta">${p.queries} queries · hit-ish savings ~${formatTokens(p.estimatedTokensSaved)} · ${formatUsd(p.estimatedUsdSaved)}</span></li>`,
      )
      .join("");
  }

  drawChart(byDay);
  drawHitMissChart(byDay);

  $("#days").addEventListener("change", async (e) => {
    await refreshUsage(statsScope(), Number(e.target.value));
    renderAnalytics();
  });
  main.querySelectorAll("[data-export]").forEach((btn) => {
    btn.addEventListener("click", () => downloadSavings(btn.dataset.export));
  });
}

function drawHitMissChart(days) {
  const canvas = $("#hitMissChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!days.length) {
    ctx.fillStyle = "#8fa3b0";
    ctx.fillText("No usage yet.", 16, 32);
    return;
  }
  const max = Math.max(...days.map((d) => (d.localHits || 0) + (d.serverTrips || 0)), 1);
  const pad = 36;
  const bw = (w - pad * 2) / days.length;
  days.forEach((d, i) => {
    const hits = d.localHits || 0;
    const misses = d.serverTrips || 0;
    const x = pad + i * bw + 4;
    const barW = Math.max(bw - 8, 2);
    const hitH = ((h - pad * 2) * hits) / max;
    const missH = ((h - pad * 2) * misses) / max;
    ctx.fillStyle = "#2ec4b6";
    ctx.fillRect(x, h - pad - hitH, barW, Math.max(hitH, hits ? 1 : 0));
    ctx.fillStyle = "rgba(232, 140, 90, 0.85)";
    ctx.fillRect(x, h - pad - hitH - missH, barW, Math.max(missH, misses ? 1 : 0));
  });
  ctx.fillStyle = "#8fa3b0";
  ctx.font = "12px 'IBM Plex Sans', system-ui, sans-serif";
  ctx.fillText("teal = hits · orange = misses", pad, 18);
}

async function downloadSavings(format) {
  const scope = statsScope();
  const days = $("#days")?.value || "30";
  try {
    const data = await api(`/api/usage/export?format=${encodeURIComponent(format)}&scope=${encodeURIComponent(scope)}&days=${encodeURIComponent(days)}`);
    let blob;
    if (data.contentBase64) {
      const raw = atob(data.contentBase64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      blob = new Blob([bytes], { type: data.mime || "application/pdf" });
    } else if (data.markdown) {
      blob = new Blob([data.markdown], { type: "text/markdown;charset=utf-8" });
    } else {
      blob = new Blob([JSON.stringify(data.report ?? data, null, 2)], {
        type: "application/json;charset=utf-8",
      });
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = data.filename || `amem-savings.${format}`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    alert(e.message);
  }
}

function drawChart(days) {
  const canvas = $("#savingsChart");
  const tooltip = $("#chartTooltip");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (!days.length) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#8fa3b0";
    ctx.fillText("No usage yet — run amem context from an agent.", 16, 32);
    canvas.onmousemove = null;
    canvas.onmouseleave = null;
    tooltip?.classList.add("hidden");
    return;
  }

  const max = Math.max(...days.map((d) => d.estimatedTokensSaved), 1);
  const pad = 36;
  const bw = (w - pad * 2) / days.length;
  const bars = days.map((d, i) => {
    const barW = Math.max(bw - 8, 2);
    const bh = ((h - pad * 2) * d.estimatedTokensSaved) / max;
    return {
      ...d,
      x: pad + i * bw + 4,
      y: h - pad - bh,
      w: barW,
      h: bh,
      colX: pad + i * bw,
      colW: bw,
    };
  });

  function paint(hoverIndex = -1) {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(232,238,242,0.12)";
    ctx.beginPath();
    ctx.moveTo(pad, pad);
    ctx.lineTo(pad, h - pad);
    ctx.lineTo(w - pad, h - pad);
    ctx.stroke();
    bars.forEach((b, i) => {
      ctx.fillStyle = i === hoverIndex ? "#5ee0d4" : "#2ec4b6";
      ctx.fillRect(b.x, b.y, b.w, Math.max(b.h, 1));
      if (i === hoverIndex) {
        ctx.fillStyle = "#e8eef2";
        ctx.font = "600 12px 'IBM Plex Sans', system-ui, sans-serif";
        ctx.textAlign = "center";
        const label = `~${formatTokens(b.estimatedTokensSaved)}`;
        ctx.fillText(label, b.x + b.w / 2, Math.max(14, b.y - 8));
      }
    });
  }

  paint();

  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const i = bars.findIndex((b) => x >= b.colX && x < b.colX + b.colW);
    if (i < 0) {
      tooltip?.classList.add("hidden");
      paint(-1);
      canvas.style.cursor = "default";
      return;
    }
    const b = bars[i];
    paint(i);
    canvas.style.cursor = "pointer";
    if (!tooltip) return;
    tooltip.classList.remove("hidden");
    tooltip.innerHTML = `<strong>${formatChartDay(b.day)}</strong><span>~${formatTokens(b.estimatedTokensSaved)} tokens</span><span>${formatUsd(b.estimatedUsdSaved)}</span><span>~${formatDuration(b.estimatedMsSaved)} estimated time</span><span>${b.queries} ${b.queries === 1 ? "query" : "queries"} · ${b.localHits ?? 0} hits · ${b.serverTrips ?? 0} misses</span>`;
    const tipW = tooltip.offsetWidth || 160;
    const left = Math.min(Math.max(8, x + 12), rect.width - tipW - 8);
    const top = Math.max(8, e.clientY - rect.top - (tooltip.offsetHeight || 56) - 10);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };
  canvas.onmouseleave = () => {
    tooltip?.classList.add("hidden");
    paint(-1);
    canvas.style.cursor = "default";
  };
}

let renderSeq = 0;

async function render() {
  const seq = ++renderSeq;
  const stale = () => seq !== renderSeq;
  fillRepoSelect();
  paintVault();
  try {
    await refreshStatus();
  } catch (e) {
    if (stale()) return;
    await refreshVault();
    if (/encrypted|unlock|Passphrase/i.test(String(e.message))) {
      setMainMode("page");
      $("#main").innerHTML = `<section class="hero"><div class="hero-inner"><h1>Locked</h1><p>Unlock from <strong>Lock / backup</strong> in the sidebar to open Memory, Dashboard, and Analytics. Memory never left this machine.</p></div></section>`;
      renderPageInsight();
      return;
    }
    throw e;
  }
  if (stale()) return;
  fillRepoSelect();
  if (state.tab === "welcome") {
    renderWelcome();
  } else if (state.tab === "setup") {
    try {
      await loadScan();
    } catch (e) {
      if (!stale()) alert(e.message);
    }
    if (stale()) return;
    fillRepoSelect();
    renderSetup();
  } else if (state.tab === "brain") {
    await refreshGraph();
    if (stale()) return;
    try {
      renderBrain();
    } catch (e) {
      setMainMode("page");
      $("#main").innerHTML = `<section class="hero"><div class="hero-inner"><h1>Memory</h1><p>${esc(e.message || e)}</p><button class="btn" id="retryBrain" type="button">Try again</button></div></section>`;
      $("#retryBrain")?.addEventListener("click", () => setTab("brain"));
    }
  } else if (state.tab === "dashboard") {
    stopAllViz();
    await Promise.all([
      refreshGraph().catch(() => {
        state.graph = emptyGraph(state.brainAll ? "all" : "current");
      }),
      refreshUsage(statsScope(), state.statsDays || 30).catch(() => {
        state.usage = null;
      }),
    ]);
    if (stale()) return;
    renderDashboard();
  } else if (state.tab === "tasks") {
    stopAllViz();
    try {
      await refreshTasks();
    } catch (e) {
      if (!stale()) {
        setMainMode("page");
        $("#main").innerHTML = `<section class="hero"><div class="hero-inner"><h1>Tasks</h1><p>${esc(e.message || e)}</p></div></section>`;
        renderPageInsight();
      }
      return;
    }
    if (stale()) return;
    renderTasks();
  } else if (state.tab === "skills") {
    stopAllViz();
    try {
      await refreshSkills();
    } catch (e) {
      if (!stale()) {
        setMainMode("page");
        $("#main").innerHTML = `<section class="hero"><div class="hero-inner"><h1>Skills</h1><p>${esc(e.message || e)}</p></div></section>`;
        renderPageInsight();
      }
      return;
    }
    if (stale()) return;
    renderSkills();
  } else {
    stopAllViz();
    if (state.tab === "stats") state.tab = "analytics";
    try {
      await refreshUsage(statsScope(), state.statsDays || 30);
    } catch {
      state.usage = null;
    }
    try {
      await refreshGraph();
    } catch {
      /* analytics can still show usage without graph */
    }
    if (stale()) return;
    renderAnalytics();
  }
}

document.querySelectorAll("#tabs button[data-tab]").forEach((b) => {
  b.addEventListener("click", () => setTab(b.dataset.tab));
});
$("#brandBtn")?.addEventListener("click", () => setTab(isPaidLicense() ? "dashboard" : "welcome"));

$("#brainSearch")?.addEventListener("input", (e) => {
  if (state.tab !== "brain") return;
  state.brainSearch = e.target.value;
  paintBrain();
});
$("#tryRetrievalBtn")?.addEventListener("click", async () => {
  if (state.tab !== "brain") return;
  const q = String($("#brainSearch")?.value || state.brainSearch || "").trim();
  if (!q) {
    alert("Type a query in the search box first.");
    return;
  }
  state.brainSearch = q;
  state.showdownOpen = true;
  state.showdownQuery = q;
  renderBrain();
  const input = $("#showdownQuery");
  if (input) input.value = q;
  await runRetrievalShowdown();
  try {
    const packet = await api("/api/context", {
      method: "POST",
      body: JSON.stringify({ query: q }),
    });
    const n = Array.isArray(packet?.claims) ? packet.claims.length : 0;
    noteContextHit();
    const el = $("#showdownResult");
    if (el && n >= 0) {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = `Live amem_context would return ${n} claim${n === 1 ? "" : "s"} for this query (same path MCP uses).`;
      el.prepend(note);
    }
  } catch {
    /* showdown result is enough */
  }
});
$("#showdownToggle")?.addEventListener("click", () => {
  if (state.tab !== "brain") return;
  state.showdownOpen = !state.showdownOpen;
  if (!state.showdownOpen) clearRetrievalShowdown();
  renderBrain();
});
$("#autoApplyAll")?.addEventListener("change", async (e) => {
  if (state.tab !== "brain") return;
  const on = Boolean(e.target.checked);
  try {
    const result = await apiUnscoped("/api/prefs", {
      method: "POST",
      body: JSON.stringify({ autoApplyAll: on }),
    });
    state.prefs = { autoApplyAll: result.autoApplyAll };
    await refreshGraph();
    renderBrain();
  } catch (err) {
    e.target.checked = !on;
    alert(err.message);
  }
});
$("#rulesSyncBtn")?.addEventListener("click", async () => {
  if (state.tab !== "brain") return;
  try {
    const result = await api("/api/rules/sync", { method: "POST", body: "{}" });
    alert(`Wrote ${result.pinned} pinned facts to ${result.path}`);
  } catch (err) {
    alert(err.message);
  }
});

$("#repoSelect")?.addEventListener("change", async (e) => {
  const value = e.target.value;
  if (value === "__add__") {
    fillRepoSelect();
    setAddPanel(true);
    return;
  }
  if (value === "__all__") {
    state.brainAll = true;
    persistBrainAll(true);
    writeUrlState();
    await render();
    return;
  }
  if (value.startsWith("repo:")) {
    state.brainAll = false;
    persistBrainAll(false);
    await focusRepo({ repoId: value.slice(5), tab: state.tab === "setup" ? "setup" : state.tab });
    return;
  }
  if (value.startsWith("path:")) {
    state.brainAll = false;
    persistBrainAll(false);
    await focusRepo({ path: value.slice(5), tab: "setup" });
  }
});

$("#addRepoBtn")?.addEventListener("click", () => setAddPanel(true));
$("#personalBtn")?.addEventListener("click", () => focusPersonal());
$("#vaultToggle")?.addEventListener("click", () => {
  $("#vaultPanel")?.classList.toggle("hidden");
});
$("#vaultLockBtn")?.addEventListener("click", () => vaultAction("/api/vault/lock"));
$("#vaultUnlockBtn")?.addEventListener("click", () => vaultAction("/api/vault/unlock"));
$("#vaultBackupBtn")?.addEventListener("click", () => vaultAction("/api/vault/backup"));
$("#vaultScheduleBtn")?.addEventListener("click", () => {
  const hour = Number($("#vaultHour")?.value);
  vaultAction("/api/vault/backup/schedule", { hour: Number.isFinite(hour) ? hour : 3 });
});
$("#vaultUnscheduleBtn")?.addEventListener("click", () => vaultAction("/api/vault/backup/unschedule"));
$("#vaultRestoreBtn")?.addEventListener("click", () => {
  const file = $("#vaultRestorePath")?.value?.trim();
  if (!file) {
    alert("Path to a local backup .db or .db.enc is required");
    return;
  }
  vaultAction("/api/vault/restore", { file });
});
$("#renameWsBtn")?.addEventListener("click", () => {
  renameWorkspaceUi(matchBoundRepo() || state.status?.repo);
});
$("#addRepoCancel")?.addEventListener("click", () => setAddPanel(false));
$("#addRepoGo")?.addEventListener("click", () => openAddedPath());
$("#addRepoPath")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") openAddedPath();
});

document.querySelectorAll("#tabs button[data-tab]").forEach((b) => {
  b.classList.toggle("active", b.dataset.tab === state.tab);
});

refreshStatus()
  .then(render)
  .catch((e) => {
    $("#main").innerHTML = `<section class="hero"><div class="hero-inner"><h1>amem</h1><p>${e.message}</p></div></section>`;
  });

setInterval(async () => {
  const before = listedRepos()
    .map((r) => r.id)
    .sort()
    .join(",");
  try {
    await refreshRepos();
  } catch {
    return;
  }
  const after = listedRepos()
    .map((r) => r.id)
    .sort()
    .join(",");
  if (after !== before) fillRepoSelect();
}, 3000);
