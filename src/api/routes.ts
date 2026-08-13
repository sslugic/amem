import { metricsFromPacket } from "../estimate.js";
import {
  getRepoByCwd,
  getRepoById,
  getSetupState,
  insertUsageEvent,
  listClaims,
  listComponents,
  listEdges,
  listFlows,
  listRepos,
  listUsageEvents,
  setReportedOnLatest,
  setReportedTokensSaved,
  upsertRepo,
  upsertSetupState,
  wipeRepo,
  type RepoRow,
  type UsageEventRow,
} from "../db.js";
import { buildContext, renderContextMarkdown } from "../context.js";
import { installClaude, claudeInstallHealth } from "../install/claude.js";
import { installCursor, cursorInstallHealth } from "../install/cursor.js";
import {
  assertPlatformAllowed,
  assertRemoteAllowed,
  loadPolicy,
} from "../policy.js";
import { applyProposal, parseProposalJson, validateProposal } from "../proposal.js";
import { detectRepoIdentity } from "../repo-identity.js";
import { amemHome, dbPath } from "../paths.js";
import { buildAttestReport } from "../attest.js";

export type ApiRequest = {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  body: unknown;
  cwd: string;
};

export type ApiResponse = {
  status: number;
  body: unknown;
};

function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}

function err(status: number, message: string): ApiResponse {
  return { status, body: { error: message } };
}

function doctorIssues(repo: RepoRow | null, rootPath: string): string[] {
  const issues: string[] = [];
  if (!repo) {
    issues.push("Repo not initialized");
    return issues;
  }
  let platforms: string[] = [];
  try {
    const setup = getSetupState(repo.id);
    platforms = setup ? (JSON.parse(setup.platforms) as string[]) : [];
  } catch {
    platforms = [];
  }
  if (platforms.length === 0 && repo.platform) platforms = [repo.platform];
  if (platforms.includes("cursor") || repo.platform === "cursor") {
    issues.push(...cursorInstallHealth(rootPath));
  }
  if (platforms.includes("claude") || repo.platform === "claude") {
    issues.push(...claudeInstallHealth());
  }
  if (platforms.length === 0) {
    issues.push(...cursorInstallHealth(rootPath));
    issues.push(...claudeInstallHealth());
  }
  return issues;
}

function aggregateUsage(events: UsageEventRow[]) {
  const byPlatform: Record<
    string,
    {
      platform: string;
      queries: number;
      estimatedTokensSaved: number;
      reportedTokensSaved: number;
      lastUsed: string | null;
    }
  > = {};
  const byDay: Record<
    string,
    { day: string; estimatedTokensSaved: number; reportedTokensSaved: number; queries: number }
  > = {};

  for (const e of events) {
    const p = e.platform || "unknown";
    if (!byPlatform[p]) {
      byPlatform[p] = {
        platform: p,
        queries: 0,
        estimatedTokensSaved: 0,
        reportedTokensSaved: 0,
        lastUsed: null,
      };
    }
    byPlatform[p]!.queries += 1;
    byPlatform[p]!.estimatedTokensSaved += e.estimated_tokens_saved;
    byPlatform[p]!.reportedTokensSaved += e.reported_tokens_saved ?? 0;
    if (!byPlatform[p]!.lastUsed || e.created_at > byPlatform[p]!.lastUsed!) {
      byPlatform[p]!.lastUsed = e.created_at;
    }

    const day = e.created_at.slice(0, 10);
    if (!byDay[day]) {
      byDay[day] = { day, estimatedTokensSaved: 0, reportedTokensSaved: 0, queries: 0 };
    }
    byDay[day]!.estimatedTokensSaved += e.estimated_tokens_saved;
    byDay[day]!.reportedTokensSaved += e.reported_tokens_saved ?? 0;
    byDay[day]!.queries += 1;
  }

  return {
    byPlatform: Object.values(byPlatform),
    byDay: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
    totals: {
      queries: events.length,
      estimatedTokensSaved: events.reduce((s, e) => s + e.estimated_tokens_saved, 0),
      reportedTokensSaved: events.reduce((s, e) => s + (e.reported_tokens_saved ?? 0), 0),
    },
  };
}

