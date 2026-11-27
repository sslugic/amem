/**
 * Guided setup: five short steps that leave a new install fully wired.
 *
 *   Welcome → Your AI tools → Your projects → Connect → Done
 *
 * Opens by itself the first time amem has nothing set up, and from Settings / Home with
 * "Run guided setup". Talks to the same local API as the rest of the dashboard; in the
 * desktop app it also offers to put `amem` on the terminal PATH (window.amemDesktop).
 */

const DONE_KEY = "amem.wizard.done";
const desktop = typeof window !== "undefined" ? window.amemDesktop : undefined;

/** What to do in each tool after setup so it loads amem. */
const RESTART_HINT = {
  claude: "Start a new Claude Code session (exit and run claude again).",
  cursor: "Reload the Cursor window (Command Palette → Developer: Reload Window).",
  codex: "Start a new Codex session.",
  gemini: "Start a new Gemini CLI session; /mcp lists amem.",
  qwen: "Start a new Qwen Code session; /mcp lists amem.",
  opencode: "Restart OpenCode.",
  "claude-desktop": "Quit Claude Desktop completely (⌘Q on Mac) and open it again.",
  windsurf: "Restart Windsurf.",
  zed: "Restart Zed.",
  continue: "Reload VS Code or JetBrains.",
  aider: "Run aider with --read .aider.amem.md in your project.",
  copilot: "Switch Copilot Chat to Agent mode in VS Code.",
};

const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "tools", label: "Your AI tools" },
  { id: "projects", label: "Your projects" },
  { id: "connect", label: "Connect" },
  { id: "done", label: "Done" },
];

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
  return json;
}

const MACHINE_WIDE = new Set(["claude-desktop", "windsurf", "zed", "continue"]);

const w = {
  root: null,
  step: 0,
  clients: null,
  chosenTools: new Set(),
  showAllTools: false,
  repos: null,
  scanTruncated: false,
  chosenRepos: new Set(),
  extraRepos: [],
  filter: "",
  applying: false,
  result: null,
  desktopInfo: null,
  pathResult: null,
};

function needsProjects() {
  return [...w.chosenTools].some((id) => !MACHINE_WIDE.has(id));
}

// ---------------------------------------------------------------------------
// Step bodies
// ---------------------------------------------------------------------------

function welcomeHtml() {
  return `
    <div class="wz-hero">
      <img src="/icon-64.png" alt="" width="56" height="56" />
      <h1>Give your AI tools a memory</h1>
      <p class="wz-lead">amem remembers what your coding agents learn about your projects: the decisions, the gotchas, which file does what. The next session starts where the last one stopped.</p>
    </div>
    <ul class="wz-points">
      <li><b>Takes about two minutes.</b> amem finds your AI tools and projects; you tick what to connect.</li>
      <li><b>Stays on this computer.</b> Memory lives in one file in <code>~/.amem</code>. Nothing is uploaded.</li>
      <li><b>Easy to undo.</b> Each tool gets one small config entry, which you can remove any time.</li>
    </ul>`;
}

function toolCard(c) {
  const on = w.chosenTools.has(c.id);
  const status = c.configured
    ? `<span class="wz-badge ok">Already connected</span>`
    : c.installed
      ? `<span class="wz-badge">Found</span>`
      : `<span class="wz-badge muted">Not found</span>`;
  const sub = c.evidence ? esc(c.evidence) : c.autoSetup ? "amem sets it up for you" : "Connects through MCP";
  return `
    <label class="wz-tool ${on ? "on" : ""}">
      <input type="checkbox" data-tool="${esc(c.id)}" ${on ? "checked" : ""} />
      <span class="wz-tool-mark" aria-hidden="true">${esc(c.label.slice(0, 1))}</span>
      <span class="wz-tool-text"><b>${esc(c.label)}</b><small>${sub}</small></span>
      ${status}
    </label>`;
}

