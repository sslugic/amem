import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRepoByCwd, getSetupState, openDb } from "./db.js";
import { claudeInstallHealth } from "./install/claude.js";
import { cursorInstallHealth } from "./install/cursor.js";
import { amemHome, dbPath, ensureAmemHome } from "./paths.js";
import {
  BUILTIN_DENY_CLAIM_PATTERNS,
  effectiveDenyPatterns,
  loadPolicy,
  type LoadedPolicy,
} from "./policy.js";
import { detectRepoIdentity } from "./repo-identity.js";
import { FEATURE_ATTEST_SKU, hasFeature, licenseStatus } from "./license.js";
import { embedIndexIssues, embedStatus } from "./embed.js";
import { vaultStatus } from "./vault.js";
import { hostInstallHealth } from "./install/hosts.js";
import { listSkillDrafts } from "./db.js";
import { scanSkills, skillsDir } from "./skills.js";

export type AttestReport = {
  tool: "amem";
  version: string;
  package_integrity: {
    package_json_sha256: string | null;
  };
  attested_at: string;
  privacy: {
    telemetry: false;
    network_egress: "none";
    ui_bind: string;
    ui_enabled: boolean;
    memory_home: string;
    memory_home_mode: string | null;
    db_path: string;
    db_exists: boolean;
  };
  policy: {
    sources: LoadedPolicy["sources"];
    effective: LoadedPolicy["policy"];
    builtin_deny_claim_patterns: string[];
    effective_deny_claim_patterns: string[];
  };
  repo: {
    root_path: string;
    repo_key: string;
    remote_url: string | null;
    bound: boolean;
    platform: string | null;
  };
  platforms: {
    cursor_issues: string[];
    claude_issues: string[];
  };
  license: ReturnType<typeof licenseStatus>;
  embed: ReturnType<typeof embedStatus>;
  /** Procedural memory an auditor should be able to review: what agents may be told to do. */
  skills: {
    dir: string;
    enabled: boolean;
    write_approval: boolean;
    pending_drafts: number;
    installed: Array<{ name: string; description: string; source: string; hash: string }>;
  };
  sku?: {
    tier: string;
    airgap: true;
    network_egress: "none";
    vault: ReturnType<typeof vaultStatus>;
    host_health: Record<string, string[]>;
  };
  ok: boolean;
  issues: string[];
};

