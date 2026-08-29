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

test("homepage keeps the install hero and adds a click-to-pause slideshow", async () => {
  await withShop(async (port) => {
    const { status, text } = await get(port, "/");
    assert.equal(status, 200);
    assert.match(text, /Everything is free/);
    assert.match(text, /npx @iamem\/amem setup/);
    assert.match(text, /data-show/);
    assert.match(text, /Agents forget\. amem does not/);
    assert.match(text, /href="\/what"/);
    assert.match(text, /What it does/);
  });
});

test("what-it-does page covers problems and the main features", async () => {
  await withShop(async (port) => {
    const { status, text } = await get(port, "/what");
    assert.equal(status, 200);
    assert.match(text, /What amem actually does/);
    assert.match(text, /Without it/);
    assert.match(text, />Memory</);
    assert.match(text, />Skills</);
    assert.match(text, />Tasks</);
    assert.match(text, /Never leaves|localhost|~\/\.amem/);
    assert.match(text, /amem_context/);
    const alias = await get(port, "/features");
    assert.equal(alias.status, 302);
    assert.equal(alias.location, "/what");
  });
});
