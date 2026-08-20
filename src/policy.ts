import { existsSync, readFileSync, statSync } from "node:fs";
import { platform as osPlatform } from "node:os";
import { join } from "node:path";
import { amemHome } from "./paths.js";

import { KNOWN_PLATFORMS } from "./platforms.js";

export type AmemPolicy = {
  telemetry: boolean;
  ui_enabled: boolean;
  ui_bind: string;
  allow_export: boolean;
  allowed_platforms: string[];
  allowed_remote_hosts: string[];
  deny_claim_patterns: string[];
  /** Draft kinds that may auto-apply without Brain approve (still local). */
  auto_apply_kinds: string[];
};

export type PolicySource = {
  path: string;
  role: "defaults" | "user" | "system" | "env";
  applied: boolean;
  error?: string;
};

export type LoadedPolicy = {
  policy: AmemPolicy;
  sources: PolicySource[];
};

/** Built-in secret hygiene — always active; policy patterns extend these. */
export const BUILTIN_DENY_CLAIM_PATTERNS: string[] = [
  "api[_-]?key",
  "-----BEGIN",
  "password\\s*=",
  "secret\\s*=",
  "private[_-]?key",
  "aws[_-]?secret",
  "xox[baprs]-",
];

export const DEFAULT_POLICY: AmemPolicy = {
  telemetry: false,
  ui_enabled: true,
  ui_bind: "127.0.0.1",
  allow_export: true,
  allowed_platforms: KNOWN_PLATFORMS.map((p) => p.id),
  allowed_remote_hosts: [],
  deny_claim_patterns: [],
  auto_apply_kinds: [],
};

let cached: LoadedPolicy | null = null;

export function clearPolicyCache(): void {
  cached = null;
}

export function systemPolicyPath(): string {
  if (process.env.AMEM_SYSTEM_POLICY) return process.env.AMEM_SYSTEM_POLICY;
  if (osPlatform() === "win32") {
    const base = process.env.ProgramData ?? "C:\\ProgramData";
    return join(base, "amem", "policy.toml");
  }
  return "/etc/amem/policy.toml";
}

export function userPolicyPath(): string {
  return join(amemHome(), "policy.toml");
}

/**
 * Minimal TOML subset for amem policy files:
 * booleans, quoted strings, and string arrays. Comments (#) and blank lines ok.
 */
export function parsePolicyToml(raw: string): Partial<AmemPolicy> {
  const out: Partial<AmemPolicy> = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/#.*$/, "").trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Invalid policy line ${i + 1}: ${line}`);
    }
    const key = line.slice(0, eq).trim();
    const valueRaw = line.slice(eq + 1).trim();
    switch (key) {
      case "telemetry":
      case "ui_enabled":
      case "allow_export":
        out[key] = parseBool(valueRaw, key, i + 1);
        break;
      case "ui_bind":
        out.ui_bind = parseString(valueRaw, key, i + 1);
        break;
      case "allowed_platforms":
      case "allowed_remote_hosts":
      case "deny_claim_patterns":
      case "auto_apply_kinds":
        out[key] = parseStringArray(valueRaw, key, i + 1);
        break;
      default:
        throw new Error(`Unknown policy key on line ${i + 1}: ${key}`);
    }
  }
  return out;
}

