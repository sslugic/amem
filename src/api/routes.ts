import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { estimateUsdSaved, metricsFromPacket, USD_PER_MILLION_INPUT_TOKENS } from "../estimate.js";
import { buildActivityGraph, speedForEvent } from "../activity.js";
import {
  getRepoByCwd,
  getRepoById,
  getRepoByName,
  renameWorkspace,
  getSetupState,
  insertUsageEvent,
  listClaims,
  listComponents,
  listEdges,
  listFlows,
  listRepos,
  listSessions,
  listUsageEvents,
  listProposalDrafts,
  getProposalDraft,
  setProposalDraftStatus,
  updateClaim,
  setClaimPinned,
  deleteClaim,
  setReportedOnLatest,
  setReportedTokensSaved,
  upsertRepo,
  upsertSetupState,
  wipeRepo,
  openDb,
  closeDb,
  type RepoRow,
  type UsageEventRow,
} from "../db.js";
import { buildContext, decorateUsageEvents, renderContextMarkdown } from "../context.js";
import { installClaude, claudeInstallHealth } from "../install/claude.js";
import { installCursor, cursorInstallHealth } from "../install/cursor.js";
import { hostInstallHealth, installHost } from "../install/hosts.js";
import { decorateDraft, decorateDrafts } from "../draft-quality.js";
import {
  buildSavingsExport,
  formatSavingsMarkdown,
  savingsPdf,
} from "../savings-export.js";
import {
  assertPlatformAllowed,
  assertRemoteAllowed,
  loadPolicy,
} from "../policy.js";
import { applyProposal, applySupersedes, parseProposalJson, validateProposal } from "../proposal.js";
import {
  detectRepoIdentity,
  normalizeRemoteUrl,
  parseWorkspaceSlug,
  slugifyWorkspace,
  workspaceIdentity,
  type RepoIdentity,
} from "../repo-identity.js";
import { HOST_INSTALL_IDS, KNOWN_PLATFORMS, normalizePlatforms } from "../platforms.js";
import { amemHome, amemHomeWriteIssue, dbPath, tryEnsureDir } from "../paths.js";
import { buildAttestReport } from "../attest.js";
import { scanGitRepos } from "../scan.js";
import { provisionWorkspace } from "../workspace-setup.js";
import {
  installLoginService,
  isServiceInstalled,
  isServiceSupported,
  servicePlatform,
  uninstallLoginService,
} from "../service.js";
import { searchClaimsFts, tokenize } from "../search.js";
import { rememberContract } from "../remember-contract.js";
import { vaultStatus } from "../vault.js";
import {
  createBackup,
  lockDatabase,
  unlockDatabase,
} from "../crypto.js";
import {
  installBackupSchedule,
  uninstallBackupSchedule,
} from "../backup-schedule.js";
import { ensurePersonalWorkspace, PERSONAL_SLUG } from "../personal.js";

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

