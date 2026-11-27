#!/usr/bin/env node
/**
 * Stage the amem CLI for the desktop app: desktop/build/amem holds what the app ships under
 * resources/amem — the compiled CLI, dashboard, skills and templates, plus production
 * dependencies with better-sqlite3 swapped for the build that matches the app's Electron.
 *
 * The app runs amem with its own runtime (ELECTRON_RUN_AS_NODE), so the SQLite binding
 * must be built for Electron's ABI, not the Node that runs this script. Prebuilt binaries
 * are downloaded per target, so a Mac can stage a Windows or Linux build too.
 *
 *   node desktop/scripts/stage-amem.mjs [--platform darwin|win32|linux] [--arch arm64|x64]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(desktop, "..");
const out = join(desktop, "build", "amem");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const platform = arg("platform", process.platform);
const arch = arg("arch", process.arch);
const win = process.platform === "win32";
const npm = win ? "npm.cmd" : "npm";
const npx = win ? "npx.cmd" : "npx";
// Node refuses to spawn .cmd files without a shell (EINVAL) since the 2024 batch-file fix.
const shell = win;

if (!existsSync(join(root, "dist", "cli.js"))) {
  console.error("dist/ is missing — run `npm run build` in the repo root first.");
  process.exit(1);
}

const electronPkg = join(desktop, "node_modules", "electron", "package.json");
if (!existsSync(electronPkg)) {
  console.error("Electron is not installed under desktop/ — run `npm ci --prefix desktop` first.");
  process.exit(1);
}
const electronVersion = JSON.parse(readFileSync(electronPkg, "utf8")).version;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const entry of ["dist", "ui-static", "skills", "templates", "LICENSE", "README.md", "package.json", "package-lock.json"]) {
  const from = join(root, entry);
  if (existsSync(from)) cpSync(from, join(out, entry), { recursive: true });
}
mkdirSync(join(out, "docs"), { recursive: true });
cpSync(join(root, "docs"), join(out, "docs"), {
  recursive: true,
  filter: (src) => !src.includes(`${join("docs", "media")}`),
});
mkdirSync(join(out, "scripts"), { recursive: true });
cpSync(join(root, "scripts", "mcp-launch.sh"), join(out, "scripts", "mcp-launch.sh"));

// The app is not an npm install: no postinstall ping, no prepare step.
const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
delete pkg.scripts;
delete pkg.devDependencies;
writeFileSync(join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

execFileSync(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: out,
  stdio: "inherit",
  shell,
});
rmSync(join(out, "package-lock.json"), { force: true });

const sqlite = join(out, "node_modules", "better-sqlite3");
rmSync(join(sqlite, "build"), { recursive: true, force: true });
execFileSync(
  npx,
  ["--yes", "prebuild-install@7", "--runtime", "electron", "--target", electronVersion, "--platform", platform, "--arch", arch, "--verbose"],
  { cwd: sqlite, stdio: "inherit", shell },
);
const binding = join(sqlite, "build", "Release", "better_sqlite3.node");
if (!existsSync(binding)) {
  console.error(`No better-sqlite3 build for Electron ${electronVersion} ${platform}-${arch}.`);
  process.exit(1);
}
// Sources and build scripts are not needed at runtime and only bloat the app.
for (const extra of ["deps", "src", "binding.gyp"]) rmSync(join(sqlite, extra), { recursive: true, force: true });

console.log(`Staged amem ${pkg.version} for Electron ${electronVersion} ${platform}-${arch} at ${out}`);
