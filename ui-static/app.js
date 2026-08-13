const initialUrl = new URLSearchParams(location.search);

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
  selected: new Set(["cursor"]),
  picked: new Set(),
  scan: null,
  scanFilter: "",
  scanLoading: false,
  service: null,
  selectedNode: null,
  activeEventId: null,
  brainFilter: "files",
  anim: 0,
  graphTick: 0,
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

  for (const r of repos) {
    const opt = document.createElement("option");
    opt.value = `repo:${r.id}`;
    const n = r.counts?.claims ?? 0;
    opt.textContent = `${r.repo_name} · ${n} claim${n === 1 ? "" : "s"}`;
    if (r.id === currentId || samePath(r.root_path, currentPath)) opt.selected = true;
    select.appendChild(opt);
  }

  if (!inList && currentPath) {
    const opt = document.createElement("option");
    opt.value = `path:${currentPath}`;
    opt.textContent = `${state.status?.identity?.repoName || currentPath} · not initialized`;
    opt.selected = true;
    select.insertBefore(opt, select.firstChild);
  }

  const add = document.createElement("option");
  add.value = "__add__";
  add.textContent = "Add repo…";
  select.appendChild(add);

  if (!select.value && previous && previous !== "__add__") {
    select.value = previous;
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
  const boundCount = repos.length;
  const scanned = state.scan?.repos || [];
  const filter = state.scanFilter.trim().toLowerCase();
  const visible = scanned.filter((r) => {
    if (!filter) return true;
    return `${r.name} ${r.path} ${r.remote || ""}`.toLowerCase().includes(filter);
  });
  const pickedCount = [...state.picked].length;
  const serviceOn = Boolean(state.service?.installed);

  const issues = (s.doctor || []).filter((i) => !(bound && i === "Repo not initialized"));

  main.innerHTML = `
    <section class="hero">
      <div class="hero-inner setup-wide">
        <h1>amem</h1>
        <p>Pick the git repos on this machine to track. Memory stays in ~/.amem and never leaves localhost.</p>
        <div class="platform-row">
          <button class="chip ${state.selected.has("cursor") ? "selected" : ""}" data-platform="cursor">
            <strong>Cursor</strong>
            <span>Rules, skills, hooks</span>
          </button>
          <button class="chip ${state.selected.has("claude") ? "selected" : ""}" data-platform="claude">
            <strong>Claude Code</strong>
            <span>Skills and settings hooks</span>
          </button>
        </div>
        ${
          state.service?.supported === false
            ? `<p class="note">Login auto-start is currently macOS-only.</p>`
            : `<label class="autostart"><input type="checkbox" id="autostart" ${serviceOn ? "checked" : ""}/> Start amem ui when this computer logs in</label>`
        }
        <div class="scan-head">
          <div>
            <strong>Git repos on this Mac</strong>
            <div class="note" style="margin:0.25rem 0 0">${
              state.scanLoading
                ? "Scanning your home folder…"
                : `${scanned.length} found · ${boundCount} already tracking${state.scan?.truncated ? " · scan capped" : ""}`
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
        <div class="workspace-add">
          <label class="note">Named workspace for any LLM client (no git repo required)</label>
          <div class="add-repo-row">
            <input id="wsName" type="text" placeholder="luna" />
            <button class="btn secondary" id="wsBtn" type="button">Create workspace</button>
          </div>
          <p class="note">Luna / any MCP host: keep this UI running, then connect to <code>http://127.0.0.1:7843/mcp?workspace=NAME</code> (not a bare <code>amem</code> command — GUI apps often cannot see Homebrew on PATH).</p>
        </div>
        ${
          configured
            ? `<div class="status-grid" style="margin-top:1.5rem">
          <div class="stat-line"><span>Focused repo</span><b>${s.repo?.repo_name || bound?.repo_name || s?.identity?.repoName || "—"}</b></div>
          <div class="stat-line"><span>Claims</span><b>${s.counts?.claims ?? 0}</b></div>
          <div class="stat-line"><span>DB</span><b>${s.dbPath}</b></div>
        </div>
        ${issues.length ? `<div class="issues">${issues.map((i) => `• ${i}`).join("<br/>")}</div>` : ""}
        <div class="bootstrap">
          <label class="note">Bootstrap proposal (applied only to the focused repo)</label>
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
      if (state.selected.has(p)) state.selected.delete(p);
      else state.selected.add(p);
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
      const mcpUrl = created.mcp?.url || `http://127.0.0.1:7843/mcp?workspace=${created.workspace}`;
      alert(
        `Workspace "${created.workspace}" is ready.${checks ? `\n${checks}` : ""}\n\nLuna MCP URL:\n${mcpUrl}`,
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
  return claims.filter((c) => {
    if (filter === "durable") return !isSessionClaim(c);
    if (filter === "files") return !isSessionClaim(c);
    if (filter === "chats") return isSessionClaim(c);
    if (filter === "used") return hot.has(c.id);
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
  const g = state.graph || { claims: [], components: [], flows: [], recentEvents: [], recentClaimIds: [] };
  const events = g.recentEvents || [];
  const hits = events.filter((e) => eventKindOf(e) === "local_hit").length;
  const trips = events.filter((e) => eventKindOf(e) === "server_trip").length;
  const files = new Set((g.claims || []).flatMap(claimAnchors)).size;
  const used = (g.recentClaimIds || []).length;

  main.innerHTML = `
    <div class="brain-v2">
      <div class="brain-toolbar">
        <div>
          <h1>What amem knows</h1>
          <p>Facts grouped by file — what Cursor can skip reading. Teal means used in a recent query.</p>
        </div>
        <div class="brain-kpis">
          <span><b>${g.claims?.length ?? 0}</b> facts</span>
          <span><b>${files}</b> files</span>
          <span><b>${used}</b> used recently</span>
          <span><b>${hits}</b> local hits</span>
          <span><b>${trips}</b> misses</span>
        </div>
      </div>
      <div class="brain-filters" id="brainFilters">
        <button type="button" data-filter="files" class="${state.brainFilter === "files" ? "active" : ""}">By file</button>
        <button type="button" data-filter="chats" class="${state.brainFilter === "chats" ? "active" : ""}">Recent chats</button>
        <button type="button" data-filter="used" class="${state.brainFilter === "used" ? "active" : ""}">Used recently</button>
      </div>
      <div class="brain-body">
        <aside class="brain-feed" id="brainFeed"></aside>
        <section class="brain-map" id="brainMap"></section>
        <aside class="drawer" id="drawer"></aside>
      </div>
    </div>`;

  $("#brainFilters")?.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.brainFilter = btn.dataset.filter;
      state.selectedNode = null;
      renderBrain();
    });
  });
  paintBrain();
}

