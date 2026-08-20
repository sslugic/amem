const PLATFORM_STORAGE = "amem.selectedPlatforms";
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

const state = {
  tab: ["setup", "brain", "stats"].includes(initialUrl.get("tab"))
    ? initialUrl.get("tab")
    : "setup",
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
  selectedFile: null,
  brainSearch: "",
  anim: 0,
  graphTick: 0,
  vault: null,
  recipe: null,
  license: null,
  embed: null,
};

function scopedPath(path) {
  const url = new URL(path, location.origin);
  if (state.repoId) url.searchParams.set("repo", state.repoId);
  else if (state.path) url.searchParams.set("path", state.path);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

async function api(path, options = {}) {
  const res = await fetch(scopedPath(path), {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
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
  if (state.repoId) q.set("repo", state.repoId);
  if (state.path) q.set("path", state.path);
  history.replaceState(null, "", `?${q.toString()}`);
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  writeUrlState();
  render();
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
  await refreshVault();
}

async function refreshVault() {
  try {
    state.vault = await apiUnscoped("/api/vault");
  } catch {
    state.vault = state.status?.vault || null;
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
  try {
    state.embed = await apiUnscoped("/api/embed");
  } catch {
    state.embed = state.status?.embed || null;
  }
  paintVault();
}

function vaultChipHtml() {
  const v = state.vault;
  if (!v) return `<span class="vault-chip">Vault…</span>`;
  const lock = v.encryptedAtRest
    ? `<span class="vault-chip warn">Locked</span>`
    : v.encCopyPresent
      ? `<span class="vault-chip ok">Unlocked</span>`
      : `<span class="vault-chip">Plaintext</span>`;
  const backup = v.backup?.scheduled
    ? `<span class="vault-chip ok">Backup scheduled</span>`
    : `<span class="vault-chip">Backup off</span>`;
  const last = v.backup?.last
    ? `<span class="vault-chip">Last ${esc(v.backup.last.mtime.slice(0, 10))}</span>`
    : `<span class="vault-chip">No backup yet</span>`;
  const lic = state.license;
  const license = lic
    ? `<span class="vault-chip ${lic.tier === "free" ? "" : "ok"}">License ${esc(lic.tier)}</span>`
    : "";
  const emb = state.embed;
  const embed = emb ? `<span class="vault-chip">Embed ${esc(emb.backend)}</span>` : "";
  return `${lock}${backup}${last}${license}${embed}`;
}

function paintVault() {
  const chips = $("#vaultChips");
  if (chips) chips.innerHTML = vaultChipHtml();
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

async function refreshGraph() {
  if (!state.status?.repo) {
    state.graph = null;
    return;
  }
  state.graph = await api("/api/graph?days=30");
}

async function refreshUsage(scope = "current", days = 30) {
  if (!state.status?.repo && scope === "current") {
    state.usage = null;
    return;
  }
  const q = scope === "all" ? `scope=all&days=${days}` : `days=${days}`;
  state.usage = await api(`/api/usage?${q}`);
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
      if (r.id === currentId || samePath(r.root_path, currentPath)) opt.selected = true;
      group.appendChild(opt);
    }
    select.appendChild(group);
  };

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
    opt.selected = true;
    select.insertBefore(opt, select.firstChild);
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

function renderSetup() {
  const s = state.status;
  const bound = matchBoundRepo();
  const configured = Boolean(s?.setup?.setup_completed_at || s?.repo || bound);
  const main = $("#main");
  const repos = listedRepos();
  const gitBound = repos.filter((r) => !isWorkspace(r));
  const workspaces = repos.filter(isWorkspace);
  const scanned = state.scan?.repos || [];
  const filter = state.scanFilter.trim().toLowerCase();
  const visible = scanned.filter((r) => {
    if (!filter) return true;
    return `${r.name} ${r.path} ${r.remote || ""}`.toLowerCase().includes(filter);
  });
  const pickedCount = [...state.picked].length;
  const serviceOn = Boolean(state.service?.installed);
  const focused = bound || s?.repo;
  const focusedWs = isWorkspace(focused);
  const focusedSlug = focused?.slug || "";

  const issues = (s.doctor || []).filter((i) => !(bound && i === "Repo not initialized"));

  main.innerHTML = `
    <section class="hero">
      <div class="hero-inner setup-wide">
        <h1>amem</h1>
        <p>Track git repos and named workspaces separately. Memory stays in ~/.amem and never leaves localhost.</p>
        <div class="platform-row">
          ${knownClients()
            .map(
              (p) => `<button class="chip ${state.selected.has(p.id) ? "selected" : ""}" data-platform="${esc(p.id)}" type="button">
            <strong>${esc(p.label)}</strong>
            <span>${esc(p.hint)}</span>
          </button>`,
            )
            .join("")}
        </div>
        ${
          state.service?.supported === false
            ? `<p class="note">Login auto-start is not supported on this OS.</p>`
            : `<label class="autostart"><input type="checkbox" id="autostart" ${serviceOn ? "checked" : ""}/> Start amem ui when this computer logs in${
                state.service?.servicePlatform === "linux"
                  ? " (systemd user unit)"
                  : state.service?.servicePlatform === "win32"
                    ? " (Startup folder)"
                    : ""
              }</label>`
        }
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
        </div>
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
        </div>
        <div class="recipe-card">
          <div class="scan-head">
            <div>
              <strong>Remember contract (any MCP host)</strong>
              <div class="note" style="margin:0.25rem 0 0">Read first, then write. Same tools for every client — not a per-app fork.</div>
            </div>
            <button class="btn secondary small" id="copyRecipe" type="button">Copy recipe</button>
          </div>
          <pre id="recipePaste">${esc(state.recipe?.paste || "amem recipe")}</pre>
        </div>
        ${
          configured
            ? `<div class="status-grid" style="margin-top:1.5rem">
          <div class="stat-line"><span>Focused ${focusedWs ? "workspace" : "git repo"}</span><b>${esc(focused?.repo_name || s?.identity?.repoName || "—")}</b></div>
          ${focusedWs && focusedSlug && focusedSlug !== focused?.repo_name ? `<div class="stat-line"><span>MCP id</span><b>${esc(focusedSlug)}</b></div>` : ""}
          <div class="stat-line"><span>Claims</span><b>${s.counts?.claims ?? 0}</b></div>
          <div class="stat-line"><span>License</span><b>${esc(s.license?.tier || state.license?.tier || "free")}</b></div>
          <div class="stat-line"><span>Embed</span><b>${esc(s.embed?.backend || state.embed?.backend || "hash")}</b></div>
          <div class="stat-line"><span>DB</span><b>${s.dbPath}</b></div>
        </div>
        ${issues.length ? `<div class="issues">${issues.map((i) => `• ${i}`).join("<br/>")}</div>` : ""}
        <div class="bootstrap">
          <label class="note">Bootstrap proposal (applied only to the focused ${focusedWs ? "workspace" : "repo"})</label>
          <textarea id="proposal">${defaultProposal()}</textarea>
          <div class="actions">
            <button class="btn" id="applyBootstrap">Apply bootstrap</button>
            <button class="btn secondary" id="openBrain">Open brain</button>
          </div>
        </div>`
            : `<p class="note">Select repos above, then Start tracking. Cursor chats in those folders will use local amem memory.</p>`
        }
      </div>
    </section>`;

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
      const hay = `${c.id} ${c.kind || ""} ${c.text || ""} ${claimAnchors(c).join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filter === "durable") return !isSessionClaim(c);
    if (filter === "files") return !isSessionClaim(c);
    if (filter === "chats") return isSessionClaim(c);
    if (filter === "used") return hot.has(c.id);
    if (filter === "pinned") return Number(c.pinned || 0) > 0;
    if (filter === "drafts") return false; // drafts render separately
    return true;
  });
}

function fileGroups(claims) {
  const groups = new Map();
  for (const c of claims) {
    const anchors = claimAnchors(c);
    const keys = anchors.length ? anchors : ["(no file yet)"];
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

function renderBrain() {
  const main = $("#main");
  state.graphTick += 1;
  if (!state.status?.repo) {
    main.innerHTML = `<section class="hero"><div class="hero-inner"><h1>amem</h1><p>Finish setup before viewing the brain.</p><button class="btn" id="toSetup">Go to setup</button></div></section>`;
    $("#toSetup").onclick = () => setTab("setup");
    return;
  }
  const g = state.graph || { claims: [], components: [], flows: [], recentEvents: [], recentClaimIds: [], drafts: [] };
  const events = g.recentEvents || [];
  const hits = events.filter((e) => eventKindOf(e) === "local_hit").length;
  const trips = events.filter((e) => eventKindOf(e) === "server_trip").length;
  const files = new Set((g.claims || []).flatMap(claimAnchors)).size;
  const used = (g.recentClaimIds || []).length;
  const drafts = (g.drafts || []).filter((d) => d.status === "pending");

  main.innerHTML = `
    <div class="brain-v2">
      <div class="brain-toolbar">
        <div>
          <h1>What amem knows</h1>
          <p>The map is coverage: each tile is a file, sized by how many facts. Teal was used in a recent query. Click a tile or a recent use to see what was injected. Edit, pin, or delete facts in the drawer.</p>
          <div class="brain-vault">${vaultChipHtml()}</div>
        </div>
        <div class="brain-kpis">
          <span><b>${g.claims?.length ?? 0}</b> facts</span>
          <span><b>${drafts.length}</b> drafts</span>
          <span><b>${files}</b> files</span>
          <span><b>${used}</b> used recently</span>
          <span><b>${hits}</b> local hits</span>
          <span><b>${trips}</b> misses</span>
        </div>
      </div>
      <div class="brain-tools">
        <input id="brainSearch" type="search" placeholder="Search facts…" value="${esc(state.brainSearch || "")}" />
      </div>
      <div class="brain-filters" id="brainFilters">
        <button type="button" data-filter="files" class="${state.brainFilter === "files" ? "active" : ""}">By file</button>
        <button type="button" data-filter="drafts" class="${state.brainFilter === "drafts" ? "active" : ""}">Drafts${drafts.length ? ` (${drafts.length})` : ""}</button>
        <button type="button" data-filter="chats" class="${state.brainFilter === "chats" ? "active" : ""}">Recent chats</button>
        <button type="button" data-filter="used" class="${state.brainFilter === "used" ? "active" : ""}">Used recently</button>
        <button type="button" data-filter="pinned" class="${state.brainFilter === "pinned" ? "active" : ""}">Pinned</button>
      </div>
      <div class="brain-body">
        <aside class="brain-feed" id="brainFeed"></aside>
        <section class="brain-map" id="brainMap"></section>
        <aside class="drawer" id="drawer"></aside>
      </div>
    </div>`;

  $("#brainSearch")?.addEventListener("input", (e) => {
    state.brainSearch = e.target.value;
    paintBrain();
  });
  $("#brainFilters")?.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.brainFilter = btn.dataset.filter;
      state.selectedNode = null;
      state.selectedFile = null;
      renderBrain();
    });
  });
  paintBrain();
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
      : `<h2>Pending drafts</h2>${drafts
          .map((d) => {
            const active = state.selectedNode?.type === "draft" && state.selectedNode.id === d.id;
            return `<button type="button" class="feed-item draft ${active ? "active" : ""}" data-draft="${esc(d.id)}">
              <div class="feed-top"><span>${esc(d.platform || "agent")} · ${esc(formatWhen(d.created_at))}</span><span class="pill ${d.quality?.label === "high" ? "" : "warn"}">${esc(d.quality?.label || "approve?")}${d.conflicts?.length ? " · conflict" : ""}</span></div>
              <div class="feed-q">${esc(d.title || d.id)}</div>
              <div class="feed-meta">${d.quality ? `Confidence ${d.quality.score}` : "Session capture"} — apply to store, or dismiss</div>
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
  const w = Math.max(160, Math.floor(host.clientWidth));
  const h = Math.max(140, Math.floor(host.clientHeight - legendH));
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
    .map((r) => {
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
      return `<g class="${classes}" data-file="${esc(r.file)}" role="button" tabindex="0">
        <title>${esc(r.file)} · ${r.count} fact${r.count === 1 ? "" : "s"}${r.used ? " · used recently" : ""}</title>
        <rect x="${r.x.toFixed(1)}" y="${r.y.toFixed(1)}" width="${r.w.toFixed(1)}" height="${r.h.toFixed(1)}" rx="7"/>
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

  if (state.brainFilter === "drafts") {
    const drafts = (state.graph?.drafts || []).filter((d) => d.status === "pending");
    const selectedId = state.selectedNode?.type === "draft" ? state.selectedNode.id : null;
    el.innerHTML =
      drafts.length === 0
        ? `<div class="brain-empty">No pending drafts. When a Cursor session ends, amem will queue a capture here for you to approve.</div>`
        : `<div class="draft-toolbar"><button class="btn secondary small" type="button" id="rejectNoisy">Reject noisy drafts</button></div><div class="draft-grid">${drafts
            .map((d) => {
              return `<button type="button" class="draft-card ${selectedId === d.id ? "selected" : ""}" data-draft-map="${esc(d.id)}">
                <strong>${esc(d.title || d.id)}</strong>
                <span class="meta">${esc(d.platform || "agent")} · ${esc(formatWhen(d.created_at))} · ${esc(d.quality?.label || "unscored")}${d.quality ? ` ${d.quality.score}` : ""}${d.conflicts?.length ? " · conflict" : ""}</span>
              </button>`;
            })
            .join("")}</div>`;
    el.querySelectorAll("[data-draft-map]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const draft = (state.graph.drafts || []).find((x) => x.id === btn.dataset.draftMap);
        if (!draft) return;
        state.selectedNode = { type: "draft", id: draft.id, detail: draft };
        paintBrain();
      });
    });
    $("#rejectNoisy")?.addEventListener("click", async () => {
      try {
        const result = await api("/api/drafts/reject-noisy", { method: "POST", body: "{}" });
        await refreshGraph();
        renderBrain();
        if (result.count) alert(`Dismissed ${result.count} low-quality draft${result.count === 1 ? "" : "s"}.`);
      } catch (err) {
        alert(err.message);
      }
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
      ? "Highlighting files that were injected in a recent query."
      : state.brainFilter === "chats"
        ? "Highlighting chat takeaways. Other files stay on the map, dimmed."
        : state.brainFilter === "pinned"
          ? "Only pinned facts — these rank higher in retrieval."
          : "Every tile is a file amem can inject instead of a repo search.";

  const list =
    shown.length === 0
      ? `<div class="brain-empty">${
          state.brainFilter === "used"
            ? "Nothing in this repo has been used in a context query yet — the map still shows what is stored."
            : state.brainFilter === "chats"
              ? "No session takeaways yet. Approve a draft or keep chatting."
              : state.brainFilter === "pinned"
                ? "No pinned facts yet. Open a claim in the drawer and pin it."
                : state.brainSearch
                  ? "No facts match that search."
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
              const tags = [
                Number(c.pinned || 0) > 0 ? "pinned" : null,
                c.kind,
                ...rel.flows.map((f) => f.name),
                ...rel.components.map((x) => x.name),
              ]
                .filter(Boolean)
                .slice(0, 4);
              return `<li>
                <button type="button" class="claim-row ${hot.has(c.id) ? "hot" : ""} ${selectedId === c.id ? "selected" : ""}" data-claim="${esc(c.id)}">
                  <span class="claim-text">${esc(claimPreview(c))}</span>
                  <span class="claim-tags">${tags.map((t) => `<em>${esc(t)}</em>`).join("")}</span>
                </button>
              </li>`;
            })
            .join("")}
        </ul>
      </article>`;
          })
          .join("");

  el.innerHTML = `
    <div class="coverage-host" id="coverageHost"></div>
    <div class="brain-facts">
      <h2>${selectedFile ? esc(fileLabel(selectedFile)) : "Facts"} <span>${esc(filterHint)}</span></h2>
      ${list}
    </div>`;

  renderCoverageMap();

  el.querySelectorAll("[data-claim]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const claim = (state.graph.claims || []).find((c) => c.id === btn.dataset.claim);
      if (!claim) return;
      const anchors = claimAnchors(claim);
      if (anchors[0]) state.selectedFile = anchors[0];
      state.selectedNode = { type: "claim", id: claim.id, detail: claim };
      paintBrain();
    });
  });
}

function showBrainOverview() {
  const drawer = $("#drawer");
  if (!drawer) return;
  const g = state.graph || {};
  const durable = (g.claims || []).filter((c) => !isSessionClaim(c)).length;
  const chats = (g.claims || []).filter(isSessionClaim).length;
  drawer.innerHTML = `
    <h2>${esc(state.status.repo.repo_name)}</h2>
    <div class="meta">Local memory map</div>
    <p>The map is what amem can inject instead of a repo search. Bigger tiles have more facts. Teal tiles were used in a recent query.</p>
    <div class="meta">${durable} durable facts · ${chats} chat takeaways · ${g.flows?.length ?? 0} flows · ${g.components?.length ?? 0} components</div>
    <p class="note" style="margin:0">Click a tile to read that file’s facts. Click a recent use to see what was injected. “Had to explore” means amem missed.</p>`;
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
          ? `<ul class="detail-list">${claims.map((c) => `<li><strong>${esc(claimPreview(c, 90))}</strong><div class="meta">${claimAnchors(c).map((a) => `<code>${esc(a)}</code>`).join(" ") || ""}</div></li>`).join("")}</ul>`
          : ""
      }`;
    return;
  }
  if (node.type === "file") {
    const group = node.detail || coverageGroups().find((g) => g.file === node.id);
    const items = group?.items || [];
    drawer.innerHTML = `
      <h2>${esc(fileLabel(node.id))}</h2>
      <div class="meta"><code>${esc(node.id)}</code> · ${items.length} fact${items.length === 1 ? "" : "s"}</div>
      <p>amem can inject these instead of grepping this file. Teal on the map means a recent query already used one of them.</p>
      ${
        items.length
          ? `<ul class="detail-list">${items
              .map(
                (c) =>
                  `<li><strong>${esc(claimPreview(c, 90))}</strong><div class="meta">${esc(c.kind || "fact")}</div></li>`,
              )
              .join("")}</ul>`
          : ""
      }`;
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
      <div class="meta">${esc(d.platform || "agent")} · ${esc(formatWhen(d.created_at))} · ${esc(d.source || "session-end")}${quality ? ` · ${esc(quality.label)} ${quality.score}` : ""}</div>
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
          body: JSON.stringify({ id: d.id, resolve }),
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
        await api("/api/drafts/dismiss", { method: "POST", body: JSON.stringify({ id: d.id }) });
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
      <div class="meta">${esc(d.id)}</div>
      <label class="drawer-label">Text</label>
      <textarea id="claimText" rows="6">${esc(d.text || "")}</textarea>
      <label class="drawer-label">Kind</label>
      <input id="claimKind" type="text" value="${esc(d.kind || "")}" />
      <label class="drawer-label">Anchors (comma-separated)</label>
      <input id="claimAnchors" type="text" value="${esc(anchors.join(", "))}" />
      <div class="drawer-actions">
        <button class="btn" type="button" id="claimSave">Save</button>
        <button class="btn secondary" type="button" id="claimPin">${pinned ? "Unpin" : "Pin"}</button>
        <button class="btn secondary danger" type="button" id="claimDelete">Delete</button>
      </div>
      ${rel.flows.length ? `<div class="meta">Flows: ${rel.flows.map((f) => esc(f.name)).join(", ")}</div>` : ""}
      ${rel.components.length ? `<div class="meta">Components: ${rel.components.map((c) => esc(c.name)).join(", ")}</div>` : ""}
      <p class="note" style="margin:0">Pinned facts rank higher in <code>amem context</code>. Delete removes the claim from local memory only.</p>`;
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
        const result = await api("/api/claims/pin", {
          method: "POST",
          body: JSON.stringify({ id: d.id, pinned: !pinned }),
        });
        state.selectedNode = { type: "claim", id: d.id, detail: result.claim };
        await refreshGraph();
        paintBrain();
      } catch (err) {
        alert(err.message);
      }
    });
    $("#claimDelete")?.addEventListener("click", async () => {
      if (!confirm(`Delete ${d.id} from local memory?`)) return;
      try {
        await api(`/api/claims?id=${encodeURIComponent(d.id)}`, { method: "DELETE" });
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
  if (!Number.isFinite(v) || v <= 0) return "$0";
  if (v < 0.01) return `~$${v.toFixed(3)}`;
  return `~$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatChartDay(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderStats() {
  const main = $("#main");
  if (!state.status?.repo) {
    main.innerHTML = `<section class="hero"><div class="hero-inner"><h1>amem</h1><p>Finish setup to see savings stats.</p></div></section>`;
    return;
  }
  const agg = state.usage?.aggregate;
  const currentScope = state.usage?.scope === "all" ? "all" : "current";
  const currentDays = String(state.usage?.days ?? 30);
  main.innerHTML = `
    <section class="stats-page">
      <h1>Token, time &amp; money savings</h1>
      <p class="sub">Local lookup time is measured. Time and money are proxies (avoided file reads / input tokens) — not your Cursor or model bill. Showing ${currentScope === "all" ? "all bound repos" : state.status.repo.repo_name}.</p>
      <div class="filters">
        <select id="scope">
          <option value="current" ${currentScope === "current" ? "selected" : ""}>This repo</option>
          <option value="all" ${currentScope === "all" ? "selected" : ""}>All local repos</option>
        </select>
        <select id="days">
          <option value="7" ${currentDays === "7" ? "selected" : ""}>7 days</option>
          <option value="30" ${currentDays === "30" ? "selected" : ""}>30 days</option>
          <option value="90" ${currentDays === "90" ? "selected" : ""}>90 days</option>
        </select>
        <button class="btn secondary small" type="button" data-export="json">Export JSON</button>
        <button class="btn secondary small" type="button" data-export="md">Export markdown</button>
        <button class="btn secondary small" type="button" data-export="pdf">Export PDF</button>
      </div>
      <div class="platform-cards" id="speedCards"></div>
      <h2 class="stats-heading">Monthly projection</h2>
      <div class="platform-cards" id="monthlyCards"></div>
      <div class="platform-cards" id="cards"></div>
      <div class="chart-wrap">
        <h2>Estimated tokens saved by day</h2>
        <div class="chart-stage">
          <canvas id="savingsChart"></canvas>
          <div class="chart-tooltip hidden" id="chartTooltip"></div>
        </div>
      </div>
      <p class="note">Tokens: max(0, anchors×4000 + claims×200 − packet tokens). Time: anchors×1.2s + claims×80ms. Money: tokens × $${agg?.pricing?.usdPerMillionInputTokens ?? 3}/1M input tokens (Sonnet-class). Monthly figures scale the last ${agg?.monthly?.trendDays || "N"} day(s) of calls to 30 days. Hover a bar for that day’s numbers.</p>
    </section>`;

  const totals = agg?.totals || {};
  const speedCards = $("#speedCards");
  speedCards.innerHTML = `
    <div class="platform-card"><div class="label">Estimated time saved</div><div class="value">~${formatDuration(totals.estimatedMsSaved)}</div><div class="meta">proxy vs tool round-trips · not model latency</div></div>
    <div class="platform-card"><div class="label">Estimated money saved</div><div class="value">${formatUsd(totals.estimatedUsdSaved)}</div><div class="meta">at $${agg?.pricing?.usdPerMillionInputTokens ?? 3}/1M input tokens · proxy, not a bill</div></div>
    <div class="platform-card"><div class="label">Local lookup</div><div class="value">${totals.avgLocalMs != null ? formatDuration(totals.avgLocalMs) : "—"}</div><div class="meta">measured SQLite / localhost avg</div></div>
    <div class="platform-card"><div class="label">Hit rate</div><div class="value">${formatPct(totals.hitRate)}</div><div class="meta">${totals.localHits ?? 0} keyword hits · ${totals.serverTrips ?? 0} misses · not model API calls</div></div>
    <div class="platform-card"><div class="label">Avoided file reads</div><div class="value">${formatTokens(totals.anchorsAvoided ?? 0)}</div><div class="meta">unique anchors returned in packets</div></div>`;

  const monthly = agg?.monthly || {};
  const monthlyCards = $("#monthlyCards");
  const trend = monthly.trendDays || 0;
  monthlyCards.innerHTML = `
    <div class="platform-card accented"><div class="label">Est. tokens / month</div><div class="value">~${formatTokens(monthly.estimatedTokensSaved ?? 0)}</div><div class="meta">${trend ? `from ${monthly.sampleQueries} calls over ${trend} day${trend === 1 ? "" : "s"} × 30` : "no usage yet"} · proxy, not a bill</div></div>
    <div class="platform-card accented"><div class="label">Est. $ / month</div><div class="value">${formatUsd(monthly.estimatedUsdSaved)}</div><div class="meta">same token proxy at $${agg?.pricing?.usdPerMillionInputTokens ?? 3}/1M input</div></div>
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

  drawChart(agg?.byDay || []);

  $("#scope").addEventListener("change", async (e) => {
    await refreshUsage(e.target.value, Number($("#days").value));
    renderStats();
  });
  $("#days").addEventListener("change", async (e) => {
    await refreshUsage($("#scope").value, Number(e.target.value));
    renderStats();
  });
  main.querySelectorAll("[data-export]").forEach((btn) => {
    btn.addEventListener("click", () => downloadSavings(btn.dataset.export));
  });
}

async function downloadSavings(format) {
  const scope = $("#scope")?.value || "current";
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

async function render() {
  fillRepoSelect();
  paintVault();
  try {
    await refreshStatus();
  } catch (e) {
    await refreshVault();
    if (/encrypted|unlock|Passphrase/i.test(String(e.message))) {
      $("#main").innerHTML = `<section class="hero"><div class="hero-inner"><h1>Locked</h1><p>Unlock from the header to open Brain and Stats. Memory never left this machine.</p></div></section>`;
      return;
    }
    throw e;
  }
  fillRepoSelect();
  if (state.tab === "setup") {
    try {
      await loadScan();
    } catch (e) {
      alert(e.message);
    }
    fillRepoSelect();
    renderSetup();
  } else if (state.tab === "brain") {
    await refreshGraph();
    renderBrain();
  } else {
    await refreshUsage("current", 30);
    renderStats();
  }
}

document.querySelectorAll(".tabs button").forEach((b) => {
  b.addEventListener("click", () => setTab(b.dataset.tab));
});

$("#repoSelect")?.addEventListener("change", async (e) => {
  const value = e.target.value;
  if (value === "__add__") {
    fillRepoSelect();
    setAddPanel(true);
    return;
  }
  if (value.startsWith("repo:")) {
    await focusRepo({ repoId: value.slice(5), tab: state.tab === "setup" ? "setup" : state.tab });
    return;
  }
  if (value.startsWith("path:")) {
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
$("#renameWsBtn")?.addEventListener("click", () => {
  renameWorkspaceUi(matchBoundRepo() || state.status?.repo);
});
$("#addRepoCancel")?.addEventListener("click", () => setAddPanel(false));
$("#addRepoGo")?.addEventListener("click", () => openAddedPath());
$("#addRepoPath")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") openAddedPath();
});

document.querySelectorAll(".tabs button").forEach((b) => {
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
