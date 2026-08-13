import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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
  let u = url.trim().replace(/\.git$/i, "");
  const scp = /^git@([^:]+):(.+)$/.exec(u);
  if (scp) {
    u = `https://${scp[1]}/${scp[2]}`;
  }
  u = u.replace(/^ssh:\/\/git@/i, "https://");
  u = u.replace(/^git:\/\//i, "https://");
  u = u.replace(/^(https?:\/\/)[^@]+@/i, "$1");
  return u.toLowerCase().replace(/\/+$/, "");
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

export function newId(prefix?: string): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}
