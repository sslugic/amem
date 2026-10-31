import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ClaimRow } from "./db.js";

export type FreshnessStatus = "fresh" | "stale" | "missing_anchor" | "unanchored" | "unknown";

export type ClaimFreshness = {
  status: FreshnessStatus;
  staleAnchors: string[];
  missingAnchors: string[];
};

/**
 * capture.ts falls back to this when it cannot extract a real file anchor.
 * README churns constantly, so honouring it as a real anchor marks those claims
 * stale forever and drowns the genuine staleness signal. Treat it as no anchor.
 * (capture.ts already filters it out of "does this claim have real anchors".)
 */
export const PLACEHOLDER_ANCHOR = "README.md";

export function parseAnchors(codeAnchorsJson: string): string[] {
  try {
    const parsed = JSON.parse(codeAnchorsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((a): a is string => typeof a === "string" && Boolean(a.trim()));
  } catch {
    return [];
  }
}

/** Workspace-style anchors (slugs like "worklog") are labels, not paths. */
export function isPathAnchor(anchor: string): boolean {
  return anchor.includes("/") || anchor.includes("\\") || anchor.includes(".");
}

function isInside(root: string, full: string): boolean {
  const rel = relative(root, full);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The anchor's full path when it stays inside the repo, following symlinks; null when it
 * escapes (`../../etc/hosts`, `/etc/hosts`, a link pointing out). A memory about this repo
 * cannot be kept fresh by files that belong to something else.
 */
export function anchorPathInRoot(rootPath: string, anchor: string): string | null {
  if (!pass) return resolveInRoot(rootPath, anchor);
  const key = `${rootPath}\0${anchor}`;
  if (!pass.paths.has(key)) pass.paths.set(key, resolveInRoot(rootPath, anchor));
  return pass.paths.get(key)!;
}

function resolveInRoot(rootPath: string, anchor: string): string | null {
  const root = realOrSelf(resolve(rootPath));
  const full = resolve(root, anchor);
  if (!isInside(root, full)) return null;
  return isInside(root, realOrSelf(full)) ? full : null;
}

/** Path anchors that point outside the repo root; a write that has any is rejected. */
export function anchorsOutsideRoot(rootPath: string, anchors: string[]): string[] {
  return anchors.filter((a) => isPathAnchor(a) && anchorPathInRoot(rootPath, a) === null);
}

const HASH_MAX_BYTES = 5 * 1024 * 1024;
/** Keyed by (path, mtime, size), so a hit is always the current content. */
const hashCache = new Map<string, string | null>();
/** Stats and resolved paths for one context build: each file is looked at once per query. */
let pass: { stats: Map<string, Stats | null>; paths: Map<string, string | null> } | null = null;

export function freshnessPass<T>(fn: () => T): T {
  if (pass) return fn();
  pass = { stats: new Map(), paths: new Map() };
  try {
    return fn();
  } finally {
    pass = null;
  }
}

function statOnce(full: string): Stats | null {
  try {
    return statSync(full);
  } catch {
    return null;
  }
}

function statCached(full: string): Stats | null {
  if (!pass) return statOnce(full);
  if (!pass.stats.has(full)) pass.stats.set(full, statOnce(full));
  return pass.stats.get(full)!;
}

/** sha256 of a file, cached per (path, mtime, size); null for directories and huge files. */
function fileHash(full: string): string | null {
  const st = statCached(full);
  if (!st || !st.isFile() || st.size > HASH_MAX_BYTES) return null;
  const key = `${full}\0${st.mtimeMs}\0${st.size}`;
  if (hashCache.has(key)) return hashCache.get(key)!;
  let hash: string | null = null;
  try {
    hash = createHash("sha256").update(readFileSync(full)).digest("hex");
  } catch {
    hash = null;
  }
  if (hashCache.size > 5000) hashCache.clear();
  hashCache.set(key, hash);
  return hash;
}

/** Content hashes of a claim's file anchors at write time, as stored in claims.anchor_hashes. */
export function hashAnchors(rootPath: string | null | undefined, anchors: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!rootPath) return out;
  for (const anchor of anchors) {
    if (!isPathAnchor(anchor)) continue;
    const full = anchorPathInRoot(rootPath, anchor);
    const hash = full ? fileHash(full) : null;
    if (hash) out[anchor] = hash;
  }
  return out;
}

function parseHashes(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Is each code anchor still what the claim was written against? When the claim stored a
 * content hash, that decides: a `touch` or branch switch that leaves the bytes alone stays
 * fresh, and a rewrite that kept its old mtime (`cp -p`, `rsync -a`) is stale. Claims from
 * before hashes fall back to "modified after the claim". Any missing anchor makes the
 * claim missing_anchor. Anchors outside the repo are ignored.
 */
export function assessClaimFreshness(rootPath: string | undefined, claim: ClaimRow): ClaimFreshness {
  const anchors = parseAnchors(claim.code_anchors).filter((a) => a !== PLACEHOLDER_ANCHOR);
  if (anchors.length === 0) {
    return { status: "unanchored", staleAnchors: [], missingAnchors: [] };
  }
  if (!rootPath) {
    return { status: "unknown", staleAnchors: [], missingAnchors: [] };
  }

  const claimUpdatedMs = Date.parse(claim.updated_at);
  if (Number.isNaN(claimUpdatedMs)) {
    return { status: "unknown", staleAnchors: [], missingAnchors: [] };
  }

  const hashes = parseHashes(claim.anchor_hashes);
  const staleAnchors: string[] = [];
  const missingAnchors: string[] = [];
  let sawFile = false;

  for (const anchor of anchors) {
    if (!isPathAnchor(anchor)) continue;
    const full = anchorPathInRoot(rootPath, anchor);
    if (!full) continue;
    const st = statCached(full);
    if (!st) {
      missingAnchors.push(anchor);
      continue;
    }
    if (!st.isFile() && !st.isDirectory()) continue;
    sawFile = true;
    const stored = hashes[anchor];
    const current = stored ? fileHash(full) : null;
    if (stored && current) {
      // Content is the truth when we have it. Hashes are cached per (path, mtime, size),
      // so this reads each file once per change, not once per query.
      if (current !== stored) staleAnchors.push(anchor);
      continue;
    }
    // 2s skew: avoid false stale right after apply on slow FS
    if (st.mtimeMs > claimUpdatedMs + 2000) staleAnchors.push(anchor);
  }

  if (staleAnchors.length > 0) return { status: "stale", staleAnchors, missingAnchors };
  if (missingAnchors.length > 0) return { status: "missing_anchor", staleAnchors, missingAnchors };
  if (!sawFile) return { status: "unanchored", staleAnchors: [], missingAnchors: [] };
  return { status: "fresh", staleAnchors: [], missingAnchors: [] };
}

/** Multiplier applied to retrieval score (1 = full trust). */
export function freshnessScoreMultiplier(status: FreshnessStatus): number {
  switch (status) {
    case "stale":
      return 0.35;
    case "missing_anchor":
      return 0.5;
    case "unknown":
      return 0.85;
    case "unanchored":
      return 0.9;
    case "fresh":
    default:
      return 1;
  }
}
