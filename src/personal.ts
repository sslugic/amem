import { join } from "node:path";
import { applyProposal } from "./proposal.js";
import {
  getRepoByName,
  listClaims,
  upsertRepo,
  type ClaimRow,
  type RepoRow,
} from "./db.js";
import { amemHome, tryEnsureDir } from "./paths.js";
import { workspaceIdentity } from "./repo-identity.js";

export const PERSONAL_SLUG = "personal";

export function personalRoot(): string {
  const dir = join(amemHome(), "workspaces", PERSONAL_SLUG);
  tryEnsureDir(dir);
  return dir;
}

export function ensurePersonalWorkspace(platform = "app"): RepoRow {
  const existing = getRepoByName(PERSONAL_SLUG);
  if (existing) return existing;
  const identity = workspaceIdentity(PERSONAL_SLUG, personalRoot());
  // Force display name
  identity.repoName = "Personal prefs";
  const repo = upsertRepo(identity, platform);
  applyProposal(repo.id, {
    claims: [
      {
        id: "claim.personal_scope",
        kind: "structure",
        text: "This is your cross-repo personal amem space (how you work). It can inject into any project context without becoming a shared company wiki.",
        code_anchors: [PERSONAL_SLUG],
        source_ref: "personal-setup",
      },
    ],
  });
  return getRepoByName(PERSONAL_SLUG) ?? repo;
}

export function isPersonalRepo(repo: RepoRow | null | undefined): boolean {
  if (!repo) return false;
  return (repo.remote_url || "").includes(`amem://workspace/${PERSONAL_SLUG}`) || repo.repo_name === PERSONAL_SLUG;
}

/** Active personal claims for blending into another repo's context. */
export function listPersonalClaims(): ClaimRow[] {
  const personal = getRepoByName(PERSONAL_SLUG);
  if (!personal) return [];
  return listClaims(personal.id);
}

/** Kinds and anchors that mark a personal memory as private (not work context). */
const PRIVATE_KINDS = new Set(["private", "personal", "life"]);
const PRIVATE_ANCHORS = new Set(["private", "personal-only"]);

function claimAnchors(claim: ClaimRow): string[] {
  try {
    const parsed = JSON.parse(claim.code_anchors || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Personal memories stay out of work repositories when marked private: kind
 * `private` / `personal` / `life`, or an anchor `private` / `personal-only`.
 */
export function isPrivatePersonalClaim(claim: ClaimRow): boolean {
  if (PRIVATE_KINDS.has((claim.kind || "").toLowerCase())) return true;
  return claimAnchors(claim).some((a) => PRIVATE_ANCHORS.has(a.toLowerCase()));
}

/** Personal claims that may be blended into a work repository's context. */
export function listWorkPersonalClaims(): ClaimRow[] {
  return listPersonalClaims().filter((c) => c.id !== "claim.personal_scope" && !isPrivatePersonalClaim(c));
}

/** Words that identify a repository (name and remote path), for ranking personal memory. */
export function repoTokens(repo: Pick<RepoRow, "repo_name" | "remote_url">): string[] {
  const raw = `${repo.repo_name || ""} ${(repo.remote_url || "").replace(/^.*[:/]([^/]+\/[^/]+?)(?:\.git)?$/, "$1")}`;
  const stop = new Set(["git", "com", "github", "the", "app", "api"]);
  return [...new Set(raw.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !stop.has(t)))];
}