function parseBool(raw: string, key: string, line: number): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Policy ${key} on line ${line} must be true or false`);
}

function parseString(raw: string, key: string, line: number): string {
  const m = /^"(.*)"$/.exec(raw);
  if (!m) throw new Error(`Policy ${key} on line ${line} must be a quoted string`);
  return m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function parseStringArray(raw: string, key: string, line: number): string[] {
  if (raw === "[]") return [];
  const m = /^\[(.*)\]$/.exec(raw);
  if (!m) throw new Error(`Policy ${key} on line ${line} must be a string array`);
  const inner = m[1]!.trim();
  if (!inner) return [];
  const items: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(inner))) {
    items.push(match[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }
  if (items.length === 0) {
    throw new Error(`Policy ${key} on line ${line} must contain quoted strings`);
  }
  return items;
}

function readPartial(path: string): { partial?: Partial<AmemPolicy>; error?: string } {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return {};
    const partial = parsePolicyToml(readFileSync(path, "utf8"));
    return { partial };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function mergePolicy(base: AmemPolicy, overlay: Partial<AmemPolicy>): AmemPolicy {
  return {
    telemetry: overlay.telemetry ?? base.telemetry,
    ui_enabled: overlay.ui_enabled ?? base.ui_enabled,
    ui_bind: overlay.ui_bind ?? base.ui_bind,
    allow_export: overlay.allow_export ?? base.allow_export,
    allowed_platforms: overlay.allowed_platforms ?? base.allowed_platforms,
    allowed_remote_hosts: overlay.allowed_remote_hosts ?? base.allowed_remote_hosts,
    deny_claim_patterns: overlay.deny_claim_patterns ?? base.deny_claim_patterns,
    auto_apply_kinds: overlay.auto_apply_kinds ?? base.auto_apply_kinds,
  };
}

/**
 * Load effective policy.
 * Precedence (later wins): defaults → user (~/.amem) → system (/etc/amem) → AMEM_POLICY_PATH.
 * MDM/system always overrides user for enterprise lock-down.
 */
export function loadPolicy(forceReload = false): LoadedPolicy {
  if (cached && !forceReload) return cached;

  let policy = { ...DEFAULT_POLICY, deny_claim_patterns: [...DEFAULT_POLICY.deny_claim_patterns] };
  const sources: PolicySource[] = [
    { path: "(defaults)", role: "defaults", applied: true },
  ];

  const userPath = userPolicyPath();
  const userRead = readPartial(userPath);
  if (userRead.error) {
    sources.push({ path: userPath, role: "user", applied: false, error: userRead.error });
  } else if (userRead.partial) {
    policy = mergePolicy(policy, userRead.partial);
    sources.push({ path: userPath, role: "user", applied: true });
  } else {
    sources.push({ path: userPath, role: "user", applied: false });
  }

  const systemPath = systemPolicyPath();
  const systemRead = readPartial(systemPath);
  if (systemRead.error) {
    sources.push({ path: systemPath, role: "system", applied: false, error: systemRead.error });
  } else if (systemRead.partial) {
    policy = mergePolicy(policy, systemRead.partial);
    sources.push({ path: systemPath, role: "system", applied: true });
  } else {
    sources.push({ path: systemPath, role: "system", applied: false });
  }

  const envPath = process.env.AMEM_POLICY_PATH;
  if (envPath) {
    const envRead = readPartial(envPath);
    if (envRead.error) {
      sources.push({ path: envPath, role: "env", applied: false, error: envRead.error });
    } else if (envRead.partial) {
      policy = mergePolicy(policy, envRead.partial);
      sources.push({ path: envPath, role: "env", applied: true });
    } else {
      sources.push({
        path: envPath,
        role: "env",
        applied: false,
        error: "AMEM_POLICY_PATH set but file missing",
      });
    }
  }

  // Privacy hard-stops: never allow non-loopback UI or enabling telemetry via policy.
  if (policy.ui_bind !== "127.0.0.1" && policy.ui_bind !== "localhost") {
    policy = { ...policy, ui_bind: "127.0.0.1" };
  }
  policy = { ...policy, telemetry: false };

  cached = { policy, sources };
  return cached;
}

export function effectiveDenyPatterns(policy: AmemPolicy = loadPolicy().policy): string[] {
  return [...BUILTIN_DENY_CLAIM_PATTERNS, ...policy.deny_claim_patterns];
}

export function compiledDenyPatterns(policy?: AmemPolicy): RegExp[] {
  return effectiveDenyPatterns(policy).map((p) => {
    try {
      return new RegExp(p, "i");
    } catch {
      throw new Error(`Invalid deny_claim_patterns regex: ${p}`);
    }
  });
}

export function assertPlatformAllowed(platform: string, policy: AmemPolicy = loadPolicy().policy): void {
  if (policy.allowed_platforms.length === 0) return;
  if (!policy.allowed_platforms.includes(platform)) {
    throw new Error(
      `Platform "${platform}" blocked by policy.allowed_platforms (${policy.allowed_platforms.join(", ")})`,
    );
  }
}

export function assertRemoteAllowed(
  remoteUrl: string | null,
  policy: AmemPolicy = loadPolicy().policy,
): void {
  if (policy.allowed_remote_hosts.length === 0) return;
  if (!remoteUrl) {
    throw new Error(
      "Policy requires a git remote matching allowed_remote_hosts (none detected)",
    );
  }
  const normalized = remoteUrl.toLowerCase().replace(/^https?:\/\//, "");
  const ok = policy.allowed_remote_hosts.some((host) => {
    const h = host.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return normalized === h || normalized.startsWith(`${h}/`) || normalized.startsWith(`${h}`);
  });
  if (!ok) {
    throw new Error(
      `Remote "${remoteUrl}" not in policy.allowed_remote_hosts (${policy.allowed_remote_hosts.join(", ")})`,
    );
  }
}

export function assertExportAllowed(policy: AmemPolicy = loadPolicy().policy): void {
  if (!policy.allow_export) {
    throw new Error("Export blocked by policy (allow_export = false)");
  }
}

export function assertUiAllowed(policy: AmemPolicy = loadPolicy().policy): void {
  if (!policy.ui_enabled) {
    throw new Error("Local UI disabled by policy (ui_enabled = false)");
  }
}

/** Unused today — kept so attest / docs can prove the knob exists and is forced off. */
export function telemetryEnabled(policy: AmemPolicy = loadPolicy().policy): boolean {
  return policy.telemetry === true;
}
