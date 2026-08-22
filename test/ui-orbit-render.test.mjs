/**
 * Orbit renders on a real code path, not just in a browser. These drive createOrbitViz
 * against a recording 2D context so the grouping/label/sizing regressions we actually
 * shipped (every repo merged into one README node, an unbounded canvas that painted
 * nothing, a dead context showing a broken panel) fail here instead of on screen.
 */
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./helpers.mjs";

let createOrbitViz;

/**
 * The viz drives itself with requestAnimationFrame. Queue the callbacks instead of
 * running them so a test can paint an exact number of frames and then inspect.
 */
let pending = [];

function flushFrame() {
  const next = pending.shift();
  if (next) next();
}

/** start() only queues the first frame; render it so there is something to assert on. */
function startAndPaint(viz) {
  viz.start();
  flushFrame();
}

function recordingContext() {
  const calls = { fillText: [], arc: [], fillRect: [], setTransform: [] };
  const noop = () => {};
  return {
    calls,
    ctx: {
      canvas: null,
      setTransform: (...a) => calls.setTransform.push(a),
      clearRect: noop,
      fillRect: (...a) => calls.fillRect.push(a),
      fillText: (text, x, y) => calls.fillText.push({ text: String(text), x, y }),
      strokeText: noop,
      beginPath: noop,
      closePath: noop,
      moveTo: noop,
      lineTo: noop,
      arc: (x, y, r) => calls.arc.push({ x, y, r }),
      fill: noop,
      stroke: noop,
      save: noop,
      restore: noop,
      measureText: (t) => ({ width: String(t).length * 6 }),
      createRadialGradient: () => ({ addColorStop: noop }),
      createLinearGradient: () => ({ addColorStop: noop }),
      set fillStyle(_v) {},
      set strokeStyle(_v) {},
      set lineWidth(_v) {},
      set font(_v) {},
      set textAlign(_v) {},
      set textBaseline(_v) {},
      set globalAlpha(_v) {},
      set shadowBlur(_v) {},
      set shadowColor(_v) {},
    },
  };
}

function fakeCanvas({ clientWidth = 800, clientHeight = 420, dead = false } = {}) {
  const rec = recordingContext();
  const listeners = new Map();
  const canvas = {
    width: 0,
    height: 0,
    clientWidth,
    clientHeight,
    calls: rec.calls,
    getContext: () => (dead ? null : rec.ctx),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: clientWidth, height: clientHeight }),
    addEventListener: (type, fn) => listeners.set(type, fn),
    emit: (type, event) => listeners.get(type)?.(event),
  };
  rec.ctx.canvas = canvas;
  return canvas;
}

/** Labels painted this frame, minus the legend/center chrome. */
const labels = (canvas) => canvas.calls.fillText.map((f) => f.text);

const claim = (id, group, groupLabel, sub, extra = {}) => ({
  id,
  status: "active",
  text: `fact ${id}`,
  _group: group,
  _groupLabel: groupLabel,
  _sub: sub,
  _subLabel: sub,
  ...extra,
});