function bodyField(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

type ResolvedScope =
  | { ok: true; identity: RepoIdentity; repo: RepoRow | null }
  | { ok: false; response: ApiResponse };

function resolveScope(req: ApiRequest): ResolvedScope {
  const repoId = req.searchParams.get("repo") || bodyField(req.body, "repoId");
  const workspace = req.searchParams.get("workspace") || bodyField(req.body, "workspace");
  const rawPath = req.searchParams.get("path") || bodyField(req.body, "path");

  if (repoId && repoId !== "current" && repoId !== "all") {
    const found = getRepoById(repoId);
    if (!found) return { ok: false, response: err(404, "Repo not found") };
    return { ok: true, identity: identityForRepo(found), repo: found };
  }

  if (workspace) {
    const found = getRepoByName(workspace);
    if (!found) {
      return {
        ok: false,
        response: err(404, `Workspace not found: ${workspace}. Run amem init --workspace ${workspace}`),
      };
    }
    return { ok: true, identity: identityForRepo(found), repo: found };
  }

  const cwd = rawPath ? resolve(rawPath) : req.cwd;
  if (rawPath && !existsSync(cwd)) {
    return { ok: false, response: err(400, `Path not found: ${cwd}`) };
  }
  return { ok: true, identity: detectRepoIdentity(cwd), repo: getRepoByCwd(cwd) };
}

function identityForRepo(repo: RepoRow): RepoIdentity {
  const slug = parseWorkspaceSlug(repo.remote_url);
  if (slug) return workspaceIdentity(slug, repo.root_path);
  return detectRepoIdentity(repo.root_path);
}

function summarizeRepo(r: RepoRow) {
  const setup = getSetupState(r.id);
  const slug = parseWorkspaceSlug(r.remote_url);
  return {
    id: r.id,
    repo_key: r.repo_key,
    repo_name: r.repo_name,
    root_path: r.root_path,
    remote_url: r.remote_url,
    platform: r.platform,
    kind: slug ? "workspace" : "git",
    slug,
    personal: slug === PERSONAL_SLUG,
    setup_completed: Boolean(setup?.setup_completed_at),
    counts: {
      claims: listClaims(r.id).length,
      flows: listFlows(r.id).length,
      components: listComponents(r.id).length,
    },
  };
}

function statusPayload(identity: RepoIdentity, repo: RepoRow | null) {
  const setup = repo ? getSetupState(repo.id) : null;
  const loaded = loadPolicy();
  const slug = repo ? parseWorkspaceSlug(repo.remote_url) : null;
  return {
    amemHome: amemHome(),
    dbPath: dbPath(),
    identity,
    repo: repo ? { ...repo, kind: slug ? "workspace" : "git", slug } : null,
    kind: repo ? (slug ? "workspace" : "git") : null,
    slug,
    setup,
    policy: loaded.policy,
    clients: KNOWN_PLATFORMS,
    doctor: [amemHomeWriteIssue(), ...doctorIssues(repo, identity.rootPath)].filter(
      (issue): issue is string => Boolean(issue),
    ),
    counts: repo
      ? {
          claims: listClaims(repo.id).length,
          flows: listFlows(repo.id).length,
          components: listComponents(repo.id).length,
          edges: listEdges(repo.id).length,
        }
      : null,
    repos: listRepos().map(summarizeRepo),
    vault: vaultStatus(),
    recipe: {
      version: rememberContract().version,
      mcpUrlTemplate: rememberContract().mcpUrlTemplate,
    },
  };
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
  for (const host of ["continue", "zed", "windsurf"]) {
    if (platforms.includes(host) || repo.platform === host) {
      issues.push(...hostInstallHealth(host));
    }
  }
  if (platforms.length === 0) {
    issues.push(...cursorInstallHealth(rootPath));
    issues.push(...claudeInstallHealth());
  }
  return issues;
}

function dayStamp(iso: string): string {
  return iso.slice(0, 10);
}

function inclusiveDaySpan(fromIso: string, toMs: number): number {
  const from = Date.parse(`${dayStamp(fromIso)}T00:00:00Z`);
  const to = Date.parse(`${new Date(toMs).toISOString().slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 1;
  return Math.floor((to - from) / 86_400_000) + 1;
}

function projectMonthly(events: UsageEventRow[], windowDays: number) {
  const empty = {
    trendDays: 0,
    sampleQueries: 0,
    estimatedTokensSaved: 0,
    estimatedUsdSaved: 0,
    estimatedMsSaved: 0,
    queries: 0,
    anchorsAvoided: 0,
  };
  if (events.length === 0) return empty;

  const trendCap = Math.min(7, Math.max(1, windowDays));
  const now = Date.now();
  const cutoff = now - trendCap * 86_400_000;
  const recent = events.filter((e) => Date.parse(e.created_at) >= cutoff);
  const sample = recent.length > 0 ? recent : events;
  const oldest = sample.reduce((a, e) => (e.created_at < a ? e.created_at : a), sample[0]!.created_at);
  const trendDays = Math.min(trendCap, inclusiveDaySpan(oldest, now));
  const scale = 30 / trendDays;

  let tokens = 0;
  let ms = 0;
  let anchors = 0;
  for (const e of sample) {
    const speed = speedForEvent(e);
    tokens += e.estimated_tokens_saved;
    ms += speed.estimatedMsSaved;
    anchors += speed.anchorsCount;
  }

  return {
    trendDays,
    sampleQueries: sample.length,
    estimatedTokensSaved: Math.round(tokens * scale),
    estimatedUsdSaved: estimateUsdSaved(Math.round(tokens * scale)),
    estimatedMsSaved: Math.round(ms * scale),
    queries: Math.round(sample.length * scale),
    anchorsAvoided: Math.round(anchors * scale),
  };
}

function aggregateUsage(events: UsageEventRow[], windowDays = 30) {
  const byPlatform: Record<
    string,
    {
      platform: string;
      queries: number;
      estimatedTokensSaved: number;
      reportedTokensSaved: number;
      estimatedMsSaved: number;
      localHits: number;
      serverTrips: number;
      localMsTotal: number;
      localMsSamples: number;
      lastUsed: string | null;
    }
  > = {};
  const byDay: Record<
    string,
    {
      day: string;
      estimatedTokensSaved: number;
      reportedTokensSaved: number;
      estimatedMsSaved: number;
      queries: number;
      localHits: number;
      serverTrips: number;
    }
  > = {};

  let localMsTotal = 0;
  let localMsSamples = 0;
  let estimatedMsSaved = 0;
  let localHits = 0;
  let serverTrips = 0;
  let anchorsAvoided = 0;

  for (const e of events) {
    const speed = speedForEvent(e);
    estimatedMsSaved += speed.estimatedMsSaved;
    anchorsAvoided += speed.anchorsCount;
    if (speed.kind === "local_hit") localHits += 1;
    else serverTrips += 1;
    if (speed.localMs != null) {
      localMsTotal += speed.localMs;
      localMsSamples += 1;
    }

    const p = e.platform || "unknown";
    if (!byPlatform[p]) {
      byPlatform[p] = {
        platform: p,
        queries: 0,
        estimatedTokensSaved: 0,
        reportedTokensSaved: 0,
        estimatedMsSaved: 0,
        localHits: 0,
        serverTrips: 0,
        localMsTotal: 0,
        localMsSamples: 0,
        lastUsed: null,
      };
    }
    byPlatform[p]!.queries += 1;
    byPlatform[p]!.estimatedTokensSaved += e.estimated_tokens_saved;
    byPlatform[p]!.reportedTokensSaved += e.reported_tokens_saved ?? 0;
    byPlatform[p]!.estimatedMsSaved += speed.estimatedMsSaved;
    if (speed.kind === "local_hit") byPlatform[p]!.localHits += 1;
    else byPlatform[p]!.serverTrips += 1;
    if (speed.localMs != null) {
      byPlatform[p]!.localMsTotal += speed.localMs;
      byPlatform[p]!.localMsSamples += 1;
    }
    if (!byPlatform[p]!.lastUsed || e.created_at > byPlatform[p]!.lastUsed!) {
      byPlatform[p]!.lastUsed = e.created_at;
    }

    const day = e.created_at.slice(0, 10);
    if (!byDay[day]) {
      byDay[day] = {
        day,
        estimatedTokensSaved: 0,
        reportedTokensSaved: 0,
        estimatedMsSaved: 0,
        queries: 0,
        localHits: 0,
        serverTrips: 0,
      };
    }
    byDay[day]!.estimatedTokensSaved += e.estimated_tokens_saved;
    byDay[day]!.reportedTokensSaved += e.reported_tokens_saved ?? 0;
    byDay[day]!.estimatedMsSaved += speed.estimatedMsSaved;
    byDay[day]!.queries += 1;
    if (speed.kind === "local_hit") byDay[day]!.localHits += 1;
    else byDay[day]!.serverTrips += 1;
  }

  const queries = events.length;
  const estimatedTokensSaved = events.reduce((s, e) => s + e.estimated_tokens_saved, 0);
  return {
    pricing: {
      usdPerMillionInputTokens: USD_PER_MILLION_INPUT_TOKENS,
      basis: "input",
    },
    byPlatform: Object.values(byPlatform).map((p) => ({
      ...p,
      estimatedUsdSaved: estimateUsdSaved(p.estimatedTokensSaved),
      avgLocalMs: p.localMsSamples ? Math.round(p.localMsTotal / p.localMsSamples) : null,
    })),
    byDay: Object.values(byDay)
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((d) => ({
        ...d,
        estimatedUsdSaved: estimateUsdSaved(d.estimatedTokensSaved),
      })),
    totals: {
      queries,
      estimatedTokensSaved,
      estimatedUsdSaved: estimateUsdSaved(estimatedTokensSaved),
      reportedTokensSaved: events.reduce((s, e) => s + (e.reported_tokens_saved ?? 0), 0),
      estimatedMsSaved,
      localHits,
      serverTrips,
      hitRate: queries ? localHits / queries : 0,
      avgLocalMs: localMsSamples ? Math.round(localMsTotal / localMsSamples) : null,
      anchorsAvoided,
    },
    monthly: projectMonthly(events, windowDays),
  };
}

function createWorkspace(body: unknown): ApiResponse {
  const name = bodyField(body, "name");
  if (!name) return err(400, "name required");
  let slug: string;
  try {
    slug = slugifyWorkspace(name);
  } catch (error) {
    return err(400, error instanceof Error ? error.message : String(error));
  }
  const platform = bodyField(body, "platform") ?? "app";
  const rawPath = bodyField(body, "path");
  const root = rawPath ? resolve(rawPath) : join(amemHome(), "workspaces", slug);
  tryEnsureDir(root);
  const identity = workspaceIdentity(slug, root);
  const created = upsertRepo(identity, platform);
  const repo = name.trim() === slug ? created : renameWorkspace(created.id, name.trim());
  upsertSetupState(repo.id, [platform], true);
  const ready = provisionWorkspace(repo, platform);
  return ok({
    workspace: slug,
    name: repo.repo_name,
    repo: summarizeRepo(repo),
    ready,
    mcp: {
      url: `http://127.0.0.1:7843/mcp?workspace=${encodeURIComponent(slug)}`,
    },
  });
}

