import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { parse as parsePath, resolve } from "node:path";

export type RepoIdentity = {
  rootPath: string;
  remoteUrl: string | null;
  repoKey: string;
  repoName: string;
  defaultBranch: string;
};

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function findGitRoot(startPath: string = process.cwd()): string | null {
  const out = runGit(resolve(startPath), ["rev-parse", "--show-toplevel"]);
  return out && existsSync(out) ? out : null;
}

/** Normalize remotes so ssh/https clones of the same repo share a key. */
export function normalizeRemoteUrl(url: string): string {
  // Strip trailing slashes before ".git" so "repo.git/" still collapses to "repo".
  let u = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const scp = /^git@([^:]+):(.+)$/.exec(u);
  if (scp) {
    u = `https://${scp[1]}/${scp[2]}`;
  }
  u = u.replace(/^ssh:\/\/git@/i, "https://");
  u = u.replace(/^git:\/\//i, "https://");
  u = u.replace(/^(https?:\/\/)[^@]+@/i, "$1");
  return u.toLowerCase().replace(/\/+$/, "").replace(/\.git$/i, "");
}

export function detectRepoIdentity(cwd: string = process.cwd()): RepoIdentity {
  const rootPath = findGitRoot(cwd) ?? resolve(cwd);
  const remoteRaw = runGit(rootPath, ["remote", "get-url", "origin"]);
  const remoteUrl = remoteRaw ? normalizeRemoteUrl(remoteRaw) : null;
  const defaultBranch =
    runGit(rootPath, ["symbolic-ref", "refs/remotes/origin/HEAD"])?.replace(
      /^refs\/remotes\/origin\//,
      "",
    ) ??
    runGit(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]) ??
    "main";

  const repoName =
    remoteUrl?.split("/").filter(Boolean).pop() ??
    rootPath.split(/[/\\]/).filter(Boolean).pop() ??
    "repo";

  const keySource = remoteUrl ?? `path:${rootPath}`;
  const repoKey = createHash("sha256").update(keySource).digest("hex").slice(0, 16);

  return {
    rootPath,
    remoteUrl,
    repoKey,
    repoName,
    defaultBranch,
  };
}

/**
 * Why this directory must not become a repo binding, or null if it is fine.
 *
 * detectRepoIdentity falls back to the cwd when there is no git root, so
 * running an init from a home directory would otherwise register the entire
 * home as a "repo" — a binding that matches everything and can never be the
 * right answer. Workspace roots under ~/.amem are created deliberately and are
 * not affected: they are built by workspaceIdentity, not by cwd detection.
 */
export function unbindableRootReason(rootPath: string): string | null {
  const resolved = resolve(rootPath);
  const parsed = parsePath(resolved);
  if (resolved === parsed.root) return "the filesystem root";
  if (resolved === resolve(homedir())) return "your home directory";
  return null;
}

export function slugifyWorkspace(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Workspace name must contain letters or numbers");
  return slug;
}

export function workspaceIdentity(name: string, rootPath: string): RepoIdentity {
  const slug = slugifyWorkspace(name);
  const repoKey = createHash("sha256").update(`workspace:${slug}`).digest("hex").slice(0, 16);
  return {
    rootPath: resolve(rootPath),
    remoteUrl: `amem://workspace/${slug}`,
    repoKey,
    repoName: slug,
    defaultBranch: "main",
  };
}

export function parseWorkspaceSlug(remoteUrl: string | null | undefined): string | null {
  const m = /^amem:\/\/workspace\/([^/]+)$/.exec(remoteUrl ?? "");
  return m?.[1] ?? null;
}

export function newId(prefix?: string): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}
