#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildAttestReport, formatAttestHuman } from "./attest.js";
import { handleApi, logContextUsage } from "./api/routes.js";
import {
  closeDb,
  getRepoByCwd,
  getRepoByName,
  renameWorkspace,
  listClaims,
  listComponents,
  listFlows,
  requireRepo,
  setReportedOnLatest,
  setReportedTokensSaved,
  touchSession,
  upsertRepo,
  upsertSetupState,
  wipeAllRepos,
  wipeRepo,
} from "./db.js";
import { handleHookPayload } from "./hook.js";
import { installClaude, claudeInstallHealth } from "./install/claude.js";
import { installCursor, cursorInstallHealth } from "./install/cursor.js";
import { amemHome, dbPath } from "./paths.js";
import {
  assertExportAllowed,
  assertPlatformAllowed,
  assertRemoteAllowed,
  assertUiAllowed,
  loadPolicy,
} from "./policy.js";
import {
  applyProposal,
  exportRepoMemory,
  loadProposalFile,
  validateProposal,
} from "./proposal.js";
import { detectRepoIdentity, parseWorkspaceSlug, workspaceIdentity } from "./repo-identity.js";
import { startUiServer, buildUiLandingUrl, openUiInBrowser, isAddrInUse } from "./ui/server.js";
import { installLoginService, isServiceInstalled, uninstallLoginService } from "./service.js";
import { mcpClientConfig, runMcpServer } from "./mcp.js";
import { provisionWorkspace } from "./workspace-setup.js";

