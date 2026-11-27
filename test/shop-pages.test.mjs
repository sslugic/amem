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

test("homepage is the full landing: hero, primitives, features, comparison, setup, FAQ", async () => {
  await withShop(async (port) => {
    const { status, text } = await get(port, "/");
    assert.equal(status, 200);
    assert.match(text, /100% Local • Zero Cloud • Single SQLite File/);
    assert.match(text, /Stop paying your AI agent to re-learn your codebase every session\./);
    assert.match(text, /npx @iamem\/amem setup/);
    assert.match(text, /amem ui/);
    // Dashboard preview: facts, review queue, task board.
    // The hero shows the 60-second explainer (it replaced the static dashboard mock).
    assert.match(text, /<video id="explainer"[^>]*autoplay/);
    assert.match(text, /\/public\/amem-explainer\.mp4/);
    assert.match(text, /poster="\/public\/amem-explainer\.jpg"/);
    assert.match(text, /Backlog<\/h4>[\s\S]*Done<\/h4>/);
    // Three primitives.
    assert.match(text, /File-anchored facts, with automatic staleness detection/);
    assert.match(text, /On-demand skills/);
    assert.match(text, /Cross-agent task board/);
    // Comparison table with sources.
    assert.match(text, /<table class="cmp">/);
    for (const row of ["Price", "Data privacy", "Stale-fact detection", "Cross-IDE support", "Setup overhead", "Visual UI"]) {
      assert.match(text, new RegExp(`<th scope="row">${row}</th>`));
    }
    assert.match(text, /Mem0, Supermemory/);
    assert.match(text, /claude-mem/);
    assert.match(text, /Basic Memory/);
    assert.match(text, /href="https:\/\/mem0\.ai\/pricing"/);
    // Per-client setup tabs, each with its own copy target.
    for (const id of ["claude", "cursor", "codex", "copilot", "windsurf", "json"]) {
      assert.match(text, new RegExp(`data-cmd="${id}"`));
      assert.match(text, new RegExp(`id="setup-${id}"`));
    }
    assert.match(text, /"args": \["-y", "@iamem\/amem", "mcp"\]/);
    assert.match(text, /docs\/CLIENTS\.md/, "links the per-app setup guide");
    // FAQ.
    assert.match(text, /Does anything leave my machine\?/);
    assert.match(text, /Do I need Ollama or OpenAI keys\?/);
    assert.match(text, /amem uninstall --yes/);
    assert.match(text, /href="\/features"/);
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

test("fact sheet page is in the nav and linked from the landing comparison", async () => {
  await withShop(async (port) => {
    const page = await get(port, "/fact-sheet");
    assert.equal(page.status, 200);
    assert.match(page.text, /amem: architecture and token savings/);
    assert.match(page.text, /nav-tab active" href="\/fact-sheet"/);
    for (const h of ["1. What amem does", "2. How it works", "3. Cost and token economics"]) assert.match(page.text, new RegExp(h));
    assert.match(page.text, /18 MCP tools ≈ 2,800 tokens/);
    assert.match(page.text, /4 · A stable, cacheable tool prefix/);
    const home = await get(port, "/");
    assert.match(home.text, /href="\/fact-sheet"/);
  });
});

test("landing setup has one-click installs that decode to the amem MCP entry", async () => {
  await withShop(async (port) => {
    const { text } = await get(port, "/");
    const entry = { command: "npx", args: ["-y", "@iamem/amem@latest", "mcp"] };
    const cursor = /cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=amem&amp;config=([A-Za-z0-9+/=]+)|cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=amem&config=([A-Za-z0-9+/=]+)/.exec(text);
    assert.ok(cursor, "Add to Cursor link");
    assert.deepEqual(JSON.parse(Buffer.from(cursor[1] ?? cursor[2], "base64").toString()), entry);
    const lm = /lmstudio:\/\/add_mcp\?name=amem&(?:amp;)?config=([^"]+)"/.exec(text);
    assert.deepEqual(JSON.parse(Buffer.from(decodeURIComponent(lm[1]), "base64").toString()), entry);
    const vs = /vscode:mcp\/install\?([^"]+)"/.exec(text);
    assert.deepEqual(JSON.parse(decodeURIComponent(vs[1])), { name: "amem", ...entry });
    assert.match(text, /releases\/latest\/download\/amem\.mcpb/);
    assert.match(text, /\/plugin marketplace add sslugic\/amem/);
    assert.match(text, /codex plugin marketplace add sslugic\/amem/);
    assert.match(text, /gemini extensions install https:\/\/github\.com\/sslugic\/amem/);
  });
});
