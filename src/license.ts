/**
 * Local license SKU. No license server, no telemetry.
 * Signed files verify against an Ed25519 public key. Dev licenses stay on this machine.
 */
import { createHash, generateKeyPairSync, sign as signBytes, verify as verifyBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { amemHome } from "./paths.js";

export type LicenseTier = "free" | "pro" | "it";
export type LicenseKind = "none" | "signed" | "dev" | "env";

export type LicensePayload = {
  tier: LicenseTier;
  subject?: string;
  issued_at: string;
  expires_at?: string;
  features?: string[];
};

export type LicenseFile = {
  kind: "signed" | "dev";
  payload: LicensePayload;
  signature?: string;
};

export type LicenseStatus = {
  tier: LicenseTier;
  kind: LicenseKind;
  subject?: string;
  expires_at?: string;
  features: string[];
  valid: boolean;
  transferable: boolean;
  path: string;
  issues: string[];
};

export const FEATURE_LOCAL_EMBED = "local_embed_model";
export const FEATURE_ATTEST_SKU = "attest_sku";

/** Vendor verify key (SPKI DER hex). Issue signed files with AMEM_LICENSE_PRIVKEY. */
export const DEFAULT_LICENSE_PUBKEY_HEX =
  "302a300506032b6570032100c88636f267711a6baae44a23f4c0353c0cc0166a534fbfc055a6f6e64d9673a3";

const TIER_FEATURES: Record<LicenseTier, string[]> = {
  free: [],
  pro: [FEATURE_LOCAL_EMBED],
  it: [FEATURE_LOCAL_EMBED, FEATURE_ATTEST_SKU],
};

export function licensePath(): string {
  return join(amemHome(), "license.json");
}

export function featuresForTier(tier: LicenseTier): string[] {
  return [...TIER_FEATURES[tier]];
}

export function generateLicenseKeys(): { publicKeyHex: string; privateKeyHex: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKeyHex: pair.publicKey.export({ type: "spki", format: "der" }).toString("hex"),
    privateKeyHex: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("hex"),
  };
}

function canonical(payload: LicensePayload): Buffer {
  return Buffer.from(
    JSON.stringify({
      expires_at: payload.expires_at ?? "",
      features: [...(payload.features ?? [])].sort(),
      issued_at: payload.issued_at,
      subject: payload.subject ?? "",
      tier: payload.tier,
    }),
  );
}

export function signLicense(privateKeyHex: string, payload: LicensePayload): LicenseFile {
  const key = Buffer.from(privateKeyHex, "hex");
  const signature = signBytes(null, canonical(payload), {
    key,
    format: "der",
    type: "pkcs8",
  }).toString("hex");
  return { kind: "signed", payload, signature };
}

export function verifySignedLicense(
  file: LicenseFile,
  publicKeyHex = process.env.AMEM_LICENSE_PUBKEY || DEFAULT_LICENSE_PUBKEY_HEX,
): string[] {
  const issues: string[] = [];
  if (file.kind !== "signed" || !file.signature) {
    issues.push("not a signed license");
    return issues;
  }
  try {
    const ok = verifyBytes(
      null,
      canonical(file.payload),
      { key: Buffer.from(publicKeyHex, "hex"), format: "der", type: "spki" },
      Buffer.from(file.signature, "hex"),
    );
    if (!ok) issues.push("license signature is invalid");
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  return issues;
}

function machineFingerprint(): string {
  return createHash("sha256")
    .update(`${hostname()}|${amemHome()}`)
    .digest("hex")
    .slice(0, 16);
}

export function parseLicenseFile(raw: unknown): LicenseFile {
  if (!raw || typeof raw !== "object") throw new Error("License must be a JSON object");
  const rec = raw as LicenseFile;
  if (rec.kind !== "signed" && rec.kind !== "dev") throw new Error("License kind must be signed or dev");
  if (!rec.payload || !["free", "pro", "it"].includes(rec.payload.tier)) {
    throw new Error("License payload.tier must be free, pro, or it");
  }
  return rec;
}

function envTier(): LicenseTier | null {
  const raw = (process.env.AMEM_LICENSE_TIER || "").trim().toLowerCase();
  if (raw === "pro" || raw === "it" || raw === "free") return raw;
  return null;
}

function expired(payload: LicensePayload, now = new Date()): boolean {
  if (!payload.expires_at) return false;
  const exp = new Date(payload.expires_at);
  return Number.isFinite(exp.getTime()) && exp.getTime() < now.getTime();
}

export function readLicenseFile(path = licensePath()): LicenseFile | null {
  if (!existsSync(path)) return null;
  return parseLicenseFile(JSON.parse(readFileSync(path, "utf8")));
}

export function licenseStatus(now = new Date()): LicenseStatus {
  const path = licensePath();
  const issues: string[] = [];
  const env = envTier();
  if (env) {
    return {
      tier: env,
      kind: "env",
      features: featuresForTier(env),
      valid: true,
      transferable: false,
      path,
      issues: [],
    };
  }

  try {
    const file = readLicenseFile(path);
    if (!file) {
      return {
        tier: "free",
        kind: "none",
        features: [],
        valid: true,
        transferable: false,
        path,
        issues: [],
      };
    }
    if (expired(file.payload, now)) issues.push("license expired");
    if (file.kind === "signed") issues.push(...verifySignedLicense(file));
    if (file.kind === "dev" && file.payload.subject && file.payload.subject !== machineFingerprint()) {
      issues.push("dev license is bound to another machine");
    }
    const tier = issues.length ? "free" : file.payload.tier;
    const features = [...new Set([...(file.payload.features ?? []), ...featuresForTier(tier)])];
    return {
      tier,
      kind: file.kind,
      subject: file.payload.subject,
      expires_at: file.payload.expires_at,
      features,
      valid: issues.length === 0,
      transferable: file.kind === "signed",
      path,
      issues,
    };
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
    return {
      tier: "free",
      kind: "none",
      features: [],
      valid: false,
      transferable: false,
      path,
      issues,
    };
  }
}

export function hasFeature(feature: string): boolean {
  const status = licenseStatus();
  return status.valid && status.features.includes(feature);
}

export function writeLicense(file: LicenseFile, path = licensePath()): string {
  mkdirSync(amemHome(), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function applyLicenseFile(sourcePath: string): LicenseStatus {
  const file = parseLicenseFile(JSON.parse(readFileSync(sourcePath, "utf8")));
  if (file.kind === "signed") {
    const bad = verifySignedLicense(file);
    if (bad.length) throw new Error(bad.join("; "));
  }
  writeLicense(file);
  return licenseStatus();
}

export function activateDevLicense(tier: "pro" | "it"): LicenseStatus {
  writeLicense({
    kind: "dev",
    payload: {
      tier,
      subject: machineFingerprint(),
      issued_at: new Date().toISOString(),
      features: featuresForTier(tier),
    },
  });
  return licenseStatus();
}

export function clearLicense(): void {
  const path = licensePath();
  if (existsSync(path)) unlinkSync(path);
}

export function requireFeature(feature: string, label = feature): void {
  if (hasFeature(feature)) return;
  throw new Error(
    `${label} needs an amem Pro or IT license. Run: amem license activate --dev --tier pro`,
  );
}
