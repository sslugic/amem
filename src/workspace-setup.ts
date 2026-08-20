import { buildContext, renderContextMarkdown } from "./context.js";
import { insertUsageEvent, type RepoRow } from "./db.js";
import { metricsFromPacket } from "./estimate.js";
import { applyProposal } from "./proposal.js";
import { parseWorkspaceSlug } from "./repo-identity.js";

export type WorkspaceReady = {
  workspace: string;
  seeded: number;
  contextOk: boolean;
  checks: string[];
};

export function provisionWorkspace(repo: RepoRow, platform = repo.platform || "app"): WorkspaceReady {
  const slug = parseWorkspaceSlug(repo.remote_url) ?? repo.repo_name;
  const applied = applyProposal(repo.id, {
    claims: [
      {
        id: "claim.workspace_binding",
        kind: "structure",
        text: `${slug} is a named amem workspace (not a git repo). Query it with workspace=${slug}. Memory stays in ~/.amem on this machine.`,
        code_anchors: [slug],
        source_ref: "workspace-setup",
      },
      {
        id: "claim.workspace_use",
        kind: "constraint",
        text: `Any LLM client should retrieve amem context for workspace ${slug} before a model call, and remember durable outcomes after. Use POST /api/context and POST /api/remember, or the amem CLI.`,
        code_anchors: [slug],
        source_ref: "workspace-setup",
      },
    ],
  });

  const query = `What should I know about the ${slug} workspace?`;
  const started = Date.now();
  const packet = buildContext(repo.id, query, { rootPath: repo.root_path });
  const markdown = renderContextMarkdown(packet);
  const metrics = metricsFromPacket(packet, markdown);
  insertUsageEvent({
    repoId: repo.id,
    platform,
    query,
    claimIds: metrics.claimIds,
    anchorsCount: metrics.anchorsCount,
    claimsCount: metrics.claimsCount,
    packetTokens: metrics.packetTokens,
    estimatedTokensSaved: metrics.estimatedTokensSaved,
    localMs: Math.max(0, Date.now() - started),
    estimatedMsSaved: metrics.estimatedMsSaved,
    kind: metrics.kind,
  });
  const hay = markdown.toLowerCase();
  const contextOk = hay.includes(slug.toLowerCase()) && hay.includes("workspace");

  return {
    workspace: slug,
    seeded: applied.claims,
    contextOk,
    checks: [
      `seeded ${applied.claims} starter facts`,
      contextOk ? "context check: ok" : "context check: failed",
    ],
  };
}
