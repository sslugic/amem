// Live Activity view: who is talking to amem, which way data flows, and what it saved.
// Reads only metadata from /api/activity*; never memory text or prompts.

const params = new URLSearchParams(location.search);
const compact = location.pathname.endsWith("/mini") || params.get("compact") === "1";
if (compact) document.body.classList.add("compact");
// Inside the dashboard shell (iframe on /?tab=activity) the shell owns the header and nav.
const embedded = params.get("embed") === "1";
if (embedded) document.body.classList.add("embed");

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const CLIENT_NAMES = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  codex: "Codex",
  cli: "CLI",
  windsurf: "Windsurf",
  vscode: "VS Code",
  gemini: "Gemini",
  zed: "Zed",
  cline: "Cline",
  mcp: "MCP client",
  "http-mcp": "HTTP MCP",
  unknown: "Unknown",
};

const ACTION_NAMES = {
  amem_context: "context packet",
  amem_recipe: "recipe",
  amem_remember: "remember",
  amem_supersede: "supersede",
  amem_repos: "list repos",
  amem_stats: "stats",
  amem_graph: "graph",
  amem_status: "status",
  amem_skill_list: "skill list",
  amem_skill_view: "skill view",
  amem_skill_save: "skill save",
  amem_task_list: "task list",
  amem_task_add: "task add",
  amem_task_update: "task update",
  amem_task_complete: "task complete",
  amem_usage_report: "usage report",
  "hook sessionStart": "session-start injection",
  "hook beforeSubmitPrompt": "prompt hook",
  "hook afterAgentResponse": "answer capture",
  "hook stop": "session checkpoint",
  "hook sessionEnd": "session end",
};

