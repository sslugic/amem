/**
 * Orbit map — readable hub-and-spoke view of local memory.
 * Center = scope, inner ring = groups, outer dots = what sits inside the focused group.
 *
 * The caller decides what a ring node means by tagging each claim with `_group`
 * (inner ring) and optionally `_sub` (outer ring). Across all memories the ring is
 * one node per memory, because every repo anchors most facts to README.md and
 * grouping on the raw path would merge them into a single meaningless blob.
 */

function shortFile(path) {
  const parts = String(path || "").split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return path || "?";
  return parts.slice(-2).join("/");
}

// `amem remember` writes topic tags into code_anchors alongside real paths, so a
// node like "hollywood" is a tag, not a file. Mark it as one instead of lying.
function isPathish(name) {
  return /[/\\]/.test(String(name)) || /\.[a-z0-9]{1,6}$/i.test(String(name));
}

function nodeLabel(name) {
  const raw = String(name || "?");
  if (raw.startsWith("(")) return raw;
  return isPathish(raw) ? shortFile(raw) : `#${raw}`;
}

function groupClaims(claims) {
  const map = new Map();
  for (const c of claims || []) {
    if ((c.status || "active") !== "active") continue;
    const key = c._group || "(unsorted)";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  return [...map.entries()]
    .map(([id, items]) => ({
      id,
      // A caller-supplied label is shown verbatim; otherwise the id is a path or tag.
      label: items[0]?._groupLabel || null,
      items,
      used: items.some((c) => Number(c._hot || 0) > 0),
      pinned: items.some((c) => Number(c.pinned || 0) > 0),
    }))
    .sort((a, b) => b.items.length - a.items.length);
}

function subGroups(items) {
  const map = new Map();
  for (const c of items) {
    const key = c._sub || "(unanchored)";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  return [...map.entries()]
    .map(([id, list]) => ({
      id,
      label: list[0]?._subLabel || null,
      count: list.length,
      pinned: list.some((c) => Number(c.pinned || 0) > 0),
      hot: list.some((c) => Number(c._hot || 0) > 0),
    }))
    .sort((a, b) => b.count - a.count);
}

const MAX_GROUPS = 18;
const MAX_SPOKES = 12;
const MAX_CANVAS = 2400;

export function createOrbitViz(canvas, opts = {}) {
  const onSelectFile = opts.onSelectFile || (() => {});
  const onSelectClaim = opts.onSelectClaim || (() => {});
  const onSelectGroup = opts.onSelectGroup || null;
  let files = [];
  let totalGroups = 0;
  let totalFacts = 0;
  let ringNoun = "files";
  let focusFile = null;
  let selectedClaimId = null;
  let recentIds = new Set();
  let centerLabel = "memory";
  let running = false;
  let raf = 0;
  let hover = null; // { type, id }
  let pointer = { x: -9999, y: -9999 };
  let t0 = performance.now();

  function setData({ claims, recentClaimIds, selectedFile, selectedClaim, label, ringLabel }) {
    recentIds = new Set(recentClaimIds || []);
    const tagged = (claims || []).map((c) => ({
      ...c,
      _hot: recentIds.has(c.id) ? 1 : 0,
    }));
    const all = groupClaims(tagged);
    totalGroups = all.length;
    totalFacts = tagged.length;
    ringNoun = ringLabel || "files";
    files = all.slice(0, MAX_GROUPS);
    // A node picked outside Orbit may sit past the ring cutoff — pull it in.
    if (selectedFile && !files.some((f) => f.id === selectedFile)) {
      const extra = all.find((f) => f.id === selectedFile);
      if (extra) files = [extra, ...files.slice(0, MAX_GROUPS - 1)];
    }
    focusFile = selectedFile && files.some((f) => f.id === selectedFile) ? selectedFile : null;
    selectedClaimId = selectedClaim || null;
    centerLabel = label || "memory";
  }

  function layout(w, h) {
    const cx = w / 2;
    const cy = h / 2 + 6;
    const R = Math.min(w, h) * 0.32;
    const n = Math.max(files.length, 1);
    return files.map((f, i) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      return {
        ...f,
        a,
        x: cx + Math.cos(a) * R,
        y: cy + Math.sin(a) * R,
        r: Math.min(28, 10 + Math.sqrt(f.items.length) * 5),
      };
    });
  }

  function factOrbit(focus, cx, cy, w, h) {
    if (!focus) return [];
    const hasSubs = focus.items.some((c) => c._sub);
    const spokes = hasSubs
      ? subGroups(focus.items).slice(0, MAX_SPOKES)
      : focus.items.slice(0, MAX_SPOKES).map((c) => ({ claim: c, pinned: Number(c.pinned || 0) > 0 }));
    const R = Math.min(w, h) * 0.46;
    return spokes.map((s, i) => {
      const a = focus.a - 0.55 + (spokes.length <= 1 ? 0 : (i / (spokes.length - 1 || 1)) * 1.1);
      return {
        ...s,
        x: cx + Math.cos(a) * R,
        y: cy + Math.sin(a) * R,
        r: s.claim ? (s.pinned ? 7 : 5.5) : Math.min(11, 5 + Math.sqrt(s.count) * 2),
      };
    });
  }

  function paint() {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    // A canvas past the browser's max dimension silently renders nothing, so never
    // trust the layout to hand back a sane box.
    const w = Math.min(canvas.clientWidth || 640, MAX_CANVAS);
    const h = Math.min(canvas.clientHeight || 360, MAX_CANVAS);
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2 + 6;
    const pulse = 0.5 + 0.5 * Math.sin((performance.now() - t0) / 900);

    // soft field
    const g = ctx.createRadialGradient(cx, cy, 8, cx, cy, Math.max(w, h) * 0.48);
    g.addColorStop(0, "rgba(46,196,182,0.1)");
    g.addColorStop(0.55, "rgba(10,16,22,0.05)");
    g.addColorStop(1, "rgba(6,10,14,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    if (!files.length) {
      ctx.fillStyle = "#8fa3b0";
      ctx.font = "500 14px 'IBM Plex Sans', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No facts to orbit yet — approve a capture or bootstrap on Setup.", cx, cy);
      return;
    }

    const nodes = layout(w, h);
    const focus = nodes.find((n) => n.id === focusFile) || null;
    const facts = factOrbit(focus, cx, cy, w, h);

    // spokes
    for (const n of nodes) {
      const active = focus && n.id === focus.id;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(n.x, n.y);
      ctx.strokeStyle = active
        ? "rgba(94,224,212,0.55)"
        : n.used
          ? "rgba(46,196,182,0.28)"
          : "rgba(140,180,200,0.14)";
      ctx.lineWidth = active ? 2 : 1;
      ctx.stroke();
    }

    // fact links from focused file
    if (focus) {
      for (const f of facts) {
        ctx.beginPath();
        ctx.moveTo(focus.x, focus.y);
        ctx.lineTo(f.x, f.y);
        ctx.strokeStyle = "rgba(230,180,80,0.28)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // center hub
    ctx.beginPath();
    ctx.fillStyle = "rgba(20, 28, 34, 0.95)";
    ctx.strokeStyle = `rgba(94,224,212,${0.45 + pulse * 0.25})`;
    ctx.lineWidth = 2;
    ctx.arc(cx, cy, 36, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#e8eef2";
    ctx.font = "600 12px 'IBM Plex Sans', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const hub = String(centerLabel).slice(0, 16);
    ctx.fillText(hub, cx, cy - 8);
    ctx.fillStyle = "#8fa3b0";
    ctx.font = "500 10px 'IBM Plex Sans', system-ui, sans-serif";
    ctx.fillText(`${totalFacts} facts`, cx, cy + 8);
    ctx.fillText(
      totalGroups > files.length
        ? `${files.length}/${totalGroups} ${ringNoun}`
        : `${totalGroups} ${ringNoun}`,
      cx,
      cy + 20,
    );

    hover = null;

    // file nodes
    for (const n of nodes) {
      const dx = pointer.x - n.x;
      const dy = pointer.y - n.y;
      const over = dx * dx + dy * dy <= (n.r + 6) ** 2;
      if (over) hover = { type: "group", id: n.id, node: n };
      const active = focus && n.id === focus.id;
      ctx.beginPath();
      ctx.fillStyle = n.pinned
        ? "rgba(230,180,80,0.92)"
        : n.used
          ? "rgba(46,196,182,0.9)"
          : "rgba(120,150,170,0.75)";
      ctx.arc(n.x, n.y, n.r + (active || over ? 2 : 0), 0, Math.PI * 2);
      ctx.fill();
      if (active || over) {
        ctx.strokeStyle = "rgba(232,238,242,0.85)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.fillStyle = over || active ? "#e8eef2" : "#8fa3b0";
      ctx.font = `${active || over ? 600 : 500} 11px 'IBM Plex Sans', system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(n.label || nodeLabel(n.id), n.x, n.y + n.r + 6);
      ctx.fillStyle = "#8fa3b0";
      ctx.font = "500 10px 'IBM Plex Sans', system-ui, sans-serif";
      ctx.fillText(`${n.items.length}`, n.x, n.y + n.r + 20);
    }

    // outer ring: individual facts inside a file, or the files inside a memory
    for (const f of facts) {
      const dx = pointer.x - f.x;
      const dy = pointer.y - f.y;
      const over = dx * dx + dy * dy <= (f.r + 5) ** 2;
      if (over) hover = { type: f.claim ? "claim" : "sub", id: f.claim ? f.claim.id : f.id, node: f };
      const sel = f.claim ? f.claim.id === selectedClaimId : f.id === selectedClaimId;
      ctx.beginPath();
      ctx.fillStyle = f.pinned
        ? "rgba(230,180,80,0.95)"
        : (f.claim ? recentIds.has(f.claim.id) : f.hot)
          ? "rgba(94,224,212,0.95)"
          : "rgba(180,200,210,0.85)";
      ctx.arc(f.x, f.y, f.r + (over || sel ? 1.5 : 0), 0, Math.PI * 2);
      ctx.fill();
      if (over || sel) {
        ctx.strokeStyle = "#e8eef2";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (!f.claim) {
        ctx.fillStyle = over ? "#e8eef2" : "#8fa3b0";
        ctx.font = `${over ? 600 : 500} 10px 'IBM Plex Sans', system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(`${f.label || nodeLabel(f.id)} · ${f.count}`, f.x, f.y + f.r + 5);
      }
    }

    if (hover?.type === "claim" || hover?.type === "sub") {
      const text =
        hover.type === "claim"
          ? String(hover.node.claim.text || hover.id).slice(0, 64)
          : `${hover.node.label || hover.id} · ${hover.node.count} fact${hover.node.count === 1 ? "" : "s"}`;
      ctx.font = "600 12px 'IBM Plex Sans', system-ui, sans-serif";
      const tw = ctx.measureText(text).width;
      const pad = 8;
      const bx = Math.min(Math.max(8, hover.node.x - tw / 2 - pad), w - tw - pad * 2 - 8);
      const by = Math.max(8, hover.node.y - 28);
      ctx.fillStyle = "rgba(8,12,16,0.9)";
      ctx.strokeStyle = "rgba(120,200,180,0.35)";
      ctx.lineWidth = 1;
      roundRect(ctx, bx, by, tw + pad * 2, 22, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#e8eef2";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(text, bx + pad, by + 15);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function frame() {
    if (!running) return;
    paint();
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    // Surface a dead canvas as an error instead of leaving an empty dark panel.
    if (typeof canvas.getContext !== "function" || !canvas.getContext("2d")) {
      throw new Error("this browser did not give Orbit a 2D canvas");
    }
    running = true;
    t0 = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  });
  canvas.addEventListener("pointerleave", () => {
    pointer = { x: -9999, y: -9999 };
    hover = null;
  });
  canvas.addEventListener("pointerup", (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    paint();
    if (!hover) return;
    if (hover.type === "group") {
      focusFile = hover.id;
      if (onSelectGroup) onSelectGroup(hover.node);
      else onSelectFile(hover.id);
    } else if (hover.type === "sub") {
      onSelectFile(hover.id);
    } else if (hover.type === "claim") {
      selectedClaimId = hover.id;
      onSelectClaim(hover.node.claim);
    }
  });

  return {
    setData,
    start,
    stop,
    setFocus(file) {
      focusFile = file;
    },
    setSelectedClaim(id) {
      selectedClaimId = id;
    },
  };
}
