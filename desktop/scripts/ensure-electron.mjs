#!/usr/bin/env node
/**
 * Ensure the Electron binary finished downloading after npm install
 * (some environments skip lifecycle scripts / botch macOS framework unzip).
 */
import { existsSync, rmSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronPkg = join(desktopRoot, "node_modules", "electron");
const pathTxt = join(electronPkg, "path.txt");
const distDir = join(electronPkg, "dist");

if (!existsSync(join(electronPkg, "package.json"))) {
  console.error("electron is not installed under desktop/. Run: npm install --prefix desktop");
  process.exit(1);
}

function platformRelative() {
  if (process.platform === "darwin") return "Electron.app/Contents/MacOS/Electron";
  if (process.platform === "win32") return "electron.exe";
  return "electron";
}

function binaryPath() {
  return join(distDir, platformRelative());
}

function frameworkOk() {
  if (process.platform !== "darwin") return true;
  return existsSync(
    join(distDir, "Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"),
  );
}

function looksComplete() {
  const bin = binaryPath();
  if (!existsSync(bin)) return false;
  if (!frameworkOk()) return false;
  return true;
}

function requireBin() {
  try {
    const require = createRequire(pathToFileURL(join(desktopRoot, "package.json")).href);
    const bin = require("electron");
    return typeof bin === "string" && existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

function downloadZip() {
  const require = createRequire(join(electronPkg, "package.json"));
  const { downloadArtifact } = require("@electron/get");
  const { version } = require(join(electronPkg, "package.json"));
  const checksums = require(join(electronPkg, "checksums.json"));
  return downloadArtifact({
    version,
    artifactName: "electron",
    force: true,
    platform: process.platform,
    arch: process.arch,
    checksums,
  });
}

async function ensure() {
  if (looksComplete()) {
    if (!existsSync(pathTxt)) writeFileSync(pathTxt, platformRelative());
    console.log(`Electron ready: ${requireBin() || binaryPath()}`);
    return;
  }

  console.log("Downloading Electron binary…");
  rmSync(distDir, { recursive: true, force: true });
  try {
    rmSync(pathTxt, { force: true });
  } catch {
    /* ignore */
  }

  const zipPath = await downloadZip();
  mkdirSync(distDir, { recursive: true });

  // System unzip preserves macOS framework symlinks; extract-zip often does not.
  const unzip = spawnSync("unzip", ["-o", "-q", zipPath, "-d", distDir], { stdio: "inherit" });
  if (unzip.status !== 0) {
    // Fallback for Windows / machines without unzip
    const extract = requireFromElectron("extract-zip");
    await extract(zipPath, { dir: distDir });
  }

  writeFileSync(pathTxt, platformRelative());
  // Match electron/install.js version marker when present
  try {
    const { version } = createRequire(join(electronPkg, "package.json"))("./package.json");
    writeFileSync(join(distDir, "version"), version);
  } catch {
    /* ignore */
  }

  if (!looksComplete()) {
    console.error("Electron binary still incomplete after install.");
    console.error("Try: rm -rf desktop/node_modules && npm run app:setup");
    process.exit(1);
  }

  console.log(`Electron ready: ${requireBin() || binaryPath()}`);
}

function requireFromElectron(id) {
  return createRequire(join(electronPkg, "package.json"))(id);
}

ensure().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
