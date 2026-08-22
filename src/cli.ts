#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
  openDb,
} from "./db.js";
import { handleHookPayload } from "./hook.js";
import { installClaude, claudeInstallHealth } from "./install/claude.js";
import { installCursor, cursorInstallHealth } from "./install/cursor.js";
import { installHost } from "./install/hosts.js";
import { amemHome, dbPath, tryEnsureDir } from "./paths.js";
import {
  assertExportAllowed,
  assertPlatformAllowed,
  assertRemoteAllowed,
  assertUiAllowed,
  loadPolicy,
} from "./policy.js";
import {
  applyProposal,
  diffProposal,
  exportRepoMemory,
  formatProposalDiff,
  loadProposalFile,
  validateProposal,
} from "./proposal.js";
import { detectRepoIdentity, parseWorkspaceSlug, workspaceIdentity } from "./repo-identity.js";
import {
  startUiServer,
  buildUiLandingUrl,
  openUiInBrowser,
  isAddrInUse,
  probeUiHealth,
} from "./ui/server.js";
import { installLoginService, isServiceInstalled, isServiceSupported, uninstallLoginService } from "./service.js";
import { mcpClientConfig, runMcpServer } from "./mcp.js";
import { provisionWorkspace } from "./workspace-setup.js";
import { HOST_INSTALL_IDS } from "./platforms.js";
import { ensurePersonalWorkspace, PERSONAL_SLUG } from "./personal.js";
import {
  createBackup,
  defaultBackupDir,
  encryptedDbPath,
  isDbEncryptedAtRest,
  lockDatabase,
  resolvePassphrase,
  restoreBackup,
  unlockDatabase,
} from "./crypto.js";
import {
  installBackupSchedule,
  isBackupScheduleInstalled,
  uninstallBackupSchedule,
  writeBackupHelperScript,
  backupSchedulePath,
} from "./backup-schedule.js";
import { rememberContract } from "./remember-contract.js";
import { vaultStatus } from "./vault.js";
import {
  applyLicenseFile,
  clearLicense,
  generateLicenseKeys,
  licenseStatus,
  signLicense,
} from "./license.js";
import {
  embedIndexIssues,
  embedStatus,
  reindexAllEmbeds,
  setEmbedBackend,
} from "./embed.js";
import { acceptSafeCleanups, decayStaleClaims, hygieneReport, mergeDuplicate, runScheduledHygiene } from "./hygiene.js";
import {
  hygieneSchedulePath,
  installHygieneSchedule,
  isHygieneScheduleInstalled,
  uninstallHygieneSchedule,
  writeHygieneHelperScript,
} from "./hygiene-schedule.js";
import { syncPinnedRules } from "./rules-sync.js";
import { buildSbom, writeItPack } from "./it-pack.js";

