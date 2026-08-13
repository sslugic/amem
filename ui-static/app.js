const state = {
  tab: "setup",
  status: null,
  graph: null,
  usage: null,
  selected: new Set(["cursor"]),
  selectedNode: null,
  activeEventId: null,
  anim: 0,
};

async function api(path, options = {}) {
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

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  render();
}

async function refreshStatus() {
  state.status = await api("/api/status");
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
  state.usage = await api(`/api/usage?repo=${scope}&days=${days}`);
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
  const configured = Boolean(s?.setup?.setup_completed_at || s?.repo);
  const main = $("#main");

  if (!configured) {
    main.innerHTML = `
      <section class="hero">
        <div class="hero-inner">
          <h1>amem</h1>
          <p>Personal agent memory for this machine. Set up Cursor and/or Claude once — memory stays in ~/.amem and never leaves localhost.</p>
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
          <button class="btn" id="setupBtn">Set up this repo</button>
          <div class="stat-line" style="margin-top:1.5rem"><span>Detected repo</span><b>${s?.identity?.repoName || "—"}</b></div>
          <div class="stat-line"><span>Root</span><b style="font-size:0.85rem">${s?.identity?.rootPath || "—"}</b></div>
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
    $("#setupBtn").addEventListener("click", async () => {
      const platforms = [...state.selected];
      if (!platforms.length) return alert("Pick at least one platform");
      $("#setupBtn").disabled = true;
      $("#setupBtn").textContent = "Installing…";
      try {
        await api("/api/setup", {
          method: "POST",
          body: JSON.stringify({ platforms }),
        });
        await refreshStatus();
        render();
      } catch (e) {
        alert(e.message);
        $("#setupBtn").disabled = false;
        $("#setupBtn").textContent = "Set up this repo";
      }
    });
    return;
  }

  const issues = s.doctor || [];
  main.innerHTML = `
    <section class="hero">
      <div class="hero-inner">
        <h1>amem</h1>
        <p>Configured for personal local memory. Seed a baseline map, then query from your agents with <code>amem context</code>.</p>
        <div class="status-grid">
          <div class="stat-line"><span>Repo</span><b>${s.repo?.repo_name}</b></div>
          <div class="stat-line"><span>DB</span><b>${s.dbPath}</b></div>
          <div class="stat-line"><span>Claims</span><b>${s.counts?.claims ?? 0}</b></div>
          <div class="stat-line"><span>Flows</span><b>${s.counts?.flows ?? 0}</b></div>
          <div class="stat-line"><span>Components</span><b>${s.counts?.components ?? 0}</b></div>
        </div>
        ${issues.length ? `<div class="issues">${issues.map((i) => `• ${i}`).join("<br/>")}</div>` : `<div class="note">Doctor: ok</div>`}
        <div class="bootstrap">
          <label class="note">Bootstrap proposal (applied only to local DB)</label>
          <textarea id="proposal">${defaultProposal()}</textarea>
          <div class="actions">
            <button class="btn" id="applyBootstrap">Apply bootstrap</button>
            <button class="btn secondary" id="reinstall">Re-run install</button>
            <button class="btn secondary" id="openBrain">Open brain</button>
          </div>
        </div>
      </div>
    </section>`;

  $("#applyBootstrap").addEventListener("click", async () => {
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
  $("#reinstall").addEventListener("click", async () => {
    const platforms = state.selected.size
      ? [...state.selected]
      : s.repo?.platform
        ? [s.repo.platform]
        : ["cursor"];
    await api("/api/setup", { method: "POST", body: JSON.stringify({ platforms }) });
    await refreshStatus();
    alert("Install refreshed.");
    render();
  });
  $("#openBrain").addEventListener("click", () => setTab("brain"));
}

function renderBrain() {
  const main = $("#main");
  if (!state.status?.repo) {
    main.innerHTML = `<section class="hero"><div class="hero-inner"><h1>amem</h1><p>Finish setup before viewing the brain.</p><button class="btn" id="toSetup">Go to setup</button></div></section>`;
    $("#toSetup").onclick = () => setTab("setup");
    return;
  }
  main.innerHTML = `
    <div class="brain-layout">
      <div class="brain-stage">
        <canvas id="graph"></canvas>
        <div class="timeline" id="timeline"></div>
      </div>
      <aside class="drawer" id="drawer">
        <h2>Memory brain</h2>
        <div class="meta">Click a node. Recent context hits highlight in teal.</div>
      </aside>
    </div>`;
  drawTimeline();
  startGraph();
}

function drawTimeline() {
  const el = $("#timeline");
  if (!el || !state.graph) return;
  const events = state.graph.recentEvents || [];
  el.innerHTML = events
    .slice(0, 12)
    .map(
      (e) =>
        `<button data-event="${e.id}" class="${state.activeEventId === e.id ? "active" : ""}">${e.created_at.slice(5, 16)} · ${e.platform} · ~${e.estimated_tokens_saved}</button>`,
    )
    .join("");
  el.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      state.activeEventId = b.dataset.event;
      const ev = events.find((x) => x.id === state.activeEventId);
      if (ev) {
        try {
          state.graph.recentClaimIds = JSON.parse(ev.claim_ids);
        } catch {
          state.graph.recentClaimIds = [];
        }
      }
      drawTimeline();
      state.anim++;
    });
  });
}

function startGraph() {
  const canvas = $("#graph");
  if (!canvas || !state.graph) return;
  const ctx = canvas.getContext("2d");
  const g = state.graph;
  const nodes = [];
  const links = [];

  for (const c of g.components) {
    nodes.push({
      id: c.id,
      type: "component",
      label: c.name,
      detail: c,
      x: Math.random() * 800,
      y: Math.random() * 600,
      vx: 0,
      vy: 0,
    });
  }
  for (const f of g.flows) {
    nodes.push({
      id: f.id,
      type: "flow",
      label: f.name,
      detail: f,
      x: Math.random() * 800,
      y: Math.random() * 600,
      vx: 0,
      vy: 0,
    });
  }
  for (const c of g.claims) {
    nodes.push({
      id: c.id,
      type: "claim",
      label: c.id.replace(/^claim\./, ""),
      detail: c,
      x: Math.random() * 800,
      y: Math.random() * 600,
      vx: 0,
      vy: 0,
    });
  }
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  for (const e of g.edges) {
    if (byId[e.from_id] && byId[e.to_id]) {
      links.push({ source: byId[e.from_id], target: byId[e.to_id] });
    }
  }

  let selected = null;
  let drag = null;

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * devicePixelRatio;
    canvas.height = rect.height * devicePixelRatio;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  function color(type, hot) {
    if (hot) return "#2ec4b6";
    if (type === "claim") return "#7eb8ff";
    if (type === "flow") return "#2ec4b6";
    return "#c4a46b";
  }

  function tick() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const hot = new Set(g.recentClaimIds || []);

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy) || 1;
        const force = 1200 / (dist * dist);
        dx = (dx / dist) * force;
        dy = (dy / dist) * force;
        a.vx += dx;
        a.vy += dy;
        b.vx -= dx;
        b.vy -= dy;
      }
    }
    for (const l of links) {
      const dx = l.target.x - l.source.x;
      const dy = l.target.y - l.source.y;
      const dist = Math.hypot(dx, dy) || 1;
      const force = (dist - 120) * 0.02;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      l.source.vx += fx;
      l.source.vy += fy;
      l.target.vx -= fx;
      l.target.vy -= fy;
    }
    for (const n of nodes) {
      n.vx += (w / 2 - n.x) * 0.002;
      n.vy += (h / 2 - n.y) * 0.002;
      n.vx *= 0.85;
      n.vy *= 0.85;
      if (drag !== n) {
        n.x += n.vx;
        n.y += n.vy;
      }
    }

    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(232,238,242,0.15)";
    ctx.lineWidth = 1;
    for (const l of links) {
      ctx.beginPath();
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
      ctx.stroke();
    }
    for (const n of nodes) {
      const isHot = hot.has(n.id) || (n.type !== "claim" && links.some((l) => hot.has(l.source.id) || hot.has(l.target.id)) && (links.some((l) => (l.source === n || l.target === n) && (hot.has(l.source.id) || hot.has(l.target.id)))));
      const r = n.type === "claim" ? 8 : n.type === "flow" ? 10 : 12;
      ctx.beginPath();
      ctx.fillStyle = color(n.type, hot.has(n.id));
      ctx.globalAlpha = hot.size && !hot.has(n.id) && n.type === "claim" ? 0.35 : 1;
      ctx.arc(n.x, n.y, r + (hot.has(n.id) ? 2 : 0), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#e8eef2";
      ctx.font = "12px IBM Plex Sans, sans-serif";
      ctx.fillText(n.label.slice(0, 28), n.x + r + 4, n.y + 4);
      if (selected === n) {
        ctx.strokeStyle = "#2ec4b6";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  function pick(x, y) {
    return nodes.find((n) => Math.hypot(n.x - x, n.y - y) < 14);
  }

  canvas.addEventListener("pointerdown", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const n = pick(ev.clientX - rect.left, ev.clientY - rect.top);
    if (n) {
      selected = n;
      drag = n;
      showDrawer(n);
    }
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    drag.x = ev.clientX - rect.left;
    drag.y = ev.clientY - rect.top;
  });
  window.addEventListener("pointerup", () => {
    drag = null;
  });
}

function showDrawer(node) {
  const drawer = $("#drawer");
  if (!drawer) return;
  const d = node.detail;
  let body = "";
  if (node.type === "claim") {
    let anchors = [];
    try {
      anchors = JSON.parse(d.code_anchors);
    } catch {
      anchors = [];
    }
    body = `<p>${d.text}</p><div class="meta">Kind: ${d.kind}</div><div class="meta">Anchors: ${anchors.map((a) => `<code>${a}</code>`).join(", ") || "—"}</div>`;
  } else if (node.type === "flow") {
    body = `<p>${d.name}</p>`;
  } else {
    body = `<p>${d.name}</p><div class="meta">Anchor: ${d.code_anchor || "—"}</div>`;
  }
  drawer.innerHTML = `<h2>${node.id}</h2><div class="meta">${node.type}</div>${body}`;
}

function renderStats() {
  const main = $("#main");
  if (!state.status?.repo) {
    main.innerHTML = `<section class="hero"><div class="hero-inner"><h1>amem</h1><p>Finish setup to see savings stats.</p></div></section>`;
    return;
  }
  const agg = state.usage?.aggregate;
  main.innerHTML = `
    <section class="stats-page">
      <h1>Token savings</h1>
      <p class="sub">Estimates from each <code>amem context</code> hit. Not a provider bill.</p>
      <div class="filters">
        <select id="scope">
          <option value="current">This repo</option>
          <option value="all">All local repos</option>
        </select>
        <select id="days">
          <option value="7">7 days</option>
          <option value="30" selected>30 days</option>
          <option value="90">90 days</option>
        </select>
      </div>
      <div class="platform-cards" id="cards"></div>
      <div class="chart-wrap">
        <h2>Estimated tokens saved by day</h2>
        <canvas id="savingsChart"></canvas>
      </div>
      <p class="note">Formula: max(0, anchors×4000 + claims×200 − packet tokens). Optional agent overlays appear when reported.</p>
    </section>`;

  const cards = $("#cards");
  const platforms = agg?.byPlatform?.length
    ? agg.byPlatform
    : [{ platform: "—", queries: 0, estimatedTokensSaved: 0, reportedTokensSaved: 0 }];
  cards.innerHTML = `
    <div class="platform-card"><div class="label">Total estimated</div><div class="value">${agg?.totals?.estimatedTokensSaved ?? 0}</div><div class="meta">${agg?.totals?.queries ?? 0} queries</div></div>
    ${platforms
      .map(
        (p) => `<div class="platform-card"><div class="label">${p.platform}</div><div class="value">${p.estimatedTokensSaved}</div><div class="meta">${p.queries} queries${p.reportedTokensSaved ? ` · reported ${p.reportedTokensSaved}` : ""}</div></div>`,
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
    ctx.fillText("No usage yet — run amem context from an agent.", 16, 32);
    return;
  }
  const max = Math.max(...days.map((d) => d.estimatedTokensSaved), 1);
  const pad = 32;
  ctx.strokeStyle = "rgba(232,238,242,0.12)";
  ctx.beginPath();
  ctx.moveTo(pad, pad);
  ctx.lineTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();
  const bw = (w - pad * 2) / days.length;
  days.forEach((d, i) => {
    const bh = ((h - pad * 2) * d.estimatedTokensSaved) / max;
    const x = pad + i * bw + 4;
    const y = h - pad - bh;
    ctx.fillStyle = "#2ec4b6";
    ctx.fillRect(x, y, Math.max(bw - 8, 2), bh);
  });
}

async function render() {
  if (state.tab === "setup") {
    await refreshStatus();
    renderSetup();
  } else if (state.tab === "brain") {
    await refreshStatus();
    await refreshGraph();
    renderBrain();
  } else {
    await refreshStatus();
    await refreshUsage("current", 30);
    renderStats();
  }
}

document.querySelectorAll(".tabs button").forEach((b) => {
  b.addEventListener("click", () => setTab(b.dataset.tab));
});

refreshStatus().then(render).catch((e) => {
  $("#main").innerHTML = `<section class="hero"><div class="hero-inner"><h1>amem</h1><p>${e.message}</p></div></section>`;
});
