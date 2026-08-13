import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export type ScannedRepo = {
  name: string;
  path: string;
  remote: string | null;
};

const SKIP_DIRS = new Set([
  ".cache",
  ".cursor",
  ".git",
  ".local",
  ".npm",
  ".nvm",
  ".Trash",
  "Applications",
  "Library",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  "Caches",
  "DerivedData",
  "Downloads",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "Pods",
  "tmp",
]);

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

function readRemote(repoRoot: string): string | null {
  try {
    let gitPath = join(repoRoot, ".git");
    const st = statSync(gitPath);
    if (st.isFile()) {
      const raw = readFileSync(gitPath, "utf8");
      const m = /gitdir:\s*(.+)/i.exec(raw);
      if (!m) return null;
      gitPath = resolve(repoRoot, m[1]!.trim());
    }
    const config = readFileSync(join(gitPath, "config"), "utf8");
    const origin = /\[remote "origin"\][^\[]*url\s*=\s*(.+)/.exec(config);
    return origin?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

function walk(dir: string, depth: number, maxDepth: number, limit: number, out: ScannedRepo[], deadline: number): void {
  if (out.length >= limit || Date.now() > deadline) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (isGitRepo(dir)) {
    out.push({
      name: basename(dir),
      path: dir,
      remote: readRemote(dir),
    });
    return;
  }
  if (depth >= maxDepth) return;
  for (const entry of entries) {
    if (out.length >= limit || Date.now() > deadline) return;
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    walk(join(dir, entry.name), depth + 1, maxDepth, limit, out, deadline);
  }
}

export function scanRoots(): string[] {
  const fromEnv = process.env.AMEM_SCAN_ROOTS;
  if (fromEnv) {
    return fromEnv
      .split(":")
      .map((p) => p.trim())
      .filter(Boolean);
  }
  const home = homedir();
  return [home];
}

export function scanGitRepos(options: {
  roots?: string[];
  maxDepth?: number;
  limit?: number;
  timeoutMs?: number;
} = {}): { repos: ScannedRepo[]; truncated: boolean; scannedRoots: string[] } {
  const roots = (options.roots ?? scanRoots()).filter((p) => existsSync(p));
  const maxDepth = options.maxDepth ?? 5;
  const limit = options.limit ?? 150;
  const deadline = Date.now() + (options.timeoutMs ?? 8000);
  const found: ScannedRepo[] = [];
  for (const root of roots) {
    walk(resolve(root), 0, maxDepth, limit, found, deadline);
  }
  found.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return {
    repos: found,
    truncated: found.length >= limit || Date.now() > deadline,
    scannedRoots: roots,
  };
}
