/**
 * amem desktop app.
 *
 * Two ways to run:
 * - Installed app (app.isPackaged): amem ships inside the app under resources/amem. The app
 *   writes a small `amem` launcher to ~/.amem/bin that runs that copy with the app's own
 *   runtime (ELECTRON_RUN_AS_NODE), so nobody needs Node or npm. Hooks, MCP configs and
 *   background jobs all point at that launcher. The app starts the dashboard server itself
 *   and updates itself from GitHub releases, asking before it restarts.
 * - `amem app` from an npm install: a thin window over the dashboard the CLI already started
 *   (AMEM_UI_URL). No launcher, no updater.
 *
 * The renderer never gets Node. The few things it needs from the desktop (version, updates,
 * adding amem to the terminal PATH, picking a folder) go through preload.js, and only for
 * pages served by the local dashboard.
 *
 * macOS note: BrowserWindow `icon` does not change the Dock for an unpackaged
 * Electron.app. We must call app.dock.setIcon() with a PNG (icns often loads empty).
 */
const { app, BrowserWindow, nativeImage, ipcMain, shell, dialog, Notification } = require("electron");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PORT = 7843;
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

/** Set once the dashboard is reachable; IPC is only answered for pages from this origin. */
let uiOrigin = null;
/** The dashboard server this app started (null when one was already running). */
let serverChild = null;
let mainWindow = null;
let updateState = { state: "idle" };

// ---------------------------------------------------------------------------
// Bundled amem and its launcher
// ---------------------------------------------------------------------------

function bundledRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, "amem") : path.join(__dirname, "..");
}

/**
 * Where the launcher finds amem. An AppImage runs from a temporary mount that is gone once
 * the app quits, so for AppImages the bundled amem is copied to ~/.amem/app/<version> and
 * the launcher runs the AppImage file itself.
 */
let stableRoot = null;
function amemRoot() {
  if (stableRoot) return stableRoot;
  if (!process.env.APPIMAGE) return (stableRoot = bundledRoot());
  const dest = path.join(os.homedir(), ".amem", "app", app.getVersion());
  if (!fs.existsSync(path.join(dest, "dist", "cli.js"))) {
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(bundledRoot(), tmp, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    // Older copies are no longer referenced once the launcher is rewritten below.
    for (const old of fs.readdirSync(path.dirname(dest))) {
      if (old !== path.basename(dest)) fs.rmSync(path.join(path.dirname(dest), old), { recursive: true, force: true });
    }
  }
  return (stableRoot = dest);
}

/** The executable the launcher runs: the AppImage file, not its temporary mount. */
function appExecutable() {
  return process.env.APPIMAGE || process.execPath;
}

function cliPath() {
  return path.join(amemRoot(), "dist", "cli.js");
}

function shimDir() {
  return path.join(os.homedir(), ".amem", "bin");
}

function shimPath() {
  return path.join(shimDir(), process.platform === "win32" ? "amem.cmd" : "amem");
}

function shimContent() {
  const exe = appExecutable();
  const cli = cliPath();
  const shim = shimPath();
  if (process.platform === "win32") {
    return [
      "@echo off",
      "rem Written by the amem app. Runs the amem bundled in the app; reopen the app to repair it.",
      "set ELECTRON_RUN_AS_NODE=1",
      `set "AMEM_SHIM=${shim}"`,
      `"${exe}" "${cli}" %*`,
      "",
    ].join("\r\n");
  }
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "# Written by the amem app. Runs the amem bundled in the app; reopen the app to repair it.",
    `APP=${q(exe)}`,
    'if [ ! -x "$APP" ]; then',
    '  echo "amem: the amem app is no longer at $APP. Open the app once to repair this command." >&2',
    "  exit 127",
    "fi",
    `ELECTRON_RUN_AS_NODE=1 AMEM_SHIM=${q(shim)} exec "$APP" ${q(cli)} "$@"`,
    "",
  ].join("\n");
}

/** Write (or refresh) the launcher. Rewritten on every start, so moving the app heals it. */
function ensureShim() {
  const target = shimPath();
  const content = shimContent();
  fs.mkdirSync(shimDir(), { recursive: true });
  let current = null;
  try {
    current = fs.readFileSync(target, "utf8");
  } catch {
    current = null;
  }
  if (current !== content) {
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, { mode: 0o755 });
    fs.renameSync(tmp, target);
  }
  if (process.platform !== "win32") fs.chmodSync(target, 0o755);
  return target;
}

function amemEnv() {
  return { ...process.env, ELECTRON_RUN_AS_NODE: "1", AMEM_SHIM: shimPath() };
}

