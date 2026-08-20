import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ClaimRow } from "./db.js";

export type FreshnessStatus = "fresh" | "stale" | "missing_anchor" | "unanchored" | "unknown";

export type ClaimFreshness = {
  status: FreshnessStatus;
  staleAnchors: string[];
  missingAnchors: string[];
};

export function parseAnchors(codeAnchorsJson: string): string[] {
  try {
    const parsed = JSON.parse(codeAnchorsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((a): a is string => typeof a === "string" && Boolean(a.trim()));
  } catch {
    return [];
  }
}

function resolveAnchorPath(rootPath: string, anchor: string): string {
  if (isAbsolute(anchor)) return anchor;
  return join(rootPath, anchor);
}

/**
 * Compare claim.updated_at to filesystem mtimes of code_anchors.
 * Missing paths → missing_anchor; any newer file → stale.
 */
export function assessClaimFreshness(rootPath: string | undefined, claim: ClaimRow): ClaimFreshness {
  const anchors = parseAnchors(claim.code_anchors);
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

  const staleAnchors: string[] = [];
  const missingAnchors: string[] = [];
  let sawFile = false;

  for (const anchor of anchors) {
    const full = resolveAnchorPath(rootPath, anchor);
    if (!existsSync(full)) {
      // Workspace-style anchors (slug names) are not real paths — ignore those.
      if (!anchor.includes("/") && !anchor.includes("\\") && !anchor.includes(".")) {
        continue;
      }
      missingAnchors.push(anchor);
      continue;
    }
    try {
      const st = statSync(full);
      if (!st.isFile() && !st.isDirectory()) continue;
      sawFile = true;
      // 2s skew: avoid false stale right after apply on slow FS
      if (st.mtimeMs > claimUpdatedMs + 2000) {
        staleAnchors.push(anchor);
      }
    } catch {
      missingAnchors.push(anchor);
    }
  }

  if (staleAnchors.length > 0) {
    return { status: "stale", staleAnchors, missingAnchors };
  }
  if (missingAnchors.length > 0 && !sawFile) {
    return { status: "missing_anchor", staleAnchors, missingAnchors };
  }
  if (missingAnchors.length > 0 && sawFile) {
    // Some anchors ok, some missing — treat as soft missing, still usable
    return { status: "fresh", staleAnchors, missingAnchors };
  }
  if (!sawFile && missingAnchors.length === 0) {
    // Only non-path anchors (workspace labels)
    return { status: "unanchored", staleAnchors: [], missingAnchors: [] };
  }
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
