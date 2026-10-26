import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { root } from "./helpers.mjs";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

async function withShop(fn) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(root, "shop", "server.mjs")], {
    env: {
      ...process.env,
      AMEM_SHOP_PORT: String(port),
      AMEM_SHOP_HOST: "127.0.0.1",
      AMEM_SHOP_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("shop did not start")), 8000);
    const onData = (buf) => {
      if (String(buf).includes("listening")) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
  });
  try {
    await ready;
    await fn(port);
  } finally {
    child.kill("SIGTERM");
  }
}

async function get(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" });
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get("location") };
}

test("homepage is the install hero with links to the other tabs", async () => {
  await withShop(async (port) => {
    const { status, text } = await get(port, "/");
    assert.equal(status, 200);
    assert.match(text, /Everything is free/);
    assert.match(text, /npx @iamem\/amem setup/);
    assert.match(text, /hero-full/);
    assert.match(text, /href="\/features"/);
    assert.match(text, /href="\/why"/);
    assert.match(text, /href="\/what"/);
    // Details live on their own tabs, not on the front page.
    assert.doesNotMatch(text, /Everything in the box<\/p>\s*<h2>/);
    assert.doesNotMatch(text, /<form class="calc"/);
  });
});

test("features tab lists what amem includes", async () => {
  await withShop(async (port) => {
    const { status, text } = await get(port, "/features");
    assert.equal(status, 200);
    assert.match(text, /Memory that sticks/);
    assert.match(text, /Skills: how you do it here/);
    assert.match(text, /Tasks that outlive the chat/);
    assert.match(text, /amem_context/);
    assert.match(text, /nav-tab active" href="\/features"/);
  });
});

test("why tab covers developer benefits and the cost calculator", async () => {
  await withShop(async (port) => {
    const { status, text } = await get(port, "/why");
    assert.equal(status, 200);
    assert.match(text, /For developers/);
    assert.match(text, /Time, speed, money/);
    assert.match(text, /<form class="calc"/);
  });
});

test("how-it-works page covers problems, a day with amem and privacy", async () => {
  await withShop(async (port) => {
    const { status, text } = await get(port, "/what");
    assert.equal(status, 200);
    assert.match(text, /How amem works/);
    assert.match(text, /Without it/);
    assert.match(text, /How a day goes/);
    assert.match(text, /Never leaves|localhost|~\/\.amem/);
    assert.doesNotMatch(text, /What you get/);
  });
});