function usage(): never {
  console.log(`amem — local personal agent memory

Usage:
  amem init --platform cursor|claude
  amem init --workspace <name> [--path <dir>] [--platform luna|cursor|claude]
  amem rename "<display name>" --workspace <slug>
  amem status [--workspace <name>]
  amem doctor [--attest] [--json]
  amem context "<query>" [--workspace <name>] [--platform cursor|claude|luna]
  amem remember "<text>" [--workspace <name>] [--kind session] [--anchor <path>]
  amem propose validate <file.json>
  amem propose apply <file.json>
  amem export [--out <file.json>]
  amem wipe --yes
  amem wipe --all --yes
  amem session touch --platform cursor|claude [--session-id <id>]
  amem hook
  amem usage report --saved <n> [--platform cursor|claude] [--event-id <id>]
  amem ui [--port 7843] [--no-open]
  amem service install|uninstall|status
  amem mcp [--print-config] [--workspace <name>]

Privacy:
  All memory stays in ${amemHome()} on this machine.
  Nothing is uploaded or written into the product git history.

Enterprise:
  Policy file: /etc/amem/policy.toml (system) or ~/.amem/policy.toml (user)
  Override: AMEM_POLICY_PATH=/path/to/policy.toml
  Attest: amem doctor --attest
`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        flags.set(key, true);
      } else {
        flags.set(key, next);
        i += 1;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function flagString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function resolveBinding(flags: Map<string, string | boolean>) {
  const workspace = flagString(flags, "workspace") || process.env.AMEM_WORKSPACE;
  if (workspace) {
    const repo = getRepoByName(workspace);
    if (!repo) {
      throw new Error(`No workspace "${workspace}". Run: amem init --workspace ${workspace}`);
    }
    return repo;
  }
  return requireRepo();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv);
  const cmd = positional[0];
  if (!cmd) usage();

  try {
    switch (cmd) {
      case "init": {
        const workspace = flagString(flags, "workspace");
        if (workspace) {
          const platform = flagString(flags, "platform") ?? "app";
          const slugPath = join(amemHome(), "workspaces", workspace.toLowerCase());
          const root = resolve(flagString(flags, "path") ?? slugPath);
          mkdirSync(root, { recursive: true });
          const identity = workspaceIdentity(workspace, root);
          const repo = upsertRepo(identity, platform);
          upsertSetupState(repo.id, [platform], true);
          if (platform === "cursor") installCursor(identity.rootPath);
          else if (platform === "claude") installClaude(identity.rootPath);
          const ready = provisionWorkspace(repo, platform);
          console.log(`Workspace ${repo.repo_name} (${repo.id})`);
          console.log(`Memory DB: ${dbPath()}`);
          console.log(`Root: ${repo.root_path}`);
          console.log(`Platform: ${platform}`);
          for (const line of ready.checks) console.log(`Ready: ${line}`);
          break;
        }
        const platform = flagString(flags, "platform");
        if (platform !== "cursor" && platform !== "claude") {
          throw new Error("amem init requires --platform cursor|claude or --workspace <name>");
        }
        const policy = loadPolicy().policy;
        assertPlatformAllowed(platform, policy);
        const identity = detectRepoIdentity();
        assertRemoteAllowed(identity.remoteUrl, policy);
        const repo = upsertRepo(identity, platform);
        let installInfo;
        if (platform === "cursor") {
          installInfo = installCursor(identity.rootPath);
        } else {
          installInfo = installClaude(identity.rootPath);
        }
        upsertSetupState(repo.id, [platform], true);
        console.log(`Bound repo ${repo.repo_name} (${repo.repo_key})`);
        console.log(`Memory DB: ${dbPath()}`);
        console.log(`Platform: ${platform}`);
        if ("rulePath" in installInfo && installInfo.rulePath) {
          console.log(`Cursor rule: ${installInfo.rulePath}`);
        }
        if ("hooksPath" in installInfo && installInfo.hooksPath) {
          console.log(`Cursor hooks: ${installInfo.hooksPath}`);
        }
        if ("settingsPath" in installInfo && installInfo.settingsPath) {
          console.log(`Claude settings: ${installInfo.settingsPath}`);
        }
        for (const s of installInfo.skills) {
          console.log(`Skill: ${s}`);
        }
        console.log('Next: amem ui   or   amem context "What should I know?"');
        break;
      }
      case "status": {
        const workspaceFlag = flagString(flags, "workspace") || process.env.AMEM_WORKSPACE;
        const identity = workspaceFlag
          ? (() => {
              const bound = getRepoByName(workspaceFlag);
              if (!bound) throw new Error(`No workspace "${workspaceFlag}"`);
              return { rootPath: bound.root_path, repoKey: bound.repo_key, remoteUrl: bound.remote_url, repoName: bound.repo_name };
            })()
          : detectRepoIdentity();
        const repo = workspaceFlag ? getRepoByName(workspaceFlag) : getRepoByCwd();
        const policy = loadPolicy().policy;
        console.log(`cwd root: ${identity.rootPath}`);
        console.log(`repo key: ${identity.repoKey}`);
        console.log(`remote:   ${identity.remoteUrl ?? "(none)"}`);
        console.log(`amem home:${amemHome()}`);
        console.log(`db:       ${dbPath()}`);
        console.log(`export:   ${policy.allow_export ? "allowed" : "blocked by policy"}`);
        console.log(`ui:       ${policy.ui_enabled ? `enabled (${policy.ui_bind})` : "disabled by policy"}`);
        if (!repo) {
          console.log("binding:  not initialized");
        } else {
          const slug = parseWorkspaceSlug(repo.remote_url);
          console.log(`kind:     ${slug ? "workspace" : "git repo"}`);
          console.log(`binding:  ${repo.repo_name} (${repo.id})`);
          if (slug && slug !== repo.repo_name) {
            console.log(`mcp id:   ${slug}`);
          }
          console.log(`platform: ${repo.platform ?? "(unset)"}`);
          console.log(`claims:   ${listClaims(repo.id).length}`);
          console.log(`flows:    ${listFlows(repo.id).length}`);
          console.log(`components: ${listComponents(repo.id).length}`);
        }
        break;
      }
      case "rename": {
        const workspace = flagString(flags, "workspace") || process.env.AMEM_WORKSPACE;
        const name = positional.slice(1).join(" ").trim();
        if (!workspace || !name) {
          throw new Error('Usage: amem rename "<display name>" --workspace <slug>');
        }
        const repo = getRepoByName(workspace);
        if (!repo) throw new Error(`No workspace "${workspace}". Run: amem init --workspace ${workspace}`);
        const updated = renameWorkspace(repo.id, name);
        const slug = parseWorkspaceSlug(updated.remote_url);
        console.log(`Renamed to "${updated.repo_name}"`);
        if (slug) console.log(`MCP id unchanged: ${slug}  (claims stay on ${updated.id})`);
        break;
      }
      case "doctor": {
        if (flags.get("attest")) {
          const report = buildAttestReport();
          if (flags.get("json")) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            console.log(formatAttestHuman(report));
            console.log("");
            console.log("--- json ---");
            console.log(JSON.stringify(report, null, 2));
          }
          if (!report.ok) process.exitCode = 1;
          break;
        }
        const identity = detectRepoIdentity();
        const repo = getRepoByCwd();
        const issues: string[] = [];
        const loaded = loadPolicy();
        for (const src of loaded.sources) {
          if (src.error) issues.push(`Policy ${src.role}: ${src.error}`);
        }
        if (!repo) issues.push("Repo not initialized — run amem init");
        const platform = repo?.platform ?? flagString(flags, "platform");
        if (platform === "cursor") {
          issues.push(...cursorInstallHealth(identity.rootPath));
        } else if (platform === "claude") {
          issues.push(...claudeInstallHealth());
        } else if (repo && repo.platform !== "luna" && !(repo.remote_url || "").startsWith("amem://workspace/")) {
          issues.push(...cursorInstallHealth(identity.rootPath));
          issues.push(...claudeInstallHealth());
        }
        if (issues.length === 0) {
          console.log("amem doctor: ok");
        } else {
          console.log("amem doctor: issues found");
          for (const issue of issues) console.log(`- ${issue}`);
          process.exitCode = 1;
        }
        break;
      }
      case "context": {
        const query = positional.slice(1).join(" ").trim();
        if (!query) throw new Error('Usage: amem context "<query>"');
        const repo = resolveBinding(flags);
        const platform =
          flagString(flags, "platform") ??
          repo.platform ??
          "unknown";
        if (platform === "cursor" || platform === "claude") {
          assertPlatformAllowed(platform);
        }
        const sessionId =
          flagString(flags, "session-id") ??
          process.env.AMEM_SESSION_ID ??
          process.env.CURSOR_SESSION_ID ??
          process.env.CLAUDE_SESSION_ID;
        const { markdown, event } = logContextUsage({
          repoId: repo.id,
          platform,
          sessionId,
          query,
        });
        console.log(markdown);
        console.log("");
        console.log(
          `Usage logged: ${event.id} · estimated tokens saved ~${event.estimated_tokens_saved}`,
        );
        break;
      }
      case "remember": {
        const text = positional.slice(1).join(" ").trim();
        if (!text) throw new Error('Usage: amem remember "<text>" [--workspace <name>] [--kind session] [--anchor <path>]');
        const repo = resolveBinding(flags);
        const anchor = flagString(flags, "anchor");
        const result = handleApi({
          method: "POST",
          pathname: "/api/remember",
          searchParams: new URLSearchParams(),
          body: {
            text,
            repoId: repo.id,
            kind: flagString(flags, "kind") ?? "session",
            anchors: anchor ? [anchor] : undefined,
            source: "cli",
          },
          cwd: process.cwd(),
        });
        if (result.status >= 400) {
          throw new Error((result.body as { error?: string }).error || "remember failed");
        }
        const remembered = result.body as { claimId?: string; workspace?: string };
        console.log(`Remembered ${remembered.claimId} in ${remembered.workspace || repo.repo_name}`);
        break;
      }
      case "propose": {
        const sub = positional[1];
        const file = positional[2];
        if ((sub !== "validate" && sub !== "apply") || !file) {
          throw new Error("Usage: amem propose validate|apply <file.json>");
        }
        const policy = loadPolicy().policy;
        const proposal = loadProposalFile(resolve(file));
        let existingClaims = undefined as ReturnType<typeof listClaims> | undefined;
        try {
          existingClaims = listClaims(resolveBinding(flags).id, { includeSuperseded: true });
        } catch {
          // validate can run without a binding; conflict checks need one
        }
        const validated = validateProposal(proposal, policy, { existingClaims });
        if (!validated.ok) {
          console.error("Invalid proposal:");
          for (const e of validated.errors) console.error(`- ${e}`);
          process.exitCode = 1;
          break;
        }
        if (validated.warnings.length > 0) {
          console.log("Warnings:");
          for (const w of validated.warnings) console.log(`- ${w}`);
        }
        if (sub === "validate") {
          console.log("Proposal is valid.");
          break;
        }
        const repo = resolveBinding(flags);
        assertRemoteAllowed(repo.remote_url, policy);
        const result = applyProposal(repo.id, proposal, policy);
        const supersededBit =
          result.superseded > 0 ? `, ${result.superseded} superseded` : "";
        console.log(
          `Applied: ${result.claims} claims, ${result.flows} flows, ${result.components} components, ${result.edges} edges${supersededBit}`,
        );
        break;
      }
      case "export": {
        assertExportAllowed();
        const repo = resolveBinding(flags);
        const data = {
          exported_at: new Date().toISOString(),
          repo: {
            id: repo.id,
            repo_key: repo.repo_key,
            repo_name: repo.repo_name,
            remote_url: repo.remote_url,
          },
          ...exportRepoMemory(repo.id),
        };
        const out = flagString(flags, "out");
        const json = `${JSON.stringify(data, null, 2)}\n`;
        if (out) {
          const path = resolve(out);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, json, "utf8");
          console.log(`Wrote personal export to ${path}`);
          console.log("Do not commit this file to a shared repository.");
        } else {
          process.stdout.write(json);
        }
        break;
      }
      case "wipe": {
        if (!flags.get("yes")) {
          throw new Error("Refusing to wipe without --yes");
        }
        if (flags.get("all")) {
          const count = wipeAllRepos();
          closeDb();
          // Remove local memory home for IT offboarding (db + sessions + user policy).
          rmSync(amemHome(), { recursive: true, force: true });
          console.log(`Wiped all local amem data (${count} repos) under ${amemHome()}`);
          break;
        }
        const repo = resolveBinding(flags);
        wipeRepo(repo.id);
        console.log(`Wiped local memory for ${repo.repo_name}`);
        break;
      }
      case "session": {
        const sub = positional[1];
        if (sub !== "touch") throw new Error("Usage: amem session touch --platform <p>");
        const platform = flagString(flags, "platform");
        if (platform !== "cursor" && platform !== "claude") {
          throw new Error("--platform cursor|claude required");
        }
        assertPlatformAllowed(platform);
        const repo = getRepoByCwd();
        if (!repo) {
          process.exit(0);
        }
        const sessionId =
          flagString(flags, "session-id") ??
          process.env.AMEM_SESSION_ID ??
          process.env.CURSOR_SESSION_ID ??
          process.env.CLAUDE_SESSION_ID ??
          "unknown";
        touchSession(platform, sessionId, repo.id);
        break;
      }
      case "hook": {
        try {
          const result = handleHookPayload(await readStdin());
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } catch {
          process.stdout.write(`${JSON.stringify({ continue: true })}\n`);
        }
        break;
      }
      case "usage": {
        const sub = positional[1];
        if (sub !== "report") {
          throw new Error(
            "Usage: amem usage report --saved <n> [--platform cursor|claude] [--event-id <id>]",
          );
        }
        const savedRaw = flagString(flags, "saved");
        if (savedRaw === undefined) throw new Error("--saved <n> required");
        const saved = Number(savedRaw);
        if (!Number.isFinite(saved) || saved < 0) {
          throw new Error("--saved must be a non-negative number");
        }
        const eventId = flagString(flags, "event-id");
        if (eventId) {
          const event = setReportedTokensSaved(eventId, saved);
          console.log(`Updated ${event.id} reported_tokens_saved=${saved}`);
          break;
        }
        const repo = resolveBinding(flags);
        const platform = flagString(flags, "platform") ?? repo.platform ?? "unknown";
        const event = setReportedOnLatest(repo.id, platform, saved);
        console.log(`Updated ${event.id} reported_tokens_saved=${saved}`);
        break;
      }
      case "ui": {
        assertUiAllowed();
        const policy = loadPolicy().policy;
        const port = Number(flagString(flags, "port") ?? "7843");
        const openBrowser = !flags.get("no-open");
        const landing = buildUiLandingUrl(port, process.cwd());
        try {
          const server = await startUiServer({
            port,
            cwd: process.cwd(),
            openBrowser,
            host: policy.ui_bind,
            landingUrl: landing,
          });
          console.log(`amem ui at ${server.url} (localhost only)`);
          console.log(`focused: ${process.cwd()}`);
          console.log("Press Ctrl+C to stop.");
          await new Promise(() => {
            // run until killed
          });
        } catch (error) {
          if (!isAddrInUse(error)) throw error;
          if (openBrowser) openUiInBrowser(landing);
          console.log(`amem ui already running — opened setup:`);
          console.log(landing);
          closeDb();
        }
        break;
      }
      case "service": {
        const sub = positional[1];
        if (sub === "status") {
          console.log(`login item: ${isServiceInstalled() ? "installed" : "not installed"}`);
          break;
        }
        if (sub === "install") {
          const result = installLoginService();
          console.log(`Installed login item: ${result.path}`);
          console.log("amem ui will start on login (localhost only).");
          break;
        }
        if (sub === "uninstall") {
          const result = uninstallLoginService();
          console.log(`Removed login item: ${result.path}`);
          break;
        }
        throw new Error("Usage: amem service install|uninstall|status");
      }
      case "mcp": {
        if (flags.get("print-config")) {
          const ws = flagString(flags, "workspace") || process.env.AMEM_WORKSPACE || "my-app";
          console.log(JSON.stringify(mcpClientConfig(ws), null, 2));
          break;
        }
        await runMcpServer();
        break;
      }
      case "help":
      case "--help":
      case "-h":
        usage();
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        usage();
    }
  } finally {
    if (cmd !== "ui" && cmd !== "mcp") closeDb();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  closeDb();
  process.exit(1);
});