function packageRoot(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  // dist/ -> package root
  return join(here, "..");
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function sha256File(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function modeOctal(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return (statSync(path).mode & 0o777).toString(8).padStart(3, "0");
  } catch {
    return null;
  }
}

export function buildAttestReport(cwd: string = process.cwd()): AttestReport {
  ensureAmemHome();
  const loaded = loadPolicy(true);
  const identity = detectRepoIdentity(cwd);
  const repo = getRepoByCwd(cwd);
  const issues: string[] = [];

  for (const src of loaded.sources) {
    if (src.error) issues.push(`Policy ${src.role} (${src.path}): ${src.error}`);
  }

  if (loaded.policy.telemetry) {
    issues.push("telemetry unexpectedly enabled (hard-stop failed)");
  }
  if (loaded.policy.ui_bind !== "127.0.0.1" && loaded.policy.ui_bind !== "localhost") {
    issues.push(`ui_bind must be loopback, got ${loaded.policy.ui_bind}`);
  }

  const homeMode = modeOctal(amemHome());
  if (homeMode && homeMode !== "700") {
    issues.push(`amem home mode is ${homeMode}, expected 700`);
  }

  let cursorIssues: string[] = [];
  let claudeIssues: string[] = [];
  let platforms: string[] = [];
  if (repo) {
    try {
      const setup = getSetupState(repo.id);
      platforms = setup ? (JSON.parse(setup.platforms) as string[]) : [];
    } catch {
      platforms = [];
    }
    if (platforms.length === 0 && repo.platform) platforms = [repo.platform];
  }

  const checkCursor =
    platforms.includes("cursor") || repo?.platform === "cursor" || platforms.length === 0;
  const checkClaude =
    platforms.includes("claude") || repo?.platform === "claude" || platforms.length === 0;

  if (repo) {
    if (checkCursor) cursorIssues = cursorInstallHealth(identity.rootPath);
    if (checkClaude) claudeIssues = claudeInstallHealth();
  } else {
    issues.push("Repo not initialized — run amem init");
  }

  issues.push(...cursorIssues, ...claudeIssues);

  const license = licenseStatus();
  issues.push(...license.issues.map((i) => `license: ${i}`));
  const embed = embedStatus();
  if (embed.requested === "ngram" && !embed.licensed) {
    issues.push("embed_backend ngram requested but license is not Pro/IT — using hash");
  }
  try {
    issues.push(...embedIndexIssues(openDb()));
  } catch {
    // Locked vault: the vault section already reports that.
  }

  const skills = skillsAttestSection();
  issues.push(...skillIssues(skills));

  const pkgPath = join(packageRoot(), "package.json");
  const sku = hasFeature(FEATURE_ATTEST_SKU)
    ? {
        tier: license.tier,
        airgap: true as const,
        network_egress: "none" as const,
        vault: vaultStatus(),
        host_health: {
          continue: hostInstallHealth("continue"),
          zed: hostInstallHealth("zed"),
          windsurf: hostInstallHealth("windsurf"),
        },
      }
    : undefined;

  return {
    tool: "amem",
    version: readVersion(),
    package_integrity: {
      package_json_sha256: sha256File(pkgPath),
    },
    attested_at: new Date().toISOString(),
    privacy: {
      telemetry: false,
      network_egress: "none",
      ui_bind: loaded.policy.ui_bind,
      ui_enabled: loaded.policy.ui_enabled,
      memory_home: amemHome(),
      memory_home_mode: homeMode,
      db_path: dbPath(),
      db_exists: existsSync(dbPath()),
    },
    policy: {
      sources: loaded.sources,
      effective: loaded.policy,
      builtin_deny_claim_patterns: [...BUILTIN_DENY_CLAIM_PATTERNS],
      effective_deny_claim_patterns: effectiveDenyPatterns(loaded.policy),
    },
    repo: {
      root_path: identity.rootPath,
      repo_key: identity.repoKey,
      remote_url: identity.remoteUrl,
      bound: Boolean(repo),
      platform: repo?.platform ?? null,
    },
    platforms: {
      cursor_issues: cursorIssues,
      claude_issues: claudeIssues,
    },
    license,
    embed,
    skills,
    sku,
    ok: issues.length === 0,
    issues,
  };
}

/**
 * Inventory of procedural memory. Hashes let an auditor diff what agents are being told to
 * do between two machines, which a bare list of names would not support.
 */
function skillsAttestSection(): AttestReport["skills"] {
  const policy = loadPolicy().policy;
  const base = {
    dir: skillsDir(),
    enabled: policy.skills_enabled,
    write_approval: policy.skill_write_approval,
  };
  try {
    return {
      ...base,
      pending_drafts: listSkillDrafts({ status: "pending", limit: 200 }).length,
      installed: scanSkills().map((s) => ({
        name: s.name,
        description: s.description,
        source: s.source,
        hash: s.hash,
      })),
    };
  } catch {
    return { ...base, pending_drafts: 0, installed: [] };
  }
}

function skillIssues(skills: AttestReport["skills"]): string[] {
  const issues: string[] = [];
  for (const skill of skills.installed) {
    if (!skill.description.trim()) {
      issues.push(`skill ${skill.name} has no description — agents cannot rank it`);
    }
  }
  if (skills.pending_drafts > 0 && skills.write_approval) {
    issues.push(`${skills.pending_drafts} skill write(s) awaiting approval`);
  }
  return issues;
}

export function formatAttestHuman(report: AttestReport): string {
  const lines = [
    `amem attest ${report.ok ? "OK" : "ISSUES"} · v${report.version}`,
    `attested_at: ${report.attested_at}`,
    `memory_home: ${report.privacy.memory_home} (mode ${report.privacy.memory_home_mode ?? "n/a"})`,
    `db: ${report.privacy.db_path} (${report.privacy.db_exists ? "present" : "absent"})`,
    `telemetry: ${report.privacy.telemetry}`,
    `network_egress: ${report.privacy.network_egress}`,
    `ui: enabled=${report.privacy.ui_enabled} bind=${report.privacy.ui_bind}`,
    `allow_export: ${report.policy.effective.allow_export}`,
    `allowed_platforms: ${report.policy.effective.allowed_platforms.join(", ") || "(any)"}`,
    `allowed_remote_hosts: ${report.policy.effective.allowed_remote_hosts.join(", ") || "(any)"}`,
    `deny_patterns: ${report.policy.effective_deny_claim_patterns.length} (builtin + policy)`,
    `repo: ${report.repo.root_path}`,
    `remote: ${report.repo.remote_url ?? "(none)"}`,
    `bound: ${report.repo.bound}`,
    `license: ${report.license.tier} (${report.license.kind}${report.license.valid ? "" : ", invalid"})`,
    `embed: ${report.embed.backend} dim=${report.embed.dim}`,
  ];
  if (report.sku) {
    lines.push(`sku: IT airgap packet · vault locked=${report.sku.vault.encryptedAtRest} · backup=${report.sku.vault.backup.scheduled ? "scheduled" : "off"}`);
  }
  const applied = report.policy.sources.filter((s) => s.applied).map((s) => `${s.role}:${s.path}`);
  lines.push(`policy_sources: ${applied.join(" → ")}`);
  if (report.issues.length) {
    lines.push("issues:");
    for (const issue of report.issues) lines.push(`- ${issue}`);
  }
  return lines.join("\n");
}
