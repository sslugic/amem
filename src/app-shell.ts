/**
 * Desktop (Electron) shell launcher for the localhost Brain UI.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "./policy.js";
import {
  buildUiLandingUrl,
  isAddrInUse,
  openUiInBrowser,
  probeUiHealth,
  startUiServer,
} from "./ui/server.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function desktopDir(pkgRoot = PKG_ROOT): string {
  return join(pkgRoot, "desktop");
}

export function electronInstallHint(dir = desktopDir()): string {
  return `npm run app:setup   # or: npm install --prefix "${dir}" && node desktop/scripts/ensure-electron.mjs`;
}

/** Absolute path to the Electron binary, or null if desktop deps are missing. */
export function resolveElectronBinary(dir = desktopDir()): string | null {
  const pkgJson = join(dir, "package.json");
  if (!existsSync(pkgJson)) return null;

  const candidates = [
    join(dir, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    join(dir, "node_modules/electron/dist/electron"),
    join(dir, "node_modules/electron/dist/electron.exe"),
  ];

  try {
    const require = createRequire(pkgJson);
    const bin = require("electron");
    if (typeof bin === "string" && bin && existsSync(bin)) return bin;
  } catch {
    /* path.txt missing or postinstall incomplete — try dist paths */
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function spawnElectron(
  electronBin: string,
  dir: string,
  url: string,
  extraEnv: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, AMEM_UI_URL: url };
    // Parent IDEs sometimes set this; it makes Electron run as plain Node.
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronBin, [".", url], {
      cwd: dir,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

/**
 * Start or attach to amem ui, then open the Electron window.
 * Owns server shutdown only when this process started it.
 */
export async function runDesktopApp(options: {
  port?: number;
  cwd?: string;
  pkgRoot?: string;
} = {}): Promise<void> {
  const port = options.port ?? 7843;
  const cwd = options.cwd ?? process.cwd();
  const dir = desktopDir(options.pkgRoot ?? PKG_ROOT);
  const electronBin = resolveElectronBinary(dir);
  if (!electronBin) {
    const err = new Error(
      [
        "Electron desktop shell is not installed.",
        `Run once:  ${electronInstallHint(dir)}`,
        "Then:       amem app",
        "(Browser UI still works with: amem ui)",
      ].join("\n"),
    );
    (err as Error & { code?: string }).code = "AMEM_ELECTRON_MISSING";
    throw err;
  }

  const policy = loadPolicy().policy;
  const landing = buildUiLandingUrl(port, cwd);
  let owned: Awaited<ReturnType<typeof startUiServer>> | null = null;

  try {
    owned = await startUiServer({
      port,
      cwd,
      openBrowser: false,
      host: policy.ui_bind,
      landingUrl: landing,
    });
  } catch (error) {
    if (!isAddrInUse(error)) throw error;
    const probe = await probeUiHealth(port);
    if (!probe.hasVault) {
      throw new Error(
        [
          `Port ${port} is already serving an older amem without lock/backup APIs.`,
          "Stop that process, then run amem app again:",
          `  lsof -nP -iTCP:${port} -sTCP:LISTEN`,
        ].join("\n"),
      );
    }
  }

  console.log(`amem app → ${landing}`);
  if (owned) console.log("UI server started for this window (localhost only).");
  else console.log("Attached to UI server already running on this port.");

  try {
    const code = await spawnElectron(electronBin, dir, landing);
    if (code !== 0) process.exitCode = code;
  } finally {
    if (owned) {
      try {
        await owned.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** The compact Activity view, sized for a narrow side panel. */
export function activityPanelUrl(port: number): string {
  return `http://127.0.0.1:${port}/activity/mini`;
}

/** A Chromium-family browser that can open a chromeless `--app` window (macOS only). */
export function chromiumAppBrowser(
  exists: (p: string) => boolean = existsSync,
): string | null {
  if (process.platform !== "darwin") return null;
  for (const app of ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium", "Arc"]) {
    if (exists(`/Applications/${app}.app`)) return app;
  }
  return null;
}

export type PanelMode = "electron" | "app-window" | "browser";

/**
 * Open the Activity side panel. With the desktop shell installed it is a small
 * always-on-top window; without it, a chromeless browser window (or a plain tab),
 * which a browser cannot keep on top. Starts the UI server if nothing is listening,
 * and keeps it up only while this process owns it.
 */
export async function openActivityPanel(options: {
  port?: number;
  cwd?: string;
  pkgRoot?: string;
} = {}): Promise<{ mode: PanelMode; url: string }> {
  const port = options.port ?? 7843;
  const cwd = options.cwd ?? process.cwd();
  const url = activityPanelUrl(port);
  const policy = loadPolicy().policy;
  let owned: Awaited<ReturnType<typeof startUiServer>> | null = null;
  try {
    owned = await startUiServer({ port, cwd, openBrowser: false, host: policy.ui_bind, landingUrl: url });
  } catch (error) {
    if (!isAddrInUse(error)) throw error;
    const probe = await probeUiHealth(port);
    if (!probe.features.includes("activity")) {
      throw new Error(
        [
          `Port ${port} is serving an amem without the Activity view.`,
          "Restart it so it picks up this version:",
          "  launchctl kickstart -k gui/$(id -u)/co.amem.ui   # macOS login item",
        ].join("\n"),
      );
    }
  }

  const dir = desktopDir(options.pkgRoot ?? PKG_ROOT);
  const electronBin = resolveElectronBinary(dir);
  let mode: PanelMode;
  if (electronBin) {
    mode = "electron";
    console.log(`amem activity panel → ${url} (always on top)`);
    try {
      const code = await spawnElectron(electronBin, dir, url, { AMEM_PANEL: "1" });
      if (code !== 0) process.exitCode = code;
    } finally {
      if (owned) await owned.close().catch(() => undefined);
    }
    return { mode, url };
  }

  const appBrowser = chromiumAppBrowser();
  if (appBrowser) {
    mode = "app-window";
    spawn("open", ["-na", appBrowser, "--args", `--app=${url}`, "--window-size=380,720"], {
      stdio: "ignore",
      detached: true,
    }).unref();
  } else {
    mode = "browser";
    openUiInBrowser(url);
  }
  console.log(`amem activity panel → ${url}`);
  console.log("For an always-on-top window, install the desktop shell once:");
  console.log(`  ${electronInstallHint(dir)}`);
  if (owned) {
    console.log("UI server started for this panel (localhost only). Press Ctrl+C to stop.");
    await new Promise(() => {
      // keep serving until killed
    });
  }
  return { mode, url };
}