function paintBrain() {
  renderBrainFeed();
  renderBrainMap();
  if (state.selectedNode) showBrainDetail(state.selectedNode);
  else showBrainOverview();
}

function renderBrainFeed() {
  const el = $("#brainFeed");
  if (!el) return;
  const events = (state.graph?.recentEvents || []).slice(0, 16);
  if (!events.length) {
    el.innerHTML = `<h2>Recent uses</h2><p class="note" style="margin:0">No <code>amem context</code> hits yet. Ask Cursor something in this repo — local hits show up here.</p>`;
    return;
  }
  el.innerHTML = `<h2>Recent uses</h2>${events
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
    .join("")}`;
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
      paintBrain();
    });
  });
}

function renderBrainMap() {
  const el = $("#brainMap");
  if (!el) return;
  const claims = visibleClaims();
  const groups = fileGroups(claims);
  const hot = new Set(state.graph?.recentClaimIds || []);
  const selectedId = state.selectedNode?.type === "claim" ? state.selectedNode.id : null;

  if (!groups.length) {
    const empty =
      state.brainFilter === "used"
        ? "Nothing in this repo has been used in a context query yet."
        : state.brainFilter === "chats"
          ? "No session takeaways yet. After a Cursor chat, stop-hook claims land here."
          : "No facts yet. Apply a bootstrap on Setup, or keep working in this repo.";
    el.innerHTML = `<div class="brain-empty">${empty}</div>`;
    return;
  }

  el.innerHTML = groups
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

  el.querySelectorAll("[data-claim]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const claim = (state.graph.claims || []).find((c) => c.id === btn.dataset.claim);
      if (!claim) return;
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
    <p>This is the knowledge Cursor gets <em>before</em> it greps. Each card is a file; each row is a fact amem can inject.</p>
    <div class="meta">${durable} durable facts · ${chats} chat takeaways · ${g.flows?.length ?? 0} flows · ${g.components?.length ?? 0} components</div>
    <p class="note" style="margin:0">Click a recent use to see what was injected. Click a fact to read it. “Had to explore” means amem missed and the agent likely read files.</p>`;
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
  if (node.type === "claim") {
    const anchors = claimAnchors(d);
    const rel = relatedForClaim(d.id);
    drawer.innerHTML = `
      <h2>${esc(d.kind || "fact")}</h2>
      <div class="meta">${esc(d.id)}</div>
      <p>${esc(d.text)}</p>
      <div class="meta">Files: ${anchors.map((a) => `<code>${esc(a)}</code>`).join(" ") || "—"}</div>
      ${rel.flows.length ? `<div class="meta">Flows: ${rel.flows.map((f) => esc(f.name)).join(", ")}</div>` : ""}
      ${rel.components.length ? `<div class="meta">Components: ${rel.components.map((c) => esc(c.name)).join(", ")}</div>` : ""}
      <p class="note" style="margin:0">Agents should read these files instead of searching the whole repo.</p>`;
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
      <h1>Token &amp; time savings</h1>
      <p class="sub">Local lookup time is measured. “Time saved” is a proxy for avoided file/tool round-trips (~1.2s each) — not Cursor/Anthropic latency. Showing ${currentScope === "all" ? "all bound repos" : state.status.repo.repo_name}.</p>
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
      <p class="note">Tokens: max(0, anchors×4000 + claims×200 − packet tokens). Time: anchors×1.2s + claims×80ms. Monthly figures scale the last ${agg?.monthly?.trendDays || "N"} day(s) of calls to 30 days. Hover a bar for that day’s numbers.</p>
    </section>`;

  const totals = agg?.totals || {};
  const speedCards = $("#speedCards");
  speedCards.innerHTML = `
    <div class="platform-card"><div class="label">Estimated time saved</div><div class="value">~${formatDuration(totals.estimatedMsSaved)}</div><div class="meta">proxy vs tool round-trips · not model latency</div></div>
    <div class="platform-card"><div class="label">Local lookup</div><div class="value">${totals.avgLocalMs != null ? formatDuration(totals.avgLocalMs) : "—"}</div><div class="meta">measured SQLite / localhost avg</div></div>
    <div class="platform-card"><div class="label">Hit rate</div><div class="value">${formatPct(totals.hitRate)}</div><div class="meta">${totals.localHits ?? 0} local hits · ${totals.serverTrips ?? 0} server trips</div></div>
    <div class="platform-card"><div class="label">Avoided file reads</div><div class="value">${formatTokens(totals.anchorsAvoided ?? 0)}</div><div class="meta">unique anchors returned in packets</div></div>`;

  const monthly = agg?.monthly || {};
  const monthlyCards = $("#monthlyCards");
  const trend = monthly.trendDays || 0;
  monthlyCards.innerHTML = `
    <div class="platform-card accented"><div class="label">Est. tokens / month</div><div class="value">~${formatTokens(monthly.estimatedTokensSaved ?? 0)}</div><div class="meta">${trend ? `from ${monthly.sampleQueries} calls over ${trend} day${trend === 1 ? "" : "s"} × 30` : "no usage yet"} · proxy, not a bill</div></div>
    <div class="platform-card accented"><div class="label">Est. time / month</div><div class="value">~${formatDuration(monthly.estimatedMsSaved)}</div><div class="meta">avoided tool round-trips at current pace</div></div>
    <div class="platform-card accented"><div class="label">Est. calls / month</div><div class="value">${formatTokens(monthly.queries ?? 0)}</div><div class="meta">amem context hits if this rate holds</div></div>
    <div class="platform-card accented"><div class="label">Est. file reads / month</div><div class="value">${formatTokens(monthly.anchorsAvoided ?? 0)}</div><div class="meta">anchors that would be skipped</div></div>`;

  const cards = $("#cards");
  const platforms = agg?.byPlatform?.length
    ? agg.byPlatform
    : [{ platform: "—", queries: 0, estimatedTokensSaved: 0, reportedTokensSaved: 0 }];
  cards.innerHTML = `
    <div class="platform-card"><div class="label">Total estimated</div><div class="value">~${formatTokens(agg?.totals?.estimatedTokensSaved ?? 0)}</div><div class="meta">${agg?.totals?.queries ?? 0} context queries · proxy, not billed savings</div></div>
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
    tooltip.innerHTML = `<strong>${formatChartDay(b.day)}</strong><span>~${formatTokens(b.estimatedTokensSaved)} tokens</span><span>~${formatDuration(b.estimatedMsSaved)} estimated time</span><span>${b.queries} ${b.queries === 1 ? "query" : "queries"} · ${b.localHits ?? 0} hits · ${b.serverTrips ?? 0} trips</span>`;
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
  if (state.tab === "setup") {
    await refreshStatus();
    fillRepoSelect();
    try {
      await loadScan();
    } catch (e) {
      alert(e.message);
    }
    fillRepoSelect();
    renderSetup();
  } else if (state.tab === "brain") {
    await refreshStatus();
    fillRepoSelect();
    await refreshGraph();
    renderBrain();
  } else {
    await refreshStatus();
    fillRepoSelect();
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
