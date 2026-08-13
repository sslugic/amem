import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRepoByCwd, getSetupState } from "./db.js";
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

  const pkgPath = join(packageRoot(), "package.json");

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
    ok: issues.length === 0,
    issues,
  };
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
  ];
  const applied = report.policy.sources.filter((s) => s.applied).map((s) => `${s.role}:${s.path}`);
  lines.push(`policy_sources: ${applied.join(" → ")}`);
  if (report.issues.length) {
    lines.push("issues:");
    for (const issue of report.issues) lines.push(`- ${issue}`);
  }
  return lines.join("\n");
}
