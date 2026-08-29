/**
 * Thin Electron shell: loads the existing amem localhost UI.
 * No Node integration in the renderer — API stays on 127.0.0.1.
 *
 * macOS note: BrowserWindow `icon` does not change the Dock for an unpackaged
 * Electron.app. We must call app.dock.setIcon() with a PNG (icns often loads empty).
 */
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

function uiUrl() {
  const fromEnv = String(process.env.AMEM_UI_URL || "").trim();
  if (fromEnv) return fromEnv;
  const arg = process.argv.find((a) => /^https?:\/\//.test(a));
  return arg || "http://127.0.0.1:7843/";
}

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
  if (!icon || process.platform !== "darwin" || !app.dock) return;
  try {
    app.dock.setIcon(icon);
    app.dock.show();
  } catch (err) {
    console.warn("[amem-desktop] dock.setIcon failed:", err instanceof Error ? err.message : err);
  }
}

function createWindow(icon) {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 560,
    title: "amem",
    show: false,
    backgroundColor: "#0b0f12",
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => {
    applyDockIcon(icon);
    win.show();
  });
  win.loadURL(uiUrl()).catch((err) => {
    console.error("[amem-desktop] failed to load UI:", err instanceof Error ? err.message : err);
  });
}

app.setName("amem");

app.whenReady().then(() => {
  const icon = loadAppIcon();
  applyDockIcon(icon);
  createWindow(icon);
  app.on("activate", () => {
    applyDockIcon(icon);
    if (BrowserWindow.getAllWindows().length === 0) createWindow(icon);
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
