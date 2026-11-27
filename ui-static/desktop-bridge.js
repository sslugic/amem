/**
 * Desktop-only parts of the dashboard: the "update ready" banner and the App card in
 * Settings. Does nothing in a normal browser, where window.amemDesktop is not defined.
 */

const desktop = window.amemDesktop;

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let info = null;
let update = { state: "idle" };
const cards = new Set();

function updateLine() {
  switch (update.state) {
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return `Downloading amem ${esc(update.version || "")}${update.percent ? ` (${update.percent}%)` : ""}…`;
    case "ready":
      return `amem ${esc(update.version)} is ready to install.`;
    case "current":
      return "You have the latest version.";
    case "error":
      return `Couldn't check for updates: ${esc(update.message || "unknown error")}`;
    case "disabled":
      return `Updates are off (${esc(update.reason || "")}).`;
    default:
      return "Checks for updates every few hours.";
  }
}

function paintBanner() {
  let bar = document.getElementById("desktopUpdateBar");
  if (update.state !== "ready") {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "desktopUpdateBar";
    bar.className = "desk-update-bar";
    bar.setAttribute("role", "status");
    document.querySelector(".app-main")?.prepend(bar);
  }
  bar.innerHTML = `
    <span><b>amem ${esc(update.version)} is ready.</b> Restart to update; it takes a few seconds.</span>
    <span class="desk-update-actions">
      <button class="btn small secondary" type="button" data-desk="later">Later</button>
      <button class="btn small" type="button" data-desk="restart">Restart to update</button>
    </span>`;
}

function cardHtml() {
  if (!info) return `<p class="note">Loading…</p>`;
  const others = info.otherInstalls || [];
  const terminal = info.path?.onPath
    ? `<span class="pill ok">On</span> Type <code>amem</code> in a new terminal window.`
    : `<button class="btn small secondary" type="button" data-desk="path">Add amem to my terminal</button> <span class="note">Adds ${esc(info.path?.dir || "")} to your PATH.</span>`;
  return `
    <dl class="desk-facts">
      <div><dt>Version</dt><dd>amem ${esc(info.version)}</dd></div>
      <div><dt>Updates</dt><dd>${updateLine()}</dd></div>
    </dl>
    <div class="desk-row">
      ${
        update.state === "ready"
          ? `<button class="btn small" type="button" data-desk="restart">Restart to update</button>`
          : `<button class="btn small secondary" type="button" data-desk="check" ${update.state === "disabled" ? "disabled" : ""}>Check for updates</button>`
      }
      <label class="desk-toggle"><input type="checkbox" data-desk="auto" ${info.autoInstall ? "checked" : ""} /> Install updates automatically when I quit amem</label>
    </div>
    <div class="desk-row">${info.packaged ? terminal : `<span class="note">Running from an npm install; update with <code>npm i -g @iamem/amem</code>.</span>`}</div>
    ${
      others.length
        ? `<p class="note desk-warn">Another amem is also installed (${others.map((p) => `<code>${esc(p)}</code>`).join(", ")}). A terminal may run that one instead of the app's. Remove it with <code>npm uninstall -g @iamem/amem</code> if you no longer need it.</p>`
        : ""
    }`;
}

function paintCards() {
  for (const el of cards) {
    if (!el.isConnected) {
      cards.delete(el);
      continue;
    }
    el.innerHTML = cardHtml();
  }
}

async function refresh() {
  try {
    info = await desktop.info();
    if (info.update) update = info.update;
  } catch {
    /* window closing */
  }
  paintCards();
  paintBanner();
}

async function onClick(e) {
  const el = e.target.closest("[data-desk]");
  if (!el || el.tagName === "INPUT") return;
  const act = el.dataset.desk;
  if (act === "restart") await desktop.installUpdate();
  else if (act === "later") document.getElementById("desktopUpdateBar")?.remove();
  else if (act === "check") {
    update = { state: "checking" };
    paintCards();
    update = (await desktop.checkForUpdates()) || update;
    paintCards();
  } else if (act === "path") {
    await desktop.addToPath();
    await refresh();
  }
}

async function onChange(e) {
  if (e.target.dataset?.desk === "auto") {
    const on = await desktop.setAutoInstall(e.target.checked);
    if (info) info.autoInstall = on;
  }
}

/** Settings calls this with an empty element to show the App card there. */
export function mountDesktopCard(el) {
  if (!desktop || !el) return false;
  cards.add(el);
  el.innerHTML = cardHtml();
  refresh();
  return true;
}

if (desktop) {
  document.addEventListener("click", onClick);
  document.addEventListener("change", onChange);
  desktop.onUpdateStatus((state) => {
    update = state;
    paintCards();
    paintBanner();
  });
  refresh();
}

window.amemDesktopUi = { mountCard: mountDesktopCard, available: Boolean(desktop) };
