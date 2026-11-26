import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../ui-static/index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../ui-static/app.js", import.meta.url), "utf8");

function fnBody(name) {
  const start = js.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = js.indexOf("\nfunction ", start + 10);
  const nextAsync = js.indexOf("\nasync function ", start + 10);
  const end = Math.min(...[next, nextAsync].filter((n) => n > 0));
  return js.slice(start, end);
}

describe("dashboard shell", () => {
  it("every sidebar item is a real tab (no fake scroll/scope buttons)", () => {
    assert.doesNotMatch(html, /id="vaultToggle"/);
    assert.doesNotMatch(html, /id="personalBtn"/);
    assert.doesNotMatch(html, /data-href=/);
    assert.match(html, /data-tab="activity"/);
  });

  it("a tab change swaps the page and resets scroll before data loads", () => {
    const setTab = fnBody("setTab");
    assert.match(setTab, /clearPageForTab\(tab\)/);
    const clear = fnBody("clearPageForTab");
    assert.match(clear, /main\.innerHTML\s*=/);
    assert.match(clear, /resetScroll\(\)/);
  });

  it("a failed page render replaces the old page with an error", () => {
    const render = js.slice(js.indexOf("async function render()"), js.indexOf("async function renderTab()"));
    assert.match(render, /catch/);
    assert.match(render, /innerHTML/);
  });

  it("Activity renders inside the shell", () => {
    assert.match(fnBody("renderActivity"), /\/activity\?embed=1/);
  });

  it("Personal is a choice in the scope picker", () => {
    assert.match(js, /__personal__/);
  });

  it("the hits vs misses chart draws both series at full width", () => {
    const chart = fnBody("drawHitMissChart");
    assert.match(chart, /MISS_COLOR/);
    assert.match(chart, /serverTrips/);
    const css = readFileSync(new URL("../ui-static/styles.css", import.meta.url), "utf8");
    assert.match(css, /#hitMissChart\s*\{[^}]*width:\s*100%/);
  });
});