function renameWorkspaceApi(body: unknown): ApiResponse {
  const repoId = bodyField(body, "repoId") || bodyField(body, "id");
  const name = bodyField(body, "name");
  if (!repoId) return err(400, "repoId required");
  if (!name) return err(400, "name required");
  try {
    const repo = renameWorkspace(repoId, name);
    const slug = parseWorkspaceSlug(repo.remote_url);
    return ok({
      workspace: slug,
      name: repo.repo_name,
      repo: summarizeRepo(repo),
      mcp: slug
        ? { url: `http://127.0.0.1:7843/mcp?workspace=${encodeURIComponent(slug)}` }
        : undefined,
    });
  } catch (error) {
    return err(400, error instanceof Error ? error.message : String(error));
  }
}

function runContext(repo: RepoRow, body: unknown, searchParams: URLSearchParams): ApiResponse {
  const query = bodyField(body, "query") || searchParams.get("query") || "";
  if (!query.trim()) return err(400, "query required");
  const platform =
    bodyField(body, "platform") || searchParams.get("platform") || repo.platform || "unknown";
  const sessionId = bodyField(body, "sessionId") || searchParams.get("sessionId") || undefined;
  const result = logContextUsage({
    repoId: repo.id,
    platform,
    sessionId,
    query,
  });
  return ok({
    markdown: result.markdown,
    event: result.event,
    workspace: parseWorkspaceSlug(repo.remote_url) ?? repo.repo_name,
  });
}

