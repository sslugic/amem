#!/usr/bin/env node
/**
 * Build the desktop app for one target:
 *
 *   node scripts/dist.mjs mac|mac-x64|win|linux [--publish]
 *
 * Syncs the version with amem, stages amem for that platform, runs electron-builder, and
 * on the Mac signs, notarises and staples the dmg too (when Apple credentials are set).
 * --publish uploads the files and the update feed (latest*.yml) to the GitHub release.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = {
  mac: { platform: "darwin", arch: "arm64", builder: ["--mac", "--arm64"] },
  "mac-x64": { platform: "darwin", arch: "x64", builder: ["--mac", "--x64"] },
  win: { platform: "win32", arch: "x64", builder: ["--win", "--x64"] },
  linux: { platform: "linux", arch: "x64", builder: ["--linux", "--x64"] },
};

const name = process.argv[2];
const target = TARGETS[name];
if (!target) {
  console.error(`Usage: node scripts/dist.mjs ${Object.keys(TARGETS).join("|")} [--publish]`);
  process.exit(1);
}
const publish = process.argv.includes("--publish");
const win = process.platform === "win32";
const run = (cmd, args) => execFileSync(cmd, args, { cwd: desktop, stdio: "inherit", shell: win });

run(process.execPath, ["scripts/sync-version.mjs"]);
run(process.execPath, ["scripts/stage-amem.mjs", "--platform", target.platform, "--arch", target.arch]);

const signing = Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER);
const builderArgs = [...target.builder, "--config", "electron-builder.json", "--publish", publish ? "always" : "never"];
if (target.platform === "darwin" && !signing) {
  console.warn("No Apple credentials (APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER): building without notarisation.");
  builderArgs.push("-c.mac.notarize=false");
}
run(win ? "npx.cmd" : "npx", ["electron-builder", ...builderArgs]);

if (target.platform === "darwin" && signing) {
  const dmgs = readdirSync(join(desktop, "release"))
    .filter((f) => f.endsWith(".dmg"))
    .map((f) => join(desktop, "release", f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (dmgs[0]) run("bash", ["scripts/staple-dmg.sh", dmgs[0]]);
}
