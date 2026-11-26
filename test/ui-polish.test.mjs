import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const js = readFileSync(new URL("../ui-static/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../ui-static/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../ui-static/styles.css", import.meta.url), "utf8");

function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("polish", () => {
  it("has a Cmd/Ctrl+K command palette over pages, scopes, facts, tasks and skills", () => {
    assert.match(html, /id="cmdk"/);
    assert.match(html, /id="cmdkInput"/);
    assert.match(js, /\(e\.metaKey \|\| e\.ctrlKey\)[^\n]*e\.key\.toLowerCase\(\) === "k"/);
    const results = js.slice(js.indexOf("function paletteResults("), js.indexOf("async function paletteLoadData("));
    for (const type of ['"Scope"', '"Fact"', '"Task"', '"Skill"']) assert.match(results, new RegExp(type));
    assert.match(js, /type: "Page"/);
  });

  it("keeps scheduling and re-locking as secondary buttons", () => {
    assert.match(js, /scheduleBtn\.classList\.add\("secondary"\)/);
    assert.match(js, /lockBtn\.classList\.toggle\("secondary", lock !== "plain"\)/);
  });

  it("dim and muted text meet WCAG AA on the dark cards", () => {
    const dim = css.match(/--dim:\s*(#[0-9a-f]{6})/gi).pop().split(":")[1].trim();
    const muted = css.match(/--muted:\s*(#[0-9a-f]{6})/gi).pop().split(":")[1].trim();
    for (const bg of ["#0b0f15", "#131924", "#171f2c", "#182031"]) {
      assert.ok(contrast(dim, bg) >= 4.5, `--dim ${dim} on ${bg}`);
      assert.ok(contrast(muted, bg) >= 4.5, `--muted ${muted} on ${bg}`);
    }
  });

  it("empty lists point to a next step", () => {
    assert.match(js, /No open tasks\. Agents park follow-ups here/);
    assert.match(js, /Drag a task here to start\./);
    assert.doesNotMatch(js, /<p class="empty">No open tasks\.<\/p>/);
  });
});
