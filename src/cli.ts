#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildAttestReport, formatAttestHuman } from "./attest.js";
import { logContextUsage } from "./api/routes.js";
import {
  closeDb,
  getRepoByCwd,
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
import { detectRepoIdentity } from "./repo-identity.js";
import { startUiServer } from "./ui/server.js";

function usage(): never {
  console.log(`amem — local personal agent memory

Usage:
  amem init --platform cursor|claude
  amem status
  amem doctor [--attest] [--json]
  amem context "<query>" [--platform cursor|claude]
  amem propose validate <file.json>
  amem propose apply <file.json>
  amem export [--out <file.json>]
  amem wipe --yes
  amem wipe --all --yes
  amem session touch --platform cursor|claude [--session-id <id>]
  amem usage report --saved <n> [--platform cursor|claude] [--event-id <id>]
  amem ui [--port 7843] [--no-open]

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

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv);
  const cmd = positional[0];
  if (!cmd) usage();

  try {
    switch (cmd) {
      case "init": {
        const platform = flagString(flags, "platform");
        if (platform !== "cursor" && platform !== "claude") {
          throw new Error("amem init requires --platform cursor|claude");
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
        const identity = detectRepoIdentity();
        const repo = getRepoByCwd();
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
          console.log(`binding:  ${repo.repo_name} (${repo.id})`);
          console.log(`platform: ${repo.platform ?? "(unset)"}`);
          console.log(`claims:   ${listClaims(repo.id).length}`);
          console.log(`flows:    ${listFlows(repo.id).length}`);
          console.log(`components: ${listComponents(repo.id).length}`);
        }
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
        } else if (repo) {
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
        const repo = requireRepo();
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
      case "propose": {
        const sub = positional[1];
        const file = positional[2];
        if ((sub !== "validate" && sub !== "apply") || !file) {
          throw new Error("Usage: amem propose validate|apply <file.json>");
        }
        const policy = loadPolicy().policy;
        const proposal = loadProposalFile(resolve(file));
        const validated = validateProposal(proposal, policy);
        if (!validated.ok) {
          console.error("Invalid proposal:");
          for (const e of validated.errors) console.error(`- ${e}`);
          process.exitCode = 1;
          break;
        }
        if (sub === "validate") {
          console.log("Proposal is valid.");
          break;
        }
        const identity = detectRepoIdentity();
        assertRemoteAllowed(identity.remoteUrl, policy);
        const repo = requireRepo();
        const result = applyProposal(repo.id, proposal, policy);
        console.log(
          `Applied: ${result.claims} claims, ${result.flows} flows, ${result.components} components, ${result.edges} edges`,
        );
        break;
      }
      case "export": {
        assertExportAllowed();
        const repo = requireRepo();
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
        const repo = requireRepo();
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
        const repo = requireRepo();
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
        const server = await startUiServer({
          port,
          cwd: process.cwd(),
          openBrowser,
          host: policy.ui_bind,
        });
        console.log(`amem ui at ${server.url} (localhost only)`);
        console.log(`cwd: ${process.cwd()}`);
        console.log("Press Ctrl+C to stop.");
        await new Promise(() => {
          // run until killed
        });
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
    if (cmd !== "ui") closeDb();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  closeDb();
  process.exit(1);
});
