import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./helpers.mjs";

describe("brand icon", () => {
  it("dashboard and activity pages link the amem icon and ship the files", () => {
    for (const page of ["index.html", "activity.html"]) {
      const html = readFileSync(join(root, "ui-static", page), "utf8");
      assert.match(html, /rel="icon"[^>]*href="\/favicon-32\.png"/, page);
      assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon\.png"/, page);
    }
    assert.match(readFileSync(join(root, "ui-static", "index.html"), "utf8"), /class="brand-icon" src="\/icon-64\.png"/);
    for (const f of ["icon-64.png", "favicon-32.png", "apple-touch-icon.png"]) {
      assert.ok(existsSync(join(root, "ui-static", f)), `ui-static/${f}`);
      assert.ok(existsSync(join(root, "shop", "public", f)), `shop/public/${f}`);
    }
    assert.match(readFileSync(join(root, "src", "ui", "server.ts"), "utf8"), /"\.png": "image\/png"/);
  });

  it("the site header and every page head use the icon", () => {
    const shop = readFileSync(join(root, "shop", "server.mjs"), "utf8");
    assert.match(shop, /<link rel="icon" type="image\/png" sizes="32x32" href="\/public\/favicon-32\.png"\/>/);
    assert.match(shop, /<a class="brand" href="\/"><img class="brand-icon" src="\/public\/icon-64\.png"/);
  });
});