function runRemember(repo: RepoRow, body: unknown): ApiResponse {
  const text = bodyField(body, "text");
  if (!text) return err(400, "text required");
  const kind = bodyField(body, "kind") ?? "session";
  const id =
    bodyField(body, "id") ??
    `claim.remember_${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const anchorsRaw = payload.anchors;
  const anchors = Array.isArray(anchorsRaw)
    ? anchorsRaw.filter((a): a is string => typeof a === "string" && Boolean(a.trim())).slice(0, 8)
    : [];
  if (anchors.length === 0) {
    anchors.push(parseWorkspaceSlug(repo.remote_url) ?? repo.repo_name);
  }
  const applied = applyProposal(repo.id, {
    claims: [
      {
        id,
        kind,
        text,
        code_anchors: anchors,
        source_ref: bodyField(body, "source") ?? "api",
      },
    ],
  });
  return ok({
    applied,
    claimId: id,
    workspace: parseWorkspaceSlug(repo.remote_url) ?? repo.repo_name,
  });
}

function bodyNumber(body: unknown, key: string): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function runVaultLock(body: unknown): ApiResponse {
  const passphrase = bodyField(body, "passphrase");
  if (!passphrase) return err(400, "passphrase required");
  try {
    closeDb();
    const result = lockDatabase(passphrase);
    return ok({ ...vaultStatus(), ...result });
  } catch (error) {
    return err(400, error instanceof Error ? error.message : String(error));
  }
}

function runVaultUnlock(body: unknown): ApiResponse {
  const passphrase = bodyField(body, "passphrase");
  if (!passphrase) return err(400, "passphrase required");
  try {
    closeDb();
    const result = unlockDatabase(passphrase);
    openDb();
    return ok({ ...vaultStatus(), ...result });
  } catch (error) {
    return err(400, error instanceof Error ? error.message : String(error));
  }
}

function runVaultBackup(body: unknown): ApiResponse {
  try {
    const result = createBackup({
      passphrase: bodyField(body, "passphrase"),
      label: bodyField(body, "label"),
      outDir: bodyField(body, "outDir"),
    });
    return ok({ ...result, vault: vaultStatus() });
  } catch (error) {
    return err(400, error instanceof Error ? error.message : String(error));
  }
}

function runVaultSchedule(body: unknown): ApiResponse {
  try {
    const hour = bodyNumber(body, "hour");
    const result = installBackupSchedule({
      outDir: bodyField(body, "outDir"),
      hour,
    });
    return ok({ ...result, vault: vaultStatus() });
  } catch (error) {
    return err(400, error instanceof Error ? error.message : String(error));
  }
}

export function handleApi(req: ApiRequest): ApiResponse {
  const { method, pathname, searchParams, body, cwd } = req;

  if (method === "GET" && pathname === "/api/recipe") {
    return ok(rememberContract());
  }

  if (method === "GET" && pathname === "/api/vault") {
    return ok(vaultStatus());
  }

  if (method === "POST" && pathname === "/api/vault/lock") {
    return runVaultLock(body);
  }

  if (method === "POST" && pathname === "/api/vault/unlock") {
    return runVaultUnlock(body);
  }

  if (method === "POST" && pathname === "/api/vault/backup") {
    return runVaultBackup(body);
  }

  if (method === "POST" && pathname === "/api/vault/backup/schedule") {
    return runVaultSchedule(body);
  }

  if (method === "POST" && pathname === "/api/vault/backup/unschedule") {
    try {
      const result = uninstallBackupSchedule();
      return ok({ ...result, vault: vaultStatus() });
    } catch (error) {
      return err(400, error instanceof Error ? error.message : String(error));
    }
  }

  if (method === "POST" && pathname === "/api/workspaces/personal") {
    const platform = bodyField(body, "platform") ?? "app";
    const repo = ensurePersonalWorkspace(platform);
    upsertSetupState(repo.id, [platform], true);
    return ok({
      workspace: PERSONAL_SLUG,
      name: repo.repo_name,
      repo: summarizeRepo(repo),
      mcp: {
        url: `http://127.0.0.1:7843/mcp?workspace=${encodeURIComponent(PERSONAL_SLUG)}`,
      },
    });
  }

  if (method === "GET" && pathname === "/api/repos") {
    return ok({ repos: listRepos().map(summarizeRepo) });
  }

  if (method === "POST" && pathname === "/api/workspaces") {
    return createWorkspace(body);
  }

  if (method === "POST" && pathname === "/api/workspaces/rename") {
    return renameWorkspaceApi(body);
  }

  if (method === "GET" && pathname === "/api/scan") {
    const scanned = scanGitRepos();
    const bound = listRepos();
    return ok({
      ...scanned,
      repos: scanned.repos.map((r) => ({
        ...r,
        tracking: bound.some((b) => {
          if (b.root_path === r.path) return true;
          if (r.remote && b.remote_url && normalizeRemoteUrl(r.remote) === b.remote_url) return true;
          return false;
        }),
      })),
    });
  }

  if (method === "POST" && pathname === "/api/track") {
    const payload = body && typeof body === "object" ? (body as { paths?: string[]; platforms?: string[] }) : {};
    const paths = (payload.paths ?? []).filter((p) => typeof p === "string" && p.trim());
    const platforms = normalizePlatforms(payload.platforms);
    if (paths.length === 0) return err(400, "Select at least one repository");
    if (platforms.length === 0) return err(400, "Select at least one LLM client");
    const policy = loadPolicy().policy;
    try {
      for (const platform of platforms) assertPlatformAllowed(platform, policy);
    } catch (e) {
      return err(403, e instanceof Error ? e.message : String(e));
    }
    const tracked: unknown[] = [];
    for (const raw of paths) {
      const root = resolve(raw);
      if (!existsSync(root)) continue;
      const identity = detectRepoIdentity(root);
      let current = upsertRepo(identity, platforms[0]);
      for (const platform of platforms) {
        current = upsertRepo(identity, platform);
        if (platform === "cursor") installCursor(identity.rootPath);
        else if (platform === "claude") installClaude(identity.rootPath);
        else if (HOST_INSTALL_IDS.has(platform)) {
          installHost(platform, {
            repoRoot: identity.rootPath,
            workspace: identity.repoName,
          });
        }
      }
      upsertSetupState(current.id, platforms, true);
      tracked.push(summarizeRepo(current));
    }
    return ok({ tracked, repos: listRepos().map(summarizeRepo) });
  }

  if (method === "GET" && pathname === "/api/service") {
    return ok({
      platform: process.platform,
      servicePlatform: servicePlatform(),
      supported: isServiceSupported(),
      installed: isServiceInstalled(),
    });
  }

  if (method === "POST" && pathname === "/api/service") {
    const enabled = (body as { enabled?: boolean })?.enabled;
    if (typeof enabled !== "boolean") return err(400, "enabled must be true or false");
    try {
      const result = enabled ? installLoginService() : uninstallLoginService();
      return ok({ ...result, supported: isServiceSupported() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(400, message);
    }
  }

  if (method === "GET" && pathname.startsWith("/api/repos/")) {
    const id = pathname.slice("/api/repos/".length);
    const found = getRepoById(id);
    if (!found) return err(404, "Repo not found");
    return ok({ repo: found, ...summarizeRepo(found) });
  }

  const scoped = resolveScope(req);
  if (!scoped.ok) return scoped.response;
  const { identity, repo } = scoped;

  if (method === "GET" && pathname === "/api/status") {
    return ok(statusPayload(identity, repo));
  }

  if (method === "GET" && pathname === "/api/attest") {
    return ok(buildAttestReport(cwd));
  }

  if (method === "POST" && pathname === "/api/setup") {
    const platforms = (body as { platforms?: string[] })?.platforms ?? [];
    const valid = normalizePlatforms(platforms);
    if (valid.length === 0) return err(400, "Select at least one LLM client");

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
      else if (platform === "claude") results.push(installClaude(identity.rootPath));
      else if (HOST_INSTALL_IDS.has(platform)) {
        results.push(
          installHost(platform, {
            repoRoot: identity.rootPath,
            workspace: identity.repoName,
          }),
        );
      }
    }
    const setup = upsertSetupState(current.id, valid, true);
    return ok({
      repo: current,
      setup,
      installs: results,
      doctor: doctorIssues(current, identity.rootPath),
      status: statusPayload(identity, current),
    });
  }

  if ((method === "POST" || method === "GET") && pathname === "/api/context") {
    if (!repo) return err(400, "Unknown workspace. Pass workspace= or run amem init.");
    return runContext(repo, body, searchParams);
  }

  if (method === "POST" && pathname === "/api/remember") {
    if (!repo) return err(400, "Unknown workspace. Pass workspace= or run amem init.");
    return runRemember(repo, body);
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
    const events = decorateUsageEvents(listUsageEvents({ repoId: repo.id, days }));
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
      drafts: decorateDrafts(listProposalDrafts(repo.id, { status: "pending", limit: 30 })),
      recentClaimIds: [...recentClaimIds],
      recentEvents: events.slice(0, 30),
      activity: buildActivityGraph({
        events,
        sessions: listSessions(repo.id),
      }),
    });
  }

  if (method === "GET" && pathname === "/api/drafts") {
    if (!repo) return err(400, "Repo not initialized");
    const status = searchParams.get("status") ?? "pending";
    return ok({ drafts: decorateDrafts(listProposalDrafts(repo.id, { status, limit: 50 })) });
  }

  if (method === "POST" && pathname === "/api/drafts/reject-noisy") {
    if (!repo) return err(400, "Repo not initialized");
    const pending = decorateDrafts(listProposalDrafts(repo.id, { status: "pending", limit: 80 }));
    const noisy = pending.filter((d) => d.quality.reject);
    for (const d of noisy) setProposalDraftStatus(d.id, "dismissed");
    return ok({ dismissed: noisy.map((d) => d.id), count: noisy.length });
  }

  if (method === "POST" && pathname === "/api/drafts/apply") {
    if (!repo) return err(400, "Repo not initialized");
    const draftId = bodyField(body, "id");
    if (!draftId) return err(400, "id required");
    const draft = getProposalDraft(draftId);
    if (!draft || draft.repo_id !== repo.id) return err(404, "Draft not found");
    if (draft.status !== "pending") return err(400, `Draft is ${draft.status}`);
    let proposal;
    try {
      proposal = parseProposalJson(draft.proposal_json);
    } catch (error) {
      return err(400, error instanceof Error ? error.message : String(error));
    }
    const decorated = decorateDraft(draft);
    const liveConflicts = decorated.conflicts.filter((c) => !c.withinProposal);
    const resolve = bodyField(body, "resolve");
    if (liveConflicts.length > 0 && resolve !== "supersede" && resolve !== "keep") {
      return {
        status: 409,
        body: {
          error: "Draft conflicts with existing facts. Pass resolve=supersede or resolve=keep.",
          conflicts: liveConflicts,
          quality: decorated.quality,
          draft: decorated,
        },
      };
    }
    if (resolve === "supersede") {
      proposal = applySupersedes(
        proposal,
        liveConflicts.map((c) => c.otherId),
      );
    }
    const policy = loadPolicy().policy;
    const applied = applyProposal(repo.id, proposal, policy);
    setProposalDraftStatus(draftId, "applied");
    return ok({ applied, draft: getProposalDraft(draftId), resolve: resolve ?? "keep" });
  }

  if (method === "POST" && pathname === "/api/drafts/dismiss") {
    if (!repo) return err(400, "Repo not initialized");
    const draftId = bodyField(body, "id");
    if (!draftId) return err(400, "id required");
    const draft = getProposalDraft(draftId);
    if (!draft || draft.repo_id !== repo.id) return err(404, "Draft not found");
    setProposalDraftStatus(draftId, "dismissed");
    return ok({ draft: getProposalDraft(draftId) });
  }

  if (method === "GET" && pathname === "/api/claims/search") {
    if (!repo) return err(400, "Repo not initialized");
    const q = searchParams.get("q") || bodyField(body, "q") || "";
    if (!q.trim()) return ok({ claims: listClaims(repo.id).slice(0, 40) });
    const hits = searchClaimsFts(openDb(), repo.id, q, 40);
    const byId = new Map(listClaims(repo.id).map((c) => [c.id, c]));
    const ranked = hits.map((h) => byId.get(h.id)).filter(Boolean);
    if (ranked.length > 0) return ok({ claims: ranked });
    // keyword fallback
    const tokens = tokenize(q);
    const fallback = listClaims(repo.id)
      .map((c) => ({
        c,
        score: tokens.reduce(
          (s, t) => s + (`${c.id} ${c.text} ${c.code_anchors}`.toLowerCase().includes(t) ? 1 : 0),
          0,
        ),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map((x) => x.c);
    return ok({ claims: fallback });
  }

  if (method === "PATCH" && pathname === "/api/claims") {
    if (!repo) return err(400, "Repo not initialized");
    const id = bodyField(body, "id");
    if (!id) return err(400, "id required");
    const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const anchorsRaw = payload.code_anchors ?? payload.anchors;
    let code_anchors: string[] | undefined;
    if (Array.isArray(anchorsRaw)) {
      code_anchors = anchorsRaw.filter((a): a is string => typeof a === "string" && Boolean(a.trim()));
    } else if (typeof anchorsRaw === "string") {
      code_anchors = anchorsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    try {
      const updated = updateClaim(repo.id, id, {
        text: typeof payload.text === "string" ? payload.text : undefined,
        kind: typeof payload.kind === "string" ? payload.kind : undefined,
        code_anchors,
        pinned: typeof payload.pinned === "boolean" ? payload.pinned : undefined,
      });
      if (!updated) return err(404, "Claim not found");
      return ok({ claim: updated });
    } catch (error) {
      return err(400, error instanceof Error ? error.message : String(error));
    }
  }

  if (method === "POST" && pathname === "/api/claims/pin") {
    if (!repo) return err(400, "Repo not initialized");
    const id = bodyField(body, "id");
    if (!id) return err(400, "id required");
    const pinned = (body as { pinned?: boolean })?.pinned;
    if (typeof pinned !== "boolean") return err(400, "pinned must be true or false");
    const updated = setClaimPinned(repo.id, id, pinned);
    if (!updated) return err(404, "Claim not found");
    return ok({ claim: updated });
  }

  if (method === "DELETE" && pathname === "/api/claims") {
    if (!repo) return err(400, "Repo not initialized");
    const id = searchParams.get("id") || bodyField(body, "id");
    if (!id) return err(400, "id required");
    const removed = deleteClaim(repo.id, id);
    if (!removed) return err(404, "Claim not found");
    return ok({ deleted: id });
  }

  if (method === "GET" && pathname === "/api/usage/export") {
    const scope = searchParams.get("scope") ?? "current";
    const days = Number(searchParams.get("days") ?? "30");
    const format = (searchParams.get("format") || "json").toLowerCase();
    let events: UsageEventRow[];
    if (scope === "all") {
      events = decorateUsageEvents(listUsageEvents({ days }));
    } else {
      if (!repo) return err(400, "Repo not initialized");
      events = decorateUsageEvents(listUsageEvents({ repoId: repo.id, days }));
    }
    const report = buildSavingsExport({
      scope,
      days,
      repoName: repo?.repo_name,
      aggregate: aggregateUsage(events, days),
    });
    if (format === "md" || format === "markdown") {
      return ok({
        filename: `${report.filenameBase}.md`,
        markdown: formatSavingsMarkdown(report),
        report,
      });
    }
    if (format === "pdf") {
      return ok({
        filename: `${report.filenameBase}.pdf`,
        mime: "application/pdf",
        contentBase64: savingsPdf(report).toString("base64"),
        report,
      });
    }
    return ok({ filename: `${report.filenameBase}.json`, report });
  }

  if (method === "GET" && pathname === "/api/usage") {
    const scope = searchParams.get("scope") ?? (searchParams.get("repo") === "all" ? "all" : "current");
    const days = Number(searchParams.get("days") ?? "30");
    let events: UsageEventRow[];
    if (scope === "all") {
      events = decorateUsageEvents(listUsageEvents({ days }));
    } else {
      if (!repo) return err(400, "Repo not initialized");
      events = decorateUsageEvents(listUsageEvents({ repoId: repo.id, days }));
    }
    return ok({
      scope,
      days,
      events,
      aggregate: aggregateUsage(events, days),
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

  return err(404, `Unknown route ${method} ${pathname}`);
}

export function logContextUsage(input: {
  repoId: string;
  platform: string;
  sessionId?: string;
  query: string;
}): { markdown: string; event: UsageEventRow; packet: ReturnType<typeof buildContext> } {
  const started = Date.now();
  const repo = getRepoById(input.repoId);
  const packet = buildContext(input.repoId, input.query, {
    rootPath: repo?.root_path,
  });
  const markdown = renderContextMarkdown(packet);
  const metrics = metricsFromPacket(packet, markdown);
  const localMs = Math.max(0, Date.now() - started);
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
    localMs,
    estimatedMsSaved: metrics.estimatedMsSaved,
    kind: metrics.kind,
  });
  return { markdown, event, packet };
}