const state = {
  hours: 24,
  summary: null,
  lanes: new Map(), // key -> {client, channel, calls, in, out, errors, bytesOut, latencySum, lastSeen}
  feed: [],
  latestId: 0,
  es: null,
  refreshTimer: null,
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function laneKey(client, channel) {
  return `${client}|${channel}`;
}

function laneLabel(client, channel) {
  const name = CLIENT_NAMES[client] ?? client;
  if (channel === "hook") return `${name} hooks`;
  return name;
}

function actionLabel(a) {
  return ACTION_NAMES[a] ?? a;
}

function fmtNum(n) {
  n = Number(n) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function plural(n, word) {
  return Math.round(Number(n) || 0) === 1 ? word : `${word}s`;
}

function fmtBytes(b) {
  b = Number(b) || 0;
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function fmtAgo(ts) {
  if (!ts) return "—";
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// ---------- data ----------

function lanesFromSummary(summary) {
  const lanes = new Map();
  for (const c of summary.clients) {
    lanes.set(laneKey(c.client, c.channel), {
      client: c.client,
      channel: c.channel,
      calls: c.calls,
      in: c.in,
      out: c.out,
      errors: c.errors,
      bytesOut: c.bytesOut,
      latencySum: c.avgLatencyMs * c.calls,
      lastSeen: c.lastSeen,
    });
  }
  return lanes;
}

function applyEvent(e) {
  const key = laneKey(e.client, e.channel);
  let lane = state.lanes.get(key);
  const isNew = !lane;
  if (!lane) {
    lane = { client: e.client, channel: e.channel, calls: 0, in: 0, out: 0, errors: 0, bytesOut: 0, latencySum: 0, lastSeen: null };
    state.lanes.set(key, lane);
  }
  lane.calls += 1;
  if (e.direction === "in") lane.in += 1;
  else {
    lane.out += 1;
    lane.bytesOut += e.resultBytes;
  }
  if (!e.ok) lane.errors += 1;
  lane.latencySum += e.latencyMs;
  lane.lastSeen = e.ts;
  state.feed.unshift(e);
  state.feed.length = Math.min(state.feed.length, compact ? 12 : 60);
  state.latestId = Math.max(state.latestId, e.id);
  return isNew;
}

async function loadAll() {
  const [summary, recent] = await Promise.all([
    getJson(`/api/activity/summary?hours=${state.hours}`),
    getJson(`/api/activity?limit=${compact ? 12 : 60}`),
  ]);
  state.summary = summary;
  state.lanes = lanesFromSummary(summary);
  const since = new Date(Date.now() - state.hours * 3600_000).toISOString();
  state.feed = recent.events.filter((e) => e.ts >= since);
  state.latestId = Math.max(summary.latestId || 0, recent.latestId || 0);
  $("offNote").classList.toggle("hidden", summary.enabled !== false);
  renderAll();
}

// Savings come from usage events written elsewhere; refresh them lazily after activity.
function scheduleSummaryRefresh(delay = 4000) {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(async () => {
    state.refreshTimer = null;
    try {
      const summary = await getJson(`/api/activity/summary?hours=${state.hours}`);
      const before = [...state.lanes.keys()].sort().join(",");
      state.summary = summary;
      state.lanes = lanesFromSummary(summary);
      renderSavings();
      renderTotals();
      renderClients();
      if ([...state.lanes.keys()].sort().join(",") !== before) renderFlow();
      else updateFlowCounters();
    } catch {
      /* next event retries */
    }
  }, delay);
}

// ---------- rendering ----------

function renderAll() {
  renderFlow();
  renderTotals();
  renderSavings();
  renderClients();
  renderFeed();
}

function sortedLanes() {
  return [...state.lanes.values()].sort((a, b) => b.calls - a.calls || a.client.localeCompare(b.client));
}

let geometry = new Map(); // laneKey -> {path, node}

function renderFlow() {
  const svg = $("flow");
  const lanes = sortedLanes().slice(0, compact ? 6 : 10);
  $("flowEmpty").classList.toggle("hidden", lanes.length > 0);
  const W = compact ? 340 : 640;
  const rowH = compact ? 42 : 54;
  const H = Math.max(compact ? 150 : 220, lanes.length * rowH + 30);
  const nodeW = compact ? 146 : 170;
  const nodeH = compact ? 32 : 40;
  const nodeX = 8;
  const hubX = W - (compact ? 52 : 90);
  const hubY = H / 2;
  const hubR = compact ? 32 : 46;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = "";
  geometry = new Map();

  const top = (H - lanes.length * rowH) / 2 + (rowH - nodeH) / 2;
  lanes.forEach((lane, i) => {
    const y = top + i * rowH;
    const sx = nodeX + nodeW;
    const sy = y + nodeH / 2;
    const ex = hubX - hubR;
    const midX = (sx + ex) / 2;
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", `M ${sx} ${sy} C ${midX} ${sy}, ${midX} ${hubY}, ${ex} ${hubY}`);
    path.setAttribute("class", "lane");
    svg.appendChild(path);

    const g = document.createElementNS(SVG, "g");
    g.setAttribute("class", "node");
    g.innerHTML = `
      <rect x="${nodeX}" y="${y}" width="${nodeW}" height="${nodeH}" rx="8"></rect>
      <text x="${nodeX + 10}" y="${y + (compact ? 14 : 17)}">${esc(laneLabel(lane.client, lane.channel))}</text>
      <text class="sub" x="${nodeX + 10}" y="${y + (compact ? 27 : 32)}">${esc(lane.channel)} · ${fmtNum(lane.in)} in · ${fmtNum(lane.out)} out</text>`;
    svg.appendChild(g);
    geometry.set(laneKey(lane.client, lane.channel), { path, node: g });
  });

  const hub = document.createElementNS(SVG, "g");
  hub.setAttribute("class", "hub");
  const total = state.summary?.totals?.calls ?? 0;
  hub.innerHTML = `
    <circle cx="${hubX}" cy="${hubY}" r="${hubR}"></circle>
    <text x="${hubX}" y="${hubY + 2}">amem</text>
    <text class="sub" x="${hubX}" y="${hubY + 17}">${fmtNum(total)} calls</text>`;
  svg.appendChild(hub);
}

function updateFlowCounters() {
  for (const [key, g] of geometry) {
    const lane = state.lanes.get(key);
    const sub = g.node.querySelector(".sub");
    if (lane && sub) sub.textContent = `${lane.channel} · ${fmtNum(lane.in)} in · ${fmtNum(lane.out)} out`;
  }
  const hubSub = $("flow").querySelector(".hub .sub");
  if (hubSub) hubSub.textContent = `${fmtNum(state.summary?.totals?.calls ?? 0)} calls`;
}

function pulse(e) {
  const g = geometry.get(laneKey(e.client, e.channel));
  if (!g || reduceMotion) return;
  const svg = $("flow");
  const len = g.path.getTotalLength();
  const dot = document.createElementNS(SVG, "circle");
  dot.setAttribute("r", compact ? "3.5" : "4.5");
  dot.setAttribute("class", `pulse ${e.ok ? e.direction : "err"}`);
  svg.appendChild(dot);
  g.path.classList.add("hot");
  g.node.classList.add("flash");
  const dur = 900;
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const at = e.direction === "in" ? ease : 1 - ease;
    const pt = g.path.getPointAtLength(at * len);
    dot.setAttribute("cx", pt.x);
    dot.setAttribute("cy", pt.y);
    dot.setAttribute("opacity", String(p > 0.85 ? (1 - p) / 0.15 : 1));
    if (p < 1) requestAnimationFrame(step);
    else {
      dot.remove();
      g.path.classList.remove("hot");
      g.node.classList.remove("flash");
    }
  };
  requestAnimationFrame(step);
}

function renderTotals() {
  let calls = 0, inn = 0, out = 0, errors = 0;
  for (const l of state.lanes.values()) {
    calls += l.calls;
    inn += l.in;
    out += l.out;
    errors += l.errors;
  }
  $("totals").innerHTML = `
    <div class="stat"><b>${fmtNum(calls)}</b><span>calls</span></div>
    <div class="stat in"><b>${fmtNum(inn)}</b><span>into amem</span></div>
    <div class="stat out"><b>${fmtNum(out)}</b><span>context out</span></div>
    <div class="stat err"><b>${fmtNum(errors)}</b><span>errors</span></div>`;
}

function renderSavings() {
  const s = state.summary?.savings;
  const el = $("savings");
  if (!s) {
    el.innerHTML = "";
    return;
  }
  const m = s.measured;
  $("basis").textContent = `${fmtNum(m.attestedEvents)} of ${fmtNum(s.packets)} packets measured`;
  $("basis").title =
    "Measured packets are ones where the agent reported which files it still opened. The rest only have the estimate.";
  const measured =
    m.attestedEvents > 0
      ? `<div class="save-big">${fmtNum(m.tokensSaved)}<small>tokens saved, measured</small></div>
         <div class="save-row">
           <span><b>${fmtNum(m.fileReadsAvoided)}</b> ${plural(m.fileReadsAvoided, "file read")} avoided</span>
           <span><b>${fmtNum(m.fileReadsStillOpened)}</b> still opened</span>
         </div>`
      : `<p class="muted small">No measured savings in this window yet. They appear when an agent reports which files it still opened (<code>amem_usage_report</code>, or the session-end transcript check).</p>`;
  el.innerHTML = `
    ${measured}
    <div class="save-est">
      <b>~${fmtNum(s.estimate.tokensSaved)}</b> tokens across <b>${fmtNum(s.packets)}</b> ${plural(s.packets, "context packet")}
      <span class="tag-est" title="${esc(s.estimate.note)}">estimate</span>
    </div>
    ${compact ? "" : `<p class="save-foot">Measured = real size of files the agent did not open, minus the packet's own cost. The estimate uses typical file sizes. amem does not time your agent, so there is no speed figure here.</p>`}`;
}

function renderClients() {
  const rows = sortedLanes();
  $("clientRows").innerHTML = rows.length
    ? rows
        .map(
          (l) => `<tr>
        <td>${esc(laneLabel(l.client, l.channel))}${compact ? "" : `<span class="chan">${esc(l.channel)}</span>`}</td>
        <td>${fmtNum(l.calls)}</td>
        <td class="in">${fmtNum(l.in)}</td>
        <td class="out">${fmtNum(l.out)}</td>
        <td class="${l.errors ? "err" : ""}">${fmtNum(l.errors)}</td>
        <td>${fmtBytes(l.bytesOut)}</td>
        <td>${l.calls ? Math.round(l.latencySum / l.calls) : 0} ms</td>
        <td title="${esc(l.lastSeen ?? "")}">${fmtAgo(l.lastSeen)}</td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="8" class="muted">No clients yet.</td></tr>`;
}

function feedRow(e, isNew) {
  const dir = e.ok ? e.direction : "err";
  const arrow = !e.ok ? "✕ error" : e.direction === "in" ? "→ in" : "← out";
  return `<li class="${isNew ? "new" : ""}">
    <span class="t">${esc(fmtTime(e.ts))}</span>
    <span class="c">${esc(laneLabel(e.client, e.channel))}</span>
    <span class="a" title="${esc(e.action)}">${esc(actionLabel(e.action))}</span>
    <span class="d ${dir}">${arrow}</span>
    <span class="m">${e.resultBytes ? fmtBytes(e.resultBytes) + " · " : ""}${e.latencyMs} ms</span>
  </li>`;
}

function renderFeed(newIds = new Set()) {
  $("feed").innerHTML = state.feed.length
    ? state.feed.map((e) => feedRow(e, newIds.has(e.id))).join("")
    : `<li class="muted">Waiting for the first call…</li>`;
}

// ---------- live stream ----------

function setLive(s) {
  const el = $("live");
  el.dataset.state = s;
  el.querySelector("span").textContent = { live: "live", connecting: "connecting", down: "reconnecting" }[s] ?? s;
}

function connect() {
  state.es?.close();
  const es = new EventSource(`/api/activity/stream?since=${state.latestId}`);
  state.es = es;
  es.addEventListener("hello", () => setLive("live"));
  es.addEventListener("open", () => setLive("live"));
  es.addEventListener("error", () => setLive("down"));
  let batch = [];
  let flushQueued = false;
  es.addEventListener("activity", (msg) => {
    let e;
    try {
      e = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (e.id <= state.latestId) return;
    batch.push(e);
    if (flushQueued) return;
    flushQueued = true;
    requestAnimationFrame(() => {
      flushQueued = false;
      const events = batch;
      batch = [];
      let laneAdded = false;
      for (const ev of events) laneAdded = applyEvent(ev) || laneAdded;
      if (state.summary) state.summary.totals.calls += events.length;
      // A new lane needs a new layout; otherwise update counters in place so pulses
      // already in flight are not wiped.
      if (laneAdded) renderFlow();
      else updateFlowCounters();
      renderTotals();
      renderClients();
      renderFeed(new Set(events.map((ev) => ev.id)));
      for (const ev of events.slice(-8)) pulse(ev);
      if (events.some((ev) => ev.action === "amem_context" || ev.action === "amem_usage_report" || ev.channel === "hook")) {
        scheduleSummaryRefresh();
      }
    });
  });
}

// ---------- controls ----------

$("window").addEventListener("change", async (ev) => {
  state.hours = Number(ev.target.value) || 24;
  try {
    localStorage.setItem("amem.activity.hours", String(state.hours));
  } catch {
    /* storage blocked */
  }
  await loadAll();
});

$("panelBtn").addEventListener("click", () => {
  window.open("/activity/mini", "amem-activity", "popup,width=380,height=720");
});

// "x ago" labels drift; refresh them quietly.
setInterval(renderClients, 15_000);

(async function init() {
  try {
    const saved = Number(localStorage.getItem("amem.activity.hours"));
    if ([1, 24, 168].includes(saved)) state.hours = saved;
  } catch {
    /* storage blocked */
  }
  $("window").value = String(state.hours);
  try {
    await loadAll();
  } catch (err) {
    setLive("down");
    $("feed").innerHTML = `<li class="muted">Could not load activity: ${esc(err.message)}</li>`;
  }
  connect();
})();
