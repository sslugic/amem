#!/usr/bin/env node
/**
 * amem launcher for the Claude Desktop bundle (.mcpb).
 *
 * Claude Desktop starts bundles with a minimal PATH (no Homebrew, nvm, Volta or
 * ~/.local), which is why a bare `amem` or `npx` never finishes tool discovery. This
 * script rebuilds a usable PATH, then runs the amem installed on the machine, or
 * `npx -y @iamem/amem mcp` when there is none. MCP traffic passes straight through
 * (stdio is inherited), so the launcher adds no protocol of its own.
 *
 * No dependencies: amem's database driver is native and must come from the user's own
 * Node install, so the server itself is never bundled.
 */
"use strict";
const { spawn } = require("node:child_process");
const { existsSync, readdirSync } = require("node:fs");
const { homedir } = require("node:os");
const { delimiter, join } = require("node:path");

const isWin = process.platform === "win32";
const home = homedir();

function nvmBins() {
  const dir = join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(dir)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => join(dir, v, "bin"));
  } catch {
    return [];
  }
}

const extraDirs = isWin
  ? [
      process.env.APPDATA && join(process.env.APPDATA, "npm"),
      process.env.ProgramFiles && join(process.env.ProgramFiles, "nodejs"),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Volta", "bin"),
    ]
  : [
      join(home, ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      join(home, ".volta", "bin"),
      join(home, ".bun", "bin"),
      ...nvmBins(),
      "/usr/bin",
      "/bin",
    ];

const pathDirs = [...extraDirs.filter(Boolean), ...(process.env.PATH || "").split(delimiter)].filter(
  (d, i, all) => d && all.indexOf(d) === i,
);
const env = { ...process.env, PATH: pathDirs.join(delimiter) };
if (!env.AMEM_WORKSPACE) env.AMEM_WORKSPACE = "personal";

function find(name) {
  const names = isWin ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const dir of pathDirs) for (const n of names) if (existsSync(join(dir, n))) return join(dir, n);
  return null;
}

const amem = process.env.AMEM_BIN || find("amem");
const npx = find("npx");
let command;
let args;
if (amem) {
  command = amem;
  args = ["mcp"];
} else if (npx) {
  command = npx;
  args = ["-y", "@iamem/amem@latest", "mcp"];
} else {
  process.stderr.write(
    "amem: Node.js 20+ was not found. Install Node from https://nodejs.org, then restart Claude Desktop.\n",
  );
  process.exit(1);
}

const child = spawn(command, args, { stdio: "inherit", env, shell: isWin });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  process.stderr.write(`amem: could not start ${command}: ${err.message}\n`);
  process.exit(1);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