// ---------------------------------------------------------------------------
// Terminal PATH
// ---------------------------------------------------------------------------

const PATH_MARKER = "# Added by the amem app";

function shellProfiles() {
  const home = os.homedir();
  const shellName = path.basename(process.env.SHELL || "");
  const files = [];
  if (shellName === "zsh" || process.platform === "darwin") files.push(path.join(home, ".zshrc"));
  if (shellName === "bash" || fs.existsSync(path.join(home, ".bashrc"))) files.push(path.join(home, ".bashrc"));
  if (shellName === "fish") files.push(path.join(home, ".config", "fish", "config.fish"));
  return [...new Set(files)];
}

function windowsUserPath() {
  try {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "";
  }
}

function pathStatus() {
  const dir = shimDir();
  if (process.platform === "win32") {
    const parts = windowsUserPath().split(";").map((p) => p.trim().toLowerCase());
    return { onPath: parts.includes(dir.toLowerCase()), dir, files: [] };
  }
  const files = shellProfiles().filter((f) => {
    try {
      return fs.readFileSync(f, "utf8").includes(PATH_MARKER);
    } catch {
      return false;
    }
  });
  return { onPath: files.length > 0, dir, files };
}

function addToPath() {
  const dir = shimDir();
  if (process.platform === "win32") {
    const current = windowsUserPath();
    if (current.toLowerCase().split(";").includes(dir.toLowerCase())) return pathStatus();
    const next = current ? `${current};${dir}` : dir;
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `[Environment]::SetEnvironmentVariable('Path', ${JSON.stringify(next)}, 'User')`,
    ]);
    return pathStatus();
  }
  for (const file of shellProfiles()) {
    let body = "";
    try {
      body = fs.readFileSync(file, "utf8");
    } catch {
      body = "";
    }
    if (body.includes(PATH_MARKER)) continue;
    const line = file.endsWith("config.fish")
      ? `fish_add_path -g ${JSON.stringify(dir)}`
      : `export PATH="${dir}:$PATH"`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${body.endsWith("\n") || !body ? "" : "\n"}\n${PATH_MARKER}\n${line}\n`);
  }
  return pathStatus();
}

/** Other amem installs (npm, Homebrew) that a terminal would find first. */
function otherInstalls() {
  try {
    const win = process.platform === "win32";
    const out = execFileSync(win ? "where" : "which", win ? ["amem"] : ["-a", "amem"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, PATH: `${process.env.PATH || ""}${path.delimiter}/opt/homebrew/bin${path.delimiter}/usr/local/bin${path.delimiter}${path.join(os.homedir(), ".local", "bin")}` },
    });
    const mine = path.resolve(shimPath()).toLowerCase();
    return [...new Set(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))].filter(
      (p) => path.resolve(p).toLowerCase() !== mine,
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Dashboard server
// ---------------------------------------------------------------------------

function probeHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          resolve(json && json.ok ? json : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function startServer(port) {
  const child = spawn(process.execPath, [cliPath(), "ui", "--no-open", "--port", String(port)], {
    env: amemEnv(),
    cwd: os.homedir(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (d) => process.stdout.write(`[amem ui] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[amem ui] ${d}`));
  child.on("exit", (code) => {
    if (serverChild === child) serverChild = null;
    if (code && !app.isQuitting) console.error(`[amem-desktop] dashboard server exited with ${code}`);
  });
  return child;
}

async function waitForHealth(port, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const health = await probeHealth(port);
    if (health) return health;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/**
 * Use a dashboard that is already running (the login service, or another amem) when it is
 * this version or newer; otherwise start the bundled one, on the next free port if 7843 is
 * held by an older amem.
 */
async function ensureServer() {
  const bundled = app.getVersion();
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 5; port++) {
    const health = await probeHealth(port);
    if (health && compareVersions(health.version, bundled) >= 0) return { port, health, started: false };
    if (health) continue; // an older amem holds this port; leave it alone
    serverChild = startServer(port);
    const up = await waitForHealth(port, 20000);
    if (up) return { port, health: up, started: true };
    throw new Error("The amem dashboard did not start. Quit and reopen the app; if it keeps happening, run `amem doctor` in a terminal.");
  }
  throw new Error(`Ports ${DEFAULT_PORT}-${DEFAULT_PORT + 4} are all taken by older amem versions. Quit them and reopen the app.`);
}

function compareVersions(a, b) {
  const pa = String(a || "0").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function stopServer() {
  if (serverChild && !serverChild.killed) {
    try {
      serverChild.kill();
    } catch {
      /* already gone */
    }
  }
  serverChild = null;
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

function settingsPath() {
  return path.join(app.getPath("userData"), "desktop.json");
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) || {};
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}

let autoUpdater = null;

function sendUpdate(state) {
  updateState = state;
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("amem:update-status", state);
}

/**
 * Check GitHub releases for a newer app. The update downloads in the background; the app
 * then offers "Restart to update", or installs it on the next quit when the person has
 * turned on automatic updates.
 */
function setupUpdater() {
  if (!app.isPackaged || process.env.AMEM_DISABLE_UPDATES === "1") {
    updateState = { state: "disabled", reason: app.isPackaged ? "AMEM_DISABLE_UPDATES is set" : "development build" };
    return;
  }
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    updateState = { state: "disabled", reason: "updater unavailable" };
    console.warn("[amem-desktop] electron-updater missing:", err instanceof Error ? err.message : err);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = Boolean(readSettings().autoInstall);
  autoUpdater.on("checking-for-update", () => sendUpdate({ state: "checking" }));
  autoUpdater.on("update-not-available", () => sendUpdate({ state: "current", checkedAt: new Date().toISOString() }));
  autoUpdater.on("update-available", (info) => sendUpdate({ state: "downloading", version: info.version }));
  autoUpdater.on("download-progress", (p) =>
    sendUpdate({ state: "downloading", version: updateState.version, percent: Math.round(p.percent || 0) }),
  );
  autoUpdater.on("update-downloaded", (info) => {
    sendUpdate({ state: "ready", version: info.version });
    if (Notification.isSupported()) {
      const note = new Notification({
        title: `amem ${info.version} is ready`,
        body: readSettings().autoInstall ? "It installs the next time you quit amem." : "Open amem and choose Restart to update.",
      });
      note.on("click", () => mainWindow && mainWindow.show());
      note.show();
    }
  });
  autoUpdater.on("error", (err) => sendUpdate({ state: "error", message: err instanceof Error ? err.message : String(err) }));
  const check = () => autoUpdater.checkForUpdates().catch(() => undefined);
  setTimeout(check, 10_000);
  setInterval(check, UPDATE_CHECK_MS);
}

// ---------------------------------------------------------------------------
// IPC (only for pages served by our dashboard)
// ---------------------------------------------------------------------------

function trusted(event) {
  try {
    const url = new URL(event.senderFrame.url);
    return uiOrigin !== null && url.origin === uiOrigin;
  } catch {
    return false;
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) throw new Error("not allowed");
    return fn(...args);
  });
}

function registerIpc() {
  handle("amem:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    packaged: app.isPackaged,
    shim: app.isPackaged ? shimPath() : null,
    path: app.isPackaged ? pathStatus() : null,
    otherInstalls: app.isPackaged ? otherInstalls() : [],
    update: updateState,
    autoInstall: Boolean(readSettings().autoInstall),
  }));
  handle("amem:path-add", () => (app.isPackaged ? addToPath() : null));
  handle("amem:update-check", async () => {
    if (!autoUpdater) return updateState;
    await autoUpdater.checkForUpdates().catch(() => undefined);
    return updateState;
  });
  handle("amem:update-install", () => {
    if (!autoUpdater || updateState.state !== "ready") return false;
    app.isQuitting = true;
    stopServer();
    autoUpdater.quitAndInstall();
    return true;
  });
  handle("amem:auto-install", (on) => {
    const settings = writeSettings({ autoInstall: Boolean(on) });
    if (autoUpdater) autoUpdater.autoInstallOnAppQuit = Boolean(settings.autoInstall);
    return Boolean(settings.autoInstall);
  });
  handle("amem:pick-folder", async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a project folder",
      properties: ["openDirectory"],
    });
    return res.canceled ? null : res.filePaths[0] || null;
  });
  handle("amem:open-external", (url) => {
    if (typeof url === "string" && /^https:\/\//.test(url)) return shell.openExternal(url);
    return false;
  });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function iconsDir() {
  return path.join(__dirname, "icons");
}

/** Prefer PNG for Dock — nativeImage + .icns is unreliable for unpackaged Electron. */
function loadAppIcon() {
  const dir = iconsDir();
  const candidates =
    process.platform === "darwin"
      ? ["icon-1024.png", "icon.png", "icon.icns"]
      : process.platform === "win32"
        ? ["icon.ico", "icon.png", "icon-1024.png"]
        : ["icon.png", "icon-1024.png"];

  for (const name of candidates) {
    const iconPath = path.join(dir, name);
    if (!fs.existsSync(iconPath)) continue;
    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) continue;
    // Dock looks sharper with a mid-size bitmap.
    const { width } = image.getSize();
    if (width > 512) {
      image = image.resize({ width: 512, height: 512, quality: "best" });
    }
    return image;
  }
  console.warn("[amem-desktop] no usable icon in", dir);
  return null;
}

function applyDockIcon(icon) {
  // A packaged app already has its icon; only the dev Electron.app needs this.
  if (!icon || app.isPackaged || process.platform !== "darwin" || !app.dock) return;
  try {
    app.dock.setIcon(icon);
    app.dock.show();
  } catch (err) {
    console.warn("[amem-desktop] dock.setIcon failed:", err instanceof Error ? err.message : err);
  }
}

const WEB_PREFERENCES = {
  preload: path.join(__dirname, "preload.js"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

/** Links to the web open in the browser, never inside the app window. */
function keepNavigationLocal(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !(uiOrigin && url.startsWith(uiOrigin))) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (uiOrigin && url.startsWith(uiOrigin)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

function createWindow(icon, url) {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 560,
    title: "amem",
    show: false,
    backgroundColor: "#0b0f12",
    ...(icon ? { icon } : {}),
    webPreferences: WEB_PREFERENCES,
  });
  keepNavigationLocal(win);
  win.once("ready-to-show", () => {
    applyDockIcon(icon);
    win.show();
  });
  win.loadURL(url).catch((err) => {
    console.error("[amem-desktop] failed to load UI:", err instanceof Error ? err.message : err);
  });
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
}

/** `amem app --panel` / `amem ui --panel`: the Activity view in a narrow always-on-top window. */
function isPanelMode() {
  return process.env.AMEM_PANEL === "1" || process.argv.includes("--panel");
}

function createPanelWindow(icon, url) {
  const { screen } = require("electron");
  const area = screen.getPrimaryDisplay().workArea;
  const width = 360;
  const height = Math.min(720, area.height - 40);
  const win = new BrowserWindow({
    width,
    height,
    minWidth: 280,
    minHeight: 320,
    x: area.x + area.width - width - 16,
    y: area.y + 20,
    title: "amem activity",
    show: false,
    alwaysOnTop: true,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: "#0b0f12",
    ...(icon ? { icon } : {}),
    webPreferences: WEB_PREFERENCES,
  });
  keepNavigationLocal(win);
  // "floating" stays above normal windows without covering the menu bar or system UI.
  win.setAlwaysOnTop(true, "floating");
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    /* not supported on this platform */
  }
  win.once("ready-to-show", () => win.showInactive());
  win.loadURL(url).catch((err) => {
    console.error("[amem-desktop] failed to load panel:", err instanceof Error ? err.message : err);
  });
  return win;
}

function cliUrl() {
  const fromEnv = String(process.env.AMEM_UI_URL || "").trim();
  if (fromEnv) return fromEnv;
  const arg = process.argv.find((a) => /^https?:\/\//.test(a));
  return arg || `http://127.0.0.1:${DEFAULT_PORT}/`;
}