describe("Orbit rendering", () => {
  before(async () => {
    ({ createOrbitViz } = await import(`file://${join(root, "ui-static", "orbit.js")}`));
  });

  beforeEach(() => {
    globalThis.window = { devicePixelRatio: 1 };
    pending = [];
    globalThis.requestAnimationFrame = (fn) => pending.push(fn);
    globalThis.cancelAnimationFrame = () => {
      pending = [];
    };
  });

  afterEach(() => {
    delete globalThis.window;
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  });

  it("keeps every memory as its own node instead of merging on README.md", () => {
    const canvas = fakeCanvas();
    const viz = createOrbitViz(canvas, {});
    // The shipped bug: three repos, each anchoring facts to README.md, collapsed into
    // one ring node. Grouping is on the memory id, so all three must survive.
    viz.setData({
      claims: [
        claim("a1", "repo-alpha", "alpha", "README.md"),
        claim("a2", "repo-alpha", "alpha", "README.md"),
        claim("b1", "repo-beta", "beta", "README.md"),
        claim("c1", "repo-gamma", "gamma", "README.md"),
      ],
      ringLabel: "memories",
      label: "All memory",
    });
    startAndPaint(viz);

    const painted = labels(canvas);
    for (const memory of ["alpha", "beta", "gamma"]) {
      assert.ok(painted.includes(memory), `Orbit dropped memory "${memory}": ${painted.join(" | ")}`);
    }
    assert.ok(canvas.calls.arc.length >= 3, "each memory needs its own ring node");
    viz.stop();
  });

  it("labels a topic anchor as a tag and a path as a file", () => {
    const canvas = fakeCanvas();
    const viz = createOrbitViz(canvas, {});
    viz.setData({
      claims: [
        claim("t1", "hollywood", null, null),
        claim("f1", "src/api/routes.ts", null, null),
      ],
      label: "workspace",
    });
    startAndPaint(viz);

    const painted = labels(canvas);
    // "hollywood" is a topic tag from `amem remember`, not a file — don't render it as one.
    assert.ok(painted.includes("#hollywood"), `expected a #tag, got ${painted.join(" | ")}`);
    assert.ok(painted.includes("api/routes.ts"), "a real path should show its last two segments");
    assert.equal(painted.includes("#src/api/routes.ts"), false);
    viz.stop();
  });

  it("clamps a runaway host box instead of painting into the void", () => {
    // The layout bug handed Orbit a 73,000px tall host; a canvas past the browser max
    // silently renders nothing at all.
    const canvas = fakeCanvas({ clientWidth: 90000, clientHeight: 73000 });
    const viz = createOrbitViz(canvas, {});
    viz.setData({ claims: [claim("a1", "repo-alpha", "alpha", "README.md")] });
    startAndPaint(viz);

    assert.ok(canvas.width > 0 && canvas.height > 0, "canvas must be sized");
    assert.ok(canvas.width <= 2400, `width ${canvas.width} exceeds the clamp`);
    assert.ok(canvas.height <= 2400, `height ${canvas.height} exceeds the clamp`);
    viz.stop();
  });

  it("falls back to a sane box when the host has no layout yet", () => {
    const canvas = fakeCanvas({ clientWidth: 0, clientHeight: 0 });
    const viz = createOrbitViz(canvas, {});
    viz.setData({ claims: [claim("a1", "repo-alpha", "alpha", "README.md")] });
    startAndPaint(viz);
    assert.equal(canvas.width, 640);
    assert.equal(canvas.height, 360);
    viz.stop();
  });

  it("throws a real error when the browser gives no 2D context", () => {
    const canvas = fakeCanvas({ dead: true });
    const viz = createOrbitViz(canvas, {});
    viz.setData({ claims: [claim("a1", "repo-alpha", "alpha", "README.md")] });
    // app.js catches this to show a message; silently returning is what produced the
    // "broken image" panel the user reported.
    assert.throws(() => viz.start(), /2D canvas/);
  });

  it("says so plainly when there is nothing to show", () => {
    const canvas = fakeCanvas();
    const viz = createOrbitViz(canvas, {});
    viz.setData({ claims: [] });
    startAndPaint(viz);
    assert.ok(
      labels(canvas).some((t) => /No facts to orbit yet/.test(t)),
      "an empty orbit must explain itself rather than render a blank panel",
    );
    viz.stop();
  });

  it("drops non-active claims from the ring", () => {
    const canvas = fakeCanvas();
    const viz = createOrbitViz(canvas, {});
    viz.setData({
      claims: [
        claim("a1", "repo-alpha", "alpha", "README.md"),
        claim("z1", "repo-zombie", "zombie", "README.md", { status: "retracted" }),
      ],
    });
    startAndPaint(viz);
    const painted = labels(canvas);
    assert.ok(painted.includes("alpha"));
    assert.equal(painted.includes("zombie"), false, "retracted facts must not orbit");
    viz.stop();
  });

  it("reports the memory, not the raw file, when a ring node is clicked", () => {
    const canvas = fakeCanvas();
    const picked = [];
    const viz = createOrbitViz(canvas, { onSelectGroup: (node) => picked.push(node) });
    viz.setData({
      claims: [claim("a1", "repo-alpha", "alpha", "README.md")],
      ringLabel: "memories",
    });
    startAndPaint(viz);

    // Click the single ring node: one memory at angle -PI/2 sits directly above centre.
    const w = 800;
    const h = 420;
    const R = Math.min(w, h) * 0.32;
    canvas.emit("pointerup", { clientX: w / 2, clientY: h / 2 + 6 - R });

    assert.equal(picked.length, 1, "clicking a memory must call onSelectGroup");
    assert.equal(picked[0].id, "repo-alpha");
    viz.stop();
  });

  it("stops painting after stop(), even if a frame was already in flight", () => {
    const canvas = fakeCanvas();
    const viz = createOrbitViz(canvas, {});
    viz.setData({ claims: [claim("a1", "repo-alpha", "alpha", "README.md")] });
    startAndPaint(viz);

    const painted = canvas.calls.fillText.length;
    assert.ok(painted > 0, "precondition: the first frame drew something");
    assert.equal(pending.length, 1, "a running viz keeps the loop alive");

    // Grab the queued callback before stop() cancels it: a frame already scheduled by
    // the browser still fires, and must no-op rather than paint over a torn-down tab.
    const inFlight = pending[0];
    viz.stop();
    inFlight();
    assert.equal(canvas.calls.fillText.length, painted, "a stopped viz must not repaint");

    viz.stop(); // idempotent
    assert.equal(canvas.calls.fillText.length, painted);
  });
});

describe("Blocks + Orbit wiring in app.js", () => {
  const app = readFileSync(join(root, "ui-static", "app.js"), "utf8");

  it("offers exactly the three shipped views, once each", () => {
    for (const mode of ["map", "orbit", "blocks"]) {
      assert.ok(app.includes(`"${mode}"`), `missing viz mode ${mode}`);
    }
    // The removed 3D graph must not creep back via a stale toggle or import.
    assert.equal(app.includes("createNeuralViz"), false, "neural viz was removed");
    assert.doesNotMatch(app, /neural\.js/, "no stale neural import");
  });

  it("clamps the Blocks treemap the same way Orbit clamps its canvas", () => {
    assert.match(app, /Math\.min\(2400,/, "blocks width must be clamped");
    assert.match(app, /Math\.min\(1400,/, "blocks height must be clamped");
  });
});
