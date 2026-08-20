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