function toolsHtml() {
  if (!w.clients) return `<p class="wz-loading">Looking for AI tools on this computer…</p>`;
  const found = w.clients.filter((c) => c.installed);
  const others = w.clients.filter((c) => !c.installed);
  const list = w.showAllTools ? w.clients : found.length ? found : w.clients;
  return `
    <h2>Which AI tools should use amem?</h2>
    <p class="wz-sub">${
      found.length
        ? `We found ${found.length} on this computer and ticked them. Untick any you don't want connected.`
        : "We didn't spot any AI tools in their usual places. Pick the ones you use."
    }</p>
    <div class="wz-tools">${list.map(toolCard).join("")}</div>
    ${
      others.length && found.length
        ? `<button class="linkish wz-more" type="button" data-act="toggle-tools">${
            w.showAllTools ? "Show only the tools we found" : `Show ${others.length} more tools`
          }</button>`
        : ""
    }`;
}

function repoRow(r) {
  const on = w.chosenRepos.has(r.path);
  return `
    <label class="wz-repo ${on ? "on" : ""}">
      <input type="checkbox" data-repo="${esc(r.path)}" ${on ? "checked" : ""} />
      <span><b>${esc(r.name)}</b>${r.tracking ? `<em>already using amem</em>` : ""}<small>${esc(r.path)}</small></span>
    </label>`;
}

function projectsHtml() {
  if (!needsProjects()) {
    return `
      <h2>No projects needed</h2>
      <p class="wz-sub">The tools you picked share one memory for everything, so there is nothing to choose here. Continue to connect them.</p>`;
  }
  const all = [...(w.repos || []), ...w.extraRepos];
  const f = w.filter.trim().toLowerCase();
  const visible = all.filter((r) => !f || `${r.name} ${r.path}`.toLowerCase().includes(f));
  const add = desktop?.pickFolder
    ? `<button class="btn secondary small" type="button" data-act="pick-folder">Add a folder…</button>`
    : `<span class="wz-add"><input id="wzAddPath" type="text" placeholder="/path/to/project" /><button class="btn secondary small" type="button" data-act="add-path">Add</button></span>`;
  return `
    <h2>Which projects should amem remember?</h2>
    <p class="wz-sub">Each project gets its own memory. Pick the ones you work on with AI tools; you can add more later from the sidebar.</p>
    <div class="wz-repo-tools">
      <input id="wzFilter" type="search" placeholder="Filter projects" value="${esc(w.filter)}" />
      ${add}
    </div>
    <div class="wz-repos">${
      w.repos === null
        ? `<p class="wz-loading">Looking for projects in your home folder…</p>`
        : visible.length
          ? visible.map(repoRow).join("")
          : `<p class="wz-empty">${all.length ? "No projects match that filter." : "No git projects found in your home folder. Add a folder instead."}</p>`
    }</div>
    <p class="wz-count">${w.chosenRepos.size} selected${w.scanTruncated ? " · the search stopped early, so add a folder if yours is missing" : ""}</p>`;
}

function connectPlanHtml() {
  const tools = (w.clients || []).filter((c) => w.chosenTools.has(c.id));
  const repos = [...w.chosenRepos];
  const pathRow =
    w.desktopInfo?.packaged && !w.desktopInfo.path?.onPath
      ? `<label class="wz-check"><input type="checkbox" id="wzAddPath" checked /> Also let me type <code>amem</code> in a terminal <small>(adds ${esc(w.desktopInfo.path.dir)} to your PATH)</small></label>`
      : "";
  return `
    <h2>Ready to connect</h2>
    <p class="wz-sub">amem will add itself to each tool's settings and, in each project, to the instruction file that tool reads.</p>
    <div class="wz-summary">
      <div><h3>${tools.length} tool${tools.length === 1 ? "" : "s"}</h3><ul>${tools.map((t) => `<li>${esc(t.label)}</li>`).join("")}</ul></div>
      <div><h3>${repos.length} project${repos.length === 1 ? "" : "s"}</h3><ul>${
        repos.length ? repos.slice(0, 8).map((p) => `<li>${esc(p.split(/[\\/]/).pop())}</li>`).join("") : "<li class='muted'>None (shared memory only)</li>"
      }${repos.length > 8 ? `<li class="muted">and ${repos.length - 8} more</li>` : ""}</ul></div>
    </div>
    ${pathRow}`;
}

function connectRunHtml() {
  if (!w.result) return `<p class="wz-loading">Connecting…</p>`;
  const rows = w.result.steps.map(
    (s) => `<li class="${s.ok ? "ok" : "bad"}"><span class="wz-dot" aria-hidden="true">${s.ok ? "✓" : "!"}</span><span><b>${esc(s.label)}</b>${s.detail ? `<small>${esc(s.detail)}</small>` : ""}</span></li>`,
  );
  if (w.pathResult) {
    rows.push(
      `<li class="${w.pathResult.ok ? "ok" : "bad"}"><span class="wz-dot" aria-hidden="true">${w.pathResult.ok ? "✓" : "!"}</span><span><b>Add amem to your terminal</b><small>${esc(w.pathResult.detail)}</small></span></li>`,
    );
  }
  const failed = w.result.steps.filter((s) => !s.ok).length;
  return `
    <h2>${failed ? `Connected, with ${failed} problem${failed === 1 ? "" : "s"}` : "Everything is connected"}</h2>
    <p class="wz-sub">${failed ? "The rest worked. Fix what's marked, then run setup again from Settings." : "One last step on the next page."}</p>
    <ul class="wz-results">${rows.join("")}</ul>`;
}

function doneHtml() {
  const tools = (w.clients || []).filter((c) => w.chosenTools.has(c.id));
  return `
    <div class="wz-hero">
      <span class="wz-done-mark" aria-hidden="true">✓</span>
      <h1>You're set up</h1>
      <p class="wz-lead">Restart each tool once so it picks up amem:</p>
    </div>
    <ol class="wz-restart">${tools
      .map((t) => `<li><b>${esc(t.label)}</b><span>${esc(RESTART_HINT[t.id] || "Restart it.")}</span></li>`)
      .join("")}</ol>
    <div class="wz-try">
      <h3>Try it</h3>
      <p>In a project, ask your agent: <q>What do you remember about this project?</q> Then open <b>Activity</b> here to watch amem answer.</p>
    </div>`;
}

// ---------------------------------------------------------------------------
// Frame and navigation
// ---------------------------------------------------------------------------

function body() {
  switch (STEPS[w.step].id) {
    case "welcome":
      return welcomeHtml();
    case "tools":
      return toolsHtml();
    case "projects":
      return projectsHtml();
    case "connect":
      return w.applying || w.result ? connectRunHtml() : connectPlanHtml();
    default:
      return doneHtml();
  }
}

function footer() {
  const id = STEPS[w.step].id;
  const back = w.step > 0 && id !== "done" && !w.applying && !w.result ? `<button class="btn secondary" type="button" data-act="back">Back</button>` : "<span></span>";
  let next = "";
  if (id === "welcome") next = `<button class="btn" type="button" data-act="next">Get started</button>`;
  else if (id === "tools") next = `<button class="btn" type="button" data-act="next" ${w.chosenTools.size ? "" : "disabled"}>Continue</button>`;
  else if (id === "projects") {
    const none = needsProjects() && w.chosenRepos.size === 0;
    next = none
      ? `<button class="btn secondary" type="button" data-act="next">Skip for now</button>`
      : `<button class="btn" type="button" data-act="next">Continue</button>`;
  } else if (id === "connect") {
    next = w.result
      ? `<button class="btn" type="button" data-act="next">Continue</button>`
      : `<button class="btn" type="button" data-act="apply" ${w.applying ? "disabled" : ""}>${w.applying ? "Connecting…" : "Connect"}</button>`;
  } else {
    next = `<span class="wz-final"><button class="btn secondary" type="button" data-act="activity">Open Activity</button><button class="btn" type="button" data-act="finish">Go to amem</button></span>`;
  }
  return `${back}${next}`;
}

function render() {
  if (!w.root) return;
  const rail = STEPS.map(
    (s, i) => `<li class="${i < w.step ? "past" : i === w.step ? "now" : ""}"><span>${i < w.step ? "✓" : i + 1}</span>${esc(s.label)}</li>`,
  ).join("");
  w.root.innerHTML = `
    <div class="wz-shell" role="dialog" aria-modal="true" aria-labelledby="wzTitle">
      <aside class="wz-rail">
        <div class="wz-brand"><img src="/icon-64.png" alt="" width="24" height="24" /><span id="wzTitle">amem setup</span></div>
        <ol>${rail}</ol>
        ${STEPS[w.step].id !== "done" ? `<button class="linkish wz-skip" type="button" data-act="close">Set up later</button>` : ""}
      </aside>
      <section class="wz-main">
        <div class="wz-body">${body()}</div>
        <footer class="wz-foot">${footer()}</footer>
      </section>
    </div>`;
  const filter = w.root.querySelector("#wzFilter");
  if (filter && document.activeElement?.id !== "wzFilter" && w.filterFocus) {
    filter.focus();
    filter.setSelectionRange(filter.value.length, filter.value.length);
  }
}

async function loadTools() {
  if (w.clients) return;
  try {
    const { clients } = await api("GET", "/api/clients/detect");
    w.clients = clients;
    for (const c of clients) if (c.installed) w.chosenTools.add(c.id);
  } catch {
    w.clients = [];
  }
  render();
}

async function loadRepos() {
  if (w.repos) return;
  try {
    const scan = await api("GET", "/api/scan");
    w.repos = (scan.repos || []).slice().sort((a, b) => Number(Boolean(b.tracking)) - Number(Boolean(a.tracking)));
    w.scanTruncated = Boolean(scan.truncated);
    for (const r of w.repos) if (r.tracking) w.chosenRepos.add(r.path);
  } catch {
    w.repos = [];
  }
  render();
}

function addRepoPath(path) {
  const p = String(path || "").trim();
  if (!p) return;
  if (![...(w.repos || []), ...w.extraRepos].some((r) => r.path === p)) {
    w.extraRepos.push({ name: p.split(/[\\/]/).filter(Boolean).pop() || p, path: p });
  }
  w.chosenRepos.add(p);
  render();
}

async function apply() {
  w.applying = true;
  render();
  const wantPath = Boolean(w.root.querySelector("#wzAddPath")?.checked);
  try {
    w.result = await api("POST", "/api/setup/apply", {
      platforms: [...w.chosenTools],
      paths: needsProjects() ? [...w.chosenRepos] : [],
    });
  } catch (e) {
    w.result = { steps: [{ label: "Connect", ok: false, detail: e.message }], ok: false };
  }
  if (wantPath && desktop?.addToPath) {
    try {
      const status = await desktop.addToPath();
      w.pathResult = {
        ok: Boolean(status?.onPath),
        detail: status?.onPath ? "Open a new terminal window to use it." : "Could not update your shell profile.",
      };
    } catch (e) {
      w.pathResult = { ok: false, detail: e.message };
    }
  }
  w.applying = false;
  if (w.result.steps.every((s) => s.ok)) {
    try {
      localStorage.setItem(DONE_KEY, "1");
    } catch {
      /* private window */
    }
  }
  render();
}

function go(step) {
  w.step = Math.max(0, Math.min(STEPS.length - 1, step));
  render();
  const id = STEPS[w.step].id;
  if (id === "tools") loadTools();
  if (id === "projects" && needsProjects()) loadRepos();
  w.root?.querySelector(".wz-body")?.scrollTo(0, 0);
}

function close(target) {
  w.root?.remove();
  w.root = null;
  document.body.classList.remove("wz-open");
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    /* private window */
  }
  if (target) location.href = `/?tab=${target}`;
  else location.reload();
}

function onClick(e) {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  if (act === "next") go(w.step + 1);
  else if (act === "back") go(w.step - 1);
  else if (act === "apply") apply();
  else if (act === "toggle-tools") {
    w.showAllTools = !w.showAllTools;
    render();
  } else if (act === "pick-folder") {
    desktop.pickFolder().then((p) => p && addRepoPath(p));
  } else if (act === "add-path") {
    addRepoPath(w.root.querySelector("#wzAddPath")?.value);
  } else if (act === "close") close();
  else if (act === "finish") close("dashboard");
  else if (act === "activity") close("activity");
}

function onChange(e) {
  const t = e.target;
  if (t.dataset.tool) {
    if (t.checked) w.chosenTools.add(t.dataset.tool);
    else w.chosenTools.delete(t.dataset.tool);
    render();
  } else if (t.dataset.repo) {
    if (t.checked) w.chosenRepos.add(t.dataset.repo);
    else w.chosenRepos.delete(t.dataset.repo);
    render();
  }
}

function onInput(e) {
  if (e.target.id === "wzFilter") {
    w.filter = e.target.value;
    w.filterFocus = true;
    render();
  }
}

export async function openSetupWizard() {
  if (w.root) return;
  Object.assign(w, {
    step: 0,
    result: null,
    pathResult: null,
    applying: false,
    filter: "",
    filterFocus: false,
  });
  w.root = document.createElement("div");
  w.root.className = "wz-overlay";
  w.root.addEventListener("click", onClick);
  w.root.addEventListener("change", onChange);
  w.root.addEventListener("input", onInput);
  document.body.appendChild(w.root);
  document.body.classList.add("wz-open");
  if (desktop?.info) {
    desktop
      .info()
      .then((info) => {
        w.desktopInfo = info;
        render();
      })
      .catch(() => undefined);
  }
  render();
  loadTools();
}

/** First run: nothing set up yet and the wizard not finished or dismissed before. */
export async function maybeOpenSetupWizard() {
  try {
    if (localStorage.getItem(DONE_KEY) === "1") return;
  } catch {
    return;
  }
  if (new URLSearchParams(location.search).get("setup") === "0") return;
  try {
    const { repos } = await api("GET", "/api/repos");
    const real = (repos || []).filter((r) => r.kind !== "workspace" && !/^scratch-|^tmp$/i.test(String(r.repo_name || r.name || "")));
    if (real.length > 0) {
      localStorage.setItem(DONE_KEY, "1");
      return;
    }
  } catch {
    return;
  }
  openSetupWizard();
}

window.amemSetupWizard = { open: openSetupWizard };