/** A packaged app run from the dmg or Downloads gets a throwaway path; the launcher must not point there. */
async function offerMoveToApplications() {
  if (process.platform !== "darwin" || !app.isPackaged || app.isInApplicationsFolder()) return;
  if (process.env.AMEM_SKIP_MOVE_PROMPT === "1") return; // tests and CI run the app in place
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Move to Applications", "Not now"],
    defaultId: 0,
    message: "Move amem to your Applications folder?",
    detail: "Your AI tools run amem from where the app lives, so it should stay in Applications.",
  });
  if (response === 0) {
    try {
      app.moveToApplicationsFolder();
    } catch (err) {
      dialog.showErrorBox("Could not move amem", err instanceof Error ? err.message : String(err));
    }
  }
}

async function start() {
  const icon = loadAppIcon();
  registerIpc();

  let url;
  if (app.isPackaged) {
    await offerMoveToApplications();
    try {
      ensureShim();
      const { port } = await ensureServer();
      url = `http://127.0.0.1:${port}/`;
    } catch (err) {
      dialog.showErrorBox("amem could not start", err instanceof Error ? err.message : String(err));
      app.quit();
      return;
    }
    setupUpdater();
  } else {
    url = cliUrl();
  }
  uiOrigin = new URL(url).origin;

  if (isPanelMode()) {
    createPanelWindow(icon, url);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createPanelWindow(icon, url);
    });
    return;
  }
  applyDockIcon(icon);
  createWindow(icon, url);
  app.on("activate", () => {
    applyDockIcon(icon);
    if (BrowserWindow.getAllWindows().length === 0) createWindow(icon, url);
  });
}

app.setName("amem");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(start);
}

app.on("before-quit", () => {
  app.isQuitting = true;
  stopServer();
});

app.on("window-all-closed", () => {
  app.quit();
});
