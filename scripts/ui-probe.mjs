/**
 * Local-only debugging aid: drive the amem UI in headless Chrome over CDP and
 * report console errors, a screenshot, and whatever state we ask for.
 *
 *   node scripts/ui-probe.mjs "http://127.0.0.1:7843/?tab=brain&scope=all" /tmp/shot.png
 *
 * Chrome's --screenshot/--dump-dom wait for network idle, which never happens
 * while the UI polls, so this talks to the page directly instead.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const URL_ARG = process.argv[2] || "http://127.0.0.1:7843/?tab=brain&scope=all";
const SHOT = process.argv[3] || "/tmp/amem-ui.png";
const EVAL = process.argv[4] || "null";
const PORT = 9333;

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const build = existsSync(cache)
    ? readdirSync(cache)
        .filter((d) => d.startsWith("chromium-"))
        .sort()
        .pop()
    : null;
  if (build) {
    const p = join(
      cache,
      build,
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    );
    if (existsSync(p)) return p;
  }
  return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}

const CHROME = findChrome();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    `--remote-debugging-port=${PORT}`,
    "--user-data-dir=/tmp/amem-probe-profile",
    "--window-size=1500,950",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let ws;
let nextId = 0;
const pending = new Map();
const consoleErrors = [];

function send(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => pending.has(id) && reject(new Error(`${method} timed out`)), 20000);
  });
}

async function main() {
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === "page");
    } catch {
      /* chrome still booting */
    }
  }
  if (!target) throw new Error("chrome never exposed a page target");

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      consoleErrors.push(`EXCEPTION: ${d.exception?.description || d.text}`);
    }
    if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
      consoleErrors.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      consoleErrors.push(`log: ${msg.params.entry.text} ${msg.params.entry.url || ""}`);
    }
  });

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Page.navigate", { url: URL_ARG });
  await sleep(6000);

  const evaled = await send("Runtime.evaluate", {
    expression: EVAL,
    returnByValue: true,
    awaitPromise: true,
  });

  // Give any click in EVAL time to re-render before the shot.
  await sleep(2500);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(SHOT, Buffer.from(shot.data, "base64"));

  console.log("=== console errors ===");
  console.log(consoleErrors.length ? consoleErrors.join("\n") : "(none)");
  console.log("=== evaluated ===");
  console.log(JSON.stringify(evaled.result?.value ?? evaled.result?.description ?? null, null, 2));
  console.log("=== screenshot ===");
  console.log(SHOT);
}

main()
  .catch((e) => {
    console.error("probe failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    chrome.kill("SIGKILL");
  });