export function handleApi(req: ApiRequest): ApiResponse {
  const { method, pathname, searchParams, body, cwd } = req;
  const identity = detectRepoIdentity(cwd);
  const repo = getRepoByCwd(cwd);

  if (method === "GET" && pathname === "/api/status") {
    const setup = repo ? getSetupState(repo.id) : null;
    const loaded = loadPolicy();
    return ok({
      amemHome: amemHome(),
      dbPath: dbPath(),
      identity,
      repo,
      setup,
      policy: loaded.policy,
      doctor: doctorIssues(repo, identity.rootPath),
      counts: repo
        ? {
            claims: listClaims(repo.id).length,
            flows: listFlows(repo.id).length,
            components: listComponents(repo.id).length,
            edges: listEdges(repo.id).length,
          }
        : null,
    });
  }

  if (method === "GET" && pathname === "/api/attest") {
    return ok(buildAttestReport(cwd));
  }

  if (method === "POST" && pathname === "/api/setup") {
    const platforms = (body as { platforms?: string[] })?.platforms ?? [];
    const valid = platforms.filter((p) => p === "cursor" || p === "claude");
    if (valid.length === 0) return err(400, "Select at least one platform: cursor or claude");

    const policy = loadPolicy().policy;
    try {
      assertRemoteAllowed(identity.remoteUrl, policy);
      for (const platform of valid) assertPlatformAllowed(platform, policy);
    } catch (e) {
      return err(403, e instanceof Error ? e.message : String(e));
    }

    let current = upsertRepo(identity, valid[0]);
    const results: unknown[] = [];
    for (const platform of valid) {
      current = upsertRepo(identity, platform);
      if (platform === "cursor") results.push(installCursor(identity.rootPath));
      else results.push(installClaude(identity.rootPath));
    }
    const setup = upsertSetupState(current.id, valid, true);
    return ok({
      repo: current,
      setup,
      installs: results,
      doctor: doctorIssues(current, identity.rootPath),
    });
  }

  if (method === "POST" && pathname === "/api/bootstrap") {
    if (!repo) return err(400, "Run setup first");
    const proposalRaw = (body as { proposal?: unknown })?.proposal;
    if (!proposalRaw) return err(400, "Missing proposal");
    const proposal =
      typeof proposalRaw === "string" ? parseProposalJson(proposalRaw) : (proposalRaw as ReturnType<typeof parseProposalJson>);
    const policy = loadPolicy().policy;
    try {
      assertRemoteAllowed(identity.remoteUrl, policy);
    } catch (e) {
      return err(403, e instanceof Error ? e.message : String(e));
    }
    const validated = validateProposal(proposal, policy);
    if (!validated.ok) return err(400, validated.errors.join("; "));
    const applied = applyProposal(repo.id, proposal, policy);
    upsertSetupState(
      repo.id,
      (() => {
        try {
          return JSON.parse(getSetupState(repo.id)?.platforms ?? "[]") as string[];
        } catch {
          return repo.platform ? [repo.platform] : [];
        }
      })(),
      true,
    );
    return ok({ applied });
  }

  if (method === "GET" && pathname === "/api/graph") {
    if (!repo) return err(400, "Repo not initialized");
    const days = Number(searchParams.get("days") ?? "30");
    const events = listUsageEvents({ repoId: repo.id, days });
    const recentClaimIds = new Set<string>();
    for (const e of events.slice(0, 20)) {
      try {
        for (const id of JSON.parse(e.claim_ids) as string[]) recentClaimIds.add(id);
      } catch {
        // ignore
      }
    }
    return ok({
      components: listComponents(repo.id),
      flows: listFlows(repo.id),
      claims: listClaims(repo.id),
      edges: listEdges(repo.id),
      recentClaimIds: [...recentClaimIds],
      recentEvents: events.slice(0, 30),
    });
  }

  if (method === "GET" && pathname === "/api/usage") {
    const scope = searchParams.get("repo") ?? "current";
    const days = Number(searchParams.get("days") ?? "30");
    let events: UsageEventRow[];
    if (scope === "all") {
      events = listUsageEvents({ days });
    } else {
      if (!repo) return err(400, "Repo not initialized");
      events = listUsageEvents({ repoId: repo.id, days });
    }
    return ok({
      scope,
      days,
      events,
      aggregate: aggregateUsage(events),
      repos: listRepos().map((r) => ({ id: r.id, name: r.repo_name })),
    });
  }

  if (method === "POST" && pathname === "/api/usage/report") {
    const payload = body as {
      eventId?: string;
      platform?: string;
      saved?: number;
    };
    if (typeof payload.saved !== "number" || payload.saved < 0) {
      return err(400, "saved must be a non-negative number");
    }
    if (payload.eventId) {
      return ok({ event: setReportedTokensSaved(payload.eventId, payload.saved) });
    }
    if (!repo) return err(400, "Repo not initialized");
    const platform = payload.platform ?? repo.platform ?? "unknown";
    return ok({ event: setReportedOnLatest(repo.id, platform, payload.saved) });
  }

  if (method === "POST" && pathname === "/api/wipe") {
    if (!repo) return err(400, "Nothing to wipe");
    const confirm = (body as { yes?: boolean })?.yes;
    if (!confirm) return err(400, "Pass { yes: true } to wipe");
    wipeRepo(repo.id);
    return ok({ wiped: true });
  }

  if (method === "GET" && pathname === "/api/repos") {
    return ok({ repos: listRepos() });
  }

  if (method === "GET" && pathname.startsWith("/api/repos/")) {
    const id = pathname.slice("/api/repos/".length);
    const found = getRepoById(id);
    if (!found) return err(404, "Repo not found");
    return ok({ repo: found });
  }

  return err(404, `Unknown route ${method} ${pathname}`);
}

export function logContextUsage(input: {
  repoId: string;
  platform: string;
  sessionId?: string;
  query: string;
}): { markdown: string; event: UsageEventRow } {
  const packet = buildContext(input.repoId, input.query);
  const markdown = renderContextMarkdown(packet);
  const metrics = metricsFromPacket(packet, markdown);
  const event = insertUsageEvent({
    repoId: input.repoId,
    platform: input.platform,
    sessionId: input.sessionId,
    query: input.query,
    claimIds: metrics.claimIds,
    anchorsCount: metrics.anchorsCount,
    claimsCount: metrics.claimsCount,
    packetTokens: metrics.packetTokens,
    estimatedTokensSaved: metrics.estimatedTokensSaved,
  });
  return { markdown, event };
}