function usage(): never {
  console.log(`amem — local personal agent memory

Usage:
  amem setup [--personal] [--platform <host>]
  amem init --platform cursor|claude|windsurf|continue|aider|zed
  amem init --workspace <name> [--path <dir>] [--platform …]
  amem init --personal
  amem rename "<display name>" --workspace <slug>
  amem status [--workspace <name>]
  amem doctor [--attest] [--json]
  amem context "<query>" [--workspace <name>] [--platform cursor|claude|luna]
  amem remember "<text>" [--workspace <name>] [--kind session] [--anchor <path>]
  amem recipe [--json]
  amem propose validate <file.json>
  amem propose diff <file.json>
  amem propose apply <file.json>
  amem export [--out <file.json>]
  amem wipe --yes
  amem wipe --all --yes
  amem lock --passphrase <secret>
  amem unlock --passphrase <secret>
  amem backup [--out <dir>] [--passphrase <secret>] [--label <name>]
  amem backup schedule [--out <dir>] [--hour <0-23>]
  amem backup unschedule
  amem restore --file <backup.db|backup.db.enc> [--passphrase <secret>]
  amem hygiene [--days 90] [--decay] [--accept-safe] [--merge <keepId> <dropId>]
  amem hygiene --scheduled
  amem hygiene schedule [--hour <0-23>]
  amem hygiene unschedule
  amem rules sync
  amem it-pack [--out <dir>]
  amem doctor [--attest] [--sbom] [--json]
  amem session touch --platform cursor|claude [--session-id <id>]
  amem hook
  amem usage report --saved <n> [--platform cursor|claude] [--event-id <id>]
  amem usage export [--format json|md|pdf] [--days 30] [--scope current|all] [--out <file>]
  amem ui [--port 7843] [--no-open]
  amem service install|uninstall|status
  amem mcp [--print-config] [--workspace <name>]
  amem license status|apply|clear|issue|keys
  amem embed status|use hash|use ngram|use external|reindex

Install:
  npx @iamem/amem setup
  npm i -g @iamem/amem && amem setup
  # or from a clone: npm install && npm link && amem setup

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
  if (!cmd) {
    console.log("amem — local personal agent memory\n");
    console.log("Quick start:  amem setup");
    console.log("Help:         amem help\n");
    console.log(`Home: ${amemHome()}`);
    process.exit(0);
  }

  try {
    switch (cmd) {
      case "setup": {
        const personal = Boolean(flags.get("personal")) || !flagString(flags, "platform");
        if (personal || flags.get("personal")) {
          const repo = ensurePersonalWorkspace(flagString(flags, "platform") ?? "app");
          console.log(`Personal prefs workspace ready: ${repo.repo_name} (${repo.id})`);
          console.log(`  remember: amem remember "I prefer …" --workspace ${PERSONAL_SLUG}`);
        }
        const platform = flagString(flags, "platform");
        if (platform && HOST_INSTALL_IDS.has(platform)) {
          const result = installHost(platform, {
            repoRoot: process.cwd(),
            workspace: PERSONAL_SLUG,
          });
          console.log(`Installed host hints for ${result.host}:`);
          for (const p of result.paths) console.log(`  ${p}`);
          for (const n of result.notes) console.log(`  note: ${n}`);
        } else if (platform === "cursor") {
          const identity = detectRepoIdentity();
          const info = installCursor(identity.rootPath);
          console.log(`Cursor install under ${identity.rootPath}`);
          for (const s of info.skills) console.log(`  skill: ${s}`);
        } else if (platform === "claude") {
          const info = installClaude(detectRepoIdentity().rootPath);
          console.log("Claude Code hooks/skills installed");
          for (const s of info.skills) console.log(`  skill: ${s}`);
        }
        console.log(`Memory DB: ${dbPath()}`);
        console.log("Next: amem ui   or   amem context \"What should I know?\"");
        console.log("Host recipe (any MCP client): amem recipe");
        console.log("Install: npx @iamem/amem setup  (or npm i -g @iamem/amem)");
        break;
      }
      case "init": {
        if (flags.get("personal")) {
          const repo = ensurePersonalWorkspace(flagString(flags, "platform") ?? "app");
          upsertSetupState(repo.id, [repo.platform ?? "app"], true);
          console.log(`Personal prefs workspace ${repo.repo_name} (${repo.id})`);
          console.log(`Memory DB: ${dbPath()}`);
          console.log(`Root: ${repo.root_path}`);
          console.log(`Use: amem remember "…" --workspace ${PERSONAL_SLUG}`);
          break;
        }
        const workspace = flagString(flags, "workspace");
        if (workspace) {
          const platform = flagString(flags, "platform") ?? "app";
          const slugPath = join(amemHome(), "workspaces", workspace.toLowerCase());
          const root = resolve(flagString(flags, "path") ?? slugPath);
          tryEnsureDir(root);
          const identity = workspaceIdentity(workspace, root);
          const repo = upsertRepo(identity, platform);
          upsertSetupState(repo.id, [platform], true);
          if (platform === "cursor") installCursor(identity.rootPath);
          else if (platform === "claude") installClaude(identity.rootPath);
          else if (HOST_INSTALL_IDS.has(platform)) {
            installHost(platform, { repoRoot: identity.rootPath, workspace });
          }
          const ready = provisionWorkspace(repo, platform);
          console.log(`Workspace ${repo.repo_name} (${repo.id})`);
          console.log(`Memory DB: ${dbPath()}`);
          console.log(`Root: ${repo.root_path}`);
          console.log(`Platform: ${platform}`);
          for (const line of ready.checks) console.log(`Ready: ${line}`);
          break;
        }
        const platform = flagString(flags, "platform");
        if (!platform) {
          throw new Error(
            "amem init requires --platform cursor|claude|windsurf|continue|aider|zed, --workspace <name>, or --personal",
          );
        }
        const policy = loadPolicy().policy;
        assertPlatformAllowed(platform, policy);
        const identity = detectRepoIdentity();
        assertRemoteAllowed(identity.remoteUrl, policy);
        const repo = upsertRepo(identity, platform);
        let installInfo: { skills?: string[]; rulePath?: string; hooksPath?: string; settingsPath?: string; paths?: string[]; notes?: string[]; host?: string } = { skills: [] };
        if (platform === "cursor") {
          installInfo = installCursor(identity.rootPath);
        } else if (platform === "claude") {
          installInfo = installClaude(identity.rootPath);
        } else if (HOST_INSTALL_IDS.has(platform)) {
          installInfo = installHost(platform, {
            repoRoot: identity.rootPath,
            workspace: identity.repoName,
          });
        } else {
          throw new Error(
            `Unknown platform "${platform}". Use cursor|claude|windsurf|continue|aider|zed`,
          );
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
        if (installInfo.skills) {
          for (const s of installInfo.skills) console.log(`Skill: ${s}`);
        }
        if (installInfo.paths) {
          for (const p of installInfo.paths) console.log(`Config: ${p}`);
        }
        if (installInfo.notes) {
          for (const n of installInfo.notes) console.log(`Note: ${n}`);
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
        console.log(`encrypted:${isDbEncryptedAtRest() ? `yes (${encryptedDbPath()})` : existsSync(encryptedDbPath()) ? "unlocked (enc copy present)" : "no"}`);
        console.log(`export:   ${policy.allow_export ? "allowed" : "blocked by policy"}`);
        console.log(`ui:       ${policy.ui_enabled ? `enabled (${policy.ui_bind})` : "disabled by policy"}`);
        console.log(`auto-apply kinds: ${(policy.auto_apply_kinds ?? []).join(", ") || "(none)"}`);
        const vault = vaultStatus();
        console.log(`backup schedule: ${isBackupScheduleInstalled() ? backupSchedulePath() : "not installed"}`);
        console.log(
          `last backup: ${vault.backup.last ? `${vault.backup.last.name} (${vault.backup.last.mtime})` : "none"}`,
        );
        const lic = licenseStatus();
        console.log(`license:  ${lic.tier} (${lic.kind}${lic.valid ? "" : ", invalid"})`);
        const emb = embedStatus();
        console.log(`embed:    ${emb.backend} dim=${emb.dim}${emb.requested !== emb.backend ? ` (requested ${emb.requested})` : ""}`);
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
        if (flags.get("sbom")) {
          const sbom = buildSbom();
          const out = flagString(flags, "out");
          const json = `${JSON.stringify(sbom, null, 2)}\n`;
          if (out) {
            writeFileSync(resolve(out), json, "utf8");
            console.log(`Wrote SBOM to ${resolve(out)}`);
          } else {
            process.stdout.write(json);
          }
          break;
        }
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
        try {
          issues.push(...embedIndexIssues(openDb()));
        } catch {
          // A locked or absent vault is reported elsewhere; don't fail doctor on it.
        }
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
      case "recipe": {
        const contract = rememberContract();
        if (flags.get("json")) {
          console.log(JSON.stringify(contract, null, 2));
        } else {
          console.log(contract.paste);
        }
        break;
      }
      case "propose": {
        const sub = positional[1];
        const file = positional[2];
        if ((sub !== "validate" && sub !== "apply" && sub !== "diff") || !file) {
          throw new Error("Usage: amem propose validate|diff|apply <file.json>");
        }
        const policy = loadPolicy().policy;
        const proposal = loadProposalFile(resolve(file));
        let existingClaims = undefined as ReturnType<typeof listClaims> | undefined;
        let repoId: string | null = null;
        try {
          const bound = resolveBinding(flags);
          repoId = bound.id;
          existingClaims = listClaims(bound.id, { includeSuperseded: true });
        } catch {
          // validate/diff can run without a binding; conflict checks need one
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
        if (repoId) {
          console.log(formatProposalDiff(diffProposal(repoId, proposal)));
        }
        if (sub === "validate" || sub === "diff") {
          console.log(sub === "diff" ? "Diff complete." : "Proposal is valid.");
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
      case "lock": {
        const passphrase = resolvePassphrase(flagString(flags, "passphrase"));
        closeDb();
        const result = lockDatabase(passphrase);
        console.log(`Locked database → ${result.encPath}`);
        console.log("Plaintext graph.db removed. Unlock with: amem unlock --passphrase …");
        break;
      }
      case "unlock": {
        const passphrase = resolvePassphrase(flagString(flags, "passphrase"));
        closeDb();
        const result = unlockDatabase(passphrase);
        console.log(`Unlocked database → ${result.dbPath}`);
        console.log("Keep AMEM_PASSPHRASE set in your shell if you re-lock between sessions.");
        break;
      }
      case "backup": {
        const sub = positional[1];
        if (sub === "schedule") {
          const out = flagString(flags, "out");
          const hourRaw = flagString(flags, "hour");
          const hour = hourRaw !== undefined ? Number(hourRaw) : undefined;
          if (hour !== undefined && (!Number.isFinite(hour) || hour < 0 || hour > 23)) {
            throw new Error("--hour must be 0–23");
          }
          const result = installBackupSchedule({ outDir: out, hour });
          const helper = writeBackupHelperScript(result.outDir);
          console.log(`Scheduled local backup (${result.platform}): ${result.path}`);
          console.log(`Backup dir: ${result.outDir}`);
          console.log(`Helper script: ${helper}`);
          console.log("Passphrase (if set via AMEM_PASSPHRASE) is used by `amem backup` when encrypting.");
          break;
        }
        if (sub === "unschedule") {
          const result = uninstallBackupSchedule();
          console.log(`Removed backup schedule (${result.platform}): ${result.path}`);
          break;
        }
        if (sub && sub !== "now") {
          throw new Error("Usage: amem backup [--out <dir>] [--passphrase …] | amem backup schedule|unschedule");
        }
        closeDb();
        let passphrase: string | undefined;
        try {
          passphrase = resolvePassphrase(flagString(flags, "passphrase"));
        } catch {
          passphrase = undefined;
        }
        const result = createBackup({
          outDir: flagString(flags, "out") || defaultBackupDir(),
          passphrase,
          label: flagString(flags, "label"),
        });
        console.log(`Backup written: ${result.path}`);
        console.log(`Encrypted: ${result.encrypted ? "yes" : "no (pass --passphrase to encrypt)"}`);
        break;
      }
      case "restore": {
        const file = flagString(flags, "file") || positional[1];
        if (!file) throw new Error("Usage: amem restore --file <backup.db|backup.db.enc>");
        closeDb();
        let passphrase: string | undefined;
        try {
          passphrase = resolvePassphrase(flagString(flags, "passphrase"));
        } catch {
          passphrase = undefined;
        }
        const result = restoreBackup({ file: resolve(file), passphrase });
        openDb();
        console.log(`Restored ${result.dbPath} from ${result.from}`);
        if (result.safetyCopy) console.log(`Previous DB saved at ${result.safetyCopy}`);
        break;
      }
      case "hygiene": {
        const sub = positional[1];
        if (sub === "schedule") {
          const hourRaw = flagString(flags, "hour");
          const hour = hourRaw !== undefined ? Number(hourRaw) : undefined;
          if (hour !== undefined && (!Number.isFinite(hour) || hour < 0 || hour > 23)) {
            throw new Error("--hour must be 0–23");
          }
          const result = installHygieneSchedule({ hour });
          const helper = writeHygieneHelperScript();
          console.log(`Scheduled weekly hygiene (${result.platform}): ${result.path}`);
          console.log(`Runs Sunday ~${result.hour}:20 local (Pro/IT required at run time)`);
          console.log(`Helper script: ${helper}`);
          break;
        }
        if (sub === "unschedule") {
          const result = uninstallHygieneSchedule();
          console.log(`Removed hygiene schedule (${result.platform}): ${result.path}`);
          break;
        }
        if (flags.get("scheduled") || sub === "run") {
          const days = Number(flagString(flags, "days") ?? "90");
          const result = runScheduledHygiene(Number.isFinite(days) ? days : 90);
          if (result.skipped) {
            console.log(`Hygiene schedule skipped: ${result.reason}`);
            break;
          }
          for (const row of result.repos) {
            if (row.error) console.log(`${row.name}: error — ${row.error}`);
            else console.log(`${row.name}: decayed ${row.decayed}, merged ${row.merged}`);
          }
          break;
        }
        const repo = resolveBinding(flags);
        const days = Number(flagString(flags, "days") ?? "90");
        const keep = flagString(flags, "merge");
        if (keep) {
          const drop = positional[2] || positional[1];
          if (!drop) throw new Error("Usage: amem hygiene --merge <keepId> <dropId>");
          const merged = mergeDuplicate(repo.id, keep, drop);
          console.log(`Merged ${merged.dropId} into ${merged.keepId}`);
          break;
        }
        if (flags.get("accept-safe")) {
          const result = acceptSafeCleanups(repo.id, Number.isFinite(days) ? days : 90);
          console.log(`Decayed ${result.decayed.length}; merged ${result.merged.length}`);
          break;
        }
        const report = hygieneReport(repo.id, Number.isFinite(days) ? days : 90);
        if (flags.get("decay")) {
          const result = decayStaleClaims(repo.id, Number.isFinite(days) ? days : 90);
          console.log(`Decayed ${result.decayed.length} unused facts`);
          break;
        }
        if (flags.get("json")) console.log(JSON.stringify(report, null, 2));
        else {
          console.log(`active: ${report.active}`);
          console.log(`stale (unused ${Number.isFinite(days) ? days : 90}d): ${report.stale.length}`);
          console.log(`duplicates: ${report.duplicates.length}`);
          console.log(`pending drafts: ${report.pendingDrafts}`);
          console.log(
            `schedule: ${isHygieneScheduleInstalled() ? hygieneSchedulePath() : "not installed"}`,
          );
          for (const d of report.duplicates.slice(0, 8)) {
            console.log(`  merge ${d.dropId} → ${d.keepId} (${Math.round(d.similarity * 100)}%)`);
          }
        }
        break;
      }
      case "rules": {
        if (positional[1] !== "sync") throw new Error("Usage: amem rules sync");
        const repo = resolveBinding(flags);
        const result = syncPinnedRules(repo);
        console.log(`Wrote ${result.pinned} pinned facts → ${result.path}`);
        console.log("Keep this file out of shared git if it contains personal notes.");
        break;
      }
      case "it-pack": {
        const out = resolve(flagString(flags, "out") || join(amemHome(), "it-pack"));
        const result = writeItPack(out);
        console.log(`IT pack written to ${result.dir}`);
        for (const f of result.files) console.log(`  ${f}`);
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
        if (sub === "export") {
          const format = flagString(flags, "format") ?? "json";
          const days = flagString(flags, "days") ?? "30";
          const scope = flagString(flags, "scope") ?? "current";
          const repo = scope === "all" ? null : resolveBinding(flags);
          const result = handleApi({
            method: "GET",
            pathname: "/api/usage/export",
            searchParams: new URLSearchParams({
              format,
              days,
              scope,
              ...(repo ? { repo: repo.id } : {}),
            }),
            body: null,
            cwd: process.cwd(),
          });
          if (result.status >= 400) {
            throw new Error((result.body as { error?: string }).error || "export failed");
          }
          const payload = result.body as {
            filename?: string;
            markdown?: string;
            contentBase64?: string;
            report?: unknown;
          };
          const out =
            flagString(flags, "out") ||
            join(process.cwd(), payload.filename || `amem-savings.${format}`);
          if (payload.contentBase64) {
            writeFileSync(out, Buffer.from(payload.contentBase64, "base64"));
          } else if (payload.markdown) {
            writeFileSync(out, payload.markdown, "utf8");
          } else {
            writeFileSync(out, JSON.stringify(payload.report ?? payload, null, 2), "utf8");
          }
          console.log(`Wrote savings export to ${out}`);
          console.log("Proxy only — not a Cursor or model bill.");
          break;
        }
        if (sub !== "report") {
          throw new Error(
            "Usage: amem usage report --saved <n> | amem usage export [--format json|md|pdf]",
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
          const probe = await probeUiHealth(port);
          if (!probe.hasVault) {
            console.error(`Port ${port} is already serving an older amem without lock/backup APIs.`);
            console.error("Stop that process, then run amem ui again:");
            console.error(`  lsof -nP -iTCP:${port} -sTCP:LISTEN`);
            closeDb();
            process.exitCode = 1;
            break;
          }
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
          console.log(`platform: ${process.platform}`);
          console.log(`supported: ${isServiceSupported() ? "yes" : "no"}`);
          console.log(`login item: ${isServiceInstalled() ? "installed" : "not installed"}`);
          break;
        }
        if (sub === "install") {
          const result = installLoginService();
          console.log(`Installed login item (${result.platform}): ${result.path}`);
          console.log("amem ui will start on login (localhost only).");
          break;
        }
        if (sub === "uninstall") {
          const result = uninstallLoginService();
          console.log(`Removed login item (${result.platform}): ${result.path}`);
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
      case "license": {
        const sub = positional[1];
        if (!sub || sub === "status") {
          const status = licenseStatus();
          if (flags.get("json")) console.log(JSON.stringify(status, null, 2));
          else {
            console.log(`tier: ${status.tier} (${status.kind}${status.valid ? "" : ", invalid"})`);
            console.log(`features: ${status.features.join(", ") || "(none)"}`);
            console.log(`path: ${status.path}`);
            if (status.issues.length) {
              for (const issue of status.issues) console.log(`issue: ${issue}`);
            }
          }
          break;
        }
        if (sub === "apply") {
          const file = flagString(flags, "file") || positional[2];
          if (!file) throw new Error("Usage: amem license apply --file <license.json>");
          const status = applyLicenseFile(file);
          console.log(`Applied ${status.kind} license · tier ${status.tier}`);
          break;
        }
        if (sub === "activate") {
          throw new Error(
            "Self-activate is disabled. Buy Pro/IT at https://getamem.com then: amem license apply --file <amem-license.json>",
          );
        }
        if (sub === "clear") {
          clearLicense();
          console.log("License cleared · tier free");
          break;
        }
        if (sub === "issue") {
          const priv = process.env.AMEM_LICENSE_PRIVKEY;
          if (!priv) throw new Error("Set AMEM_LICENSE_PRIVKEY to issue a signed license");
          const tier = flagString(flags, "tier");
          if (tier !== "pro" && tier !== "it" && tier !== "free") {
            throw new Error("--tier must be free, pro, or it");
          }
          const issued = signLicense(priv, {
            tier,
            subject: flagString(flags, "subject"),
            issued_at: new Date().toISOString(),
            expires_at: flagString(flags, "expires"),
          });
          const out = flagString(flags, "out") || "amem-license.json";
          writeFileSync(out, `${JSON.stringify(issued, null, 2)}\n`, "utf8");
          console.log(`Wrote signed license to ${out}`);
          break;
        }
        if (sub === "keys") {
          const keys = generateLicenseKeys();
          const dir = flagString(flags, "out-dir");
          if (dir) {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            writeFileSync(join(dir, "license.pub"), `${keys.publicKeyHex}\n`, { mode: 0o644 });
            writeFileSync(join(dir, "license.priv"), `${keys.privateKeyHex}\n`, { mode: 0o600 });
            console.log(`Wrote shop/.data-style keys under ${dir}`);
            console.log(`public: ${keys.publicKeyHex}`);
            console.log("Put that public hex in src/license.ts DEFAULT_LICENSE_PUBKEY_HEX if it differs.");
            break;
          }
          console.log(`public: ${keys.publicKeyHex}`);
          console.log(`private: ${keys.privateKeyHex}`);
          break;
        }
        throw new Error("Usage: amem license status|apply|clear|issue|keys");
      }
      case "embed": {
        const sub = positional[1];
        if (!sub || sub === "status") {
          const status = embedStatus();
          if (flags.get("json")) console.log(JSON.stringify(status, null, 2));
          else {
            console.log(`backend: ${status.backend} (requested ${status.requested})`);
            console.log(`dim: ${status.dim}`);
            console.log(`licensed: ${status.licensed}`);
          }
          break;
        }
        if (sub === "use") {
          const backend = positional[2];
          if (backend !== "hash" && backend !== "ngram" && backend !== "external") {
            throw new Error("Usage: amem embed use hash|ngram|external --cmd <bin>");
          }
          const cmd = flagString(flags, "cmd") || flagString(flags, "command");
          const dimRaw = flagString(flags, "dim");
          const status = setEmbedBackend(backend, {
            command: cmd,
            args: flagString(flags, "args")?.split(/\s+/).filter(Boolean),
            dim: dimRaw ? Number(dimRaw) : undefined,
          });
          console.log(`Embed backend ${status.backend} dim=${status.dim}`);
          if (status.command) console.log(`command: ${status.command} ${status.args.join(" ")}`);
          console.log("Reindex with: amem embed reindex");
          break;
        }
        if (sub === "reindex") {
          const result = reindexAllEmbeds(openDb());
          console.log(`Reindexed ${result.claims} claims across ${result.repos} repos (${embedStatus().backend})`);
          break;
        }
        throw new Error("Usage: amem embed status|use hash|use ngram|reindex");
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
