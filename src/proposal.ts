import { readFileSync } from "node:fs";
import {
  listClaims,
  listComponents,
  listEdges,
  listFlows,
  nowIso,
  openDb,
  reindexClaimsSearch,
  type ClaimRow,
  type ComponentRow,
  type EdgeRow,
  type FlowRow,
} from "./db.js";
import { compiledDenyPatterns, type AmemPolicy } from "./policy.js";
import { newId } from "./repo-identity.js";
import { parseAnchors } from "./freshness.js";
import { tokenJaccard } from "./search.js";

export type ProposalComponent = {
  id: string;
  name: string;
  code_anchor?: string;
};

export type ProposalFlow = {
  id: string;
  name: string;
};

export type ProposalClaim = {
  id: string;
  kind: string;
  text: string;
  code_anchors?: string[];
  source_ref?: string;
  /** Claim ids this claim replaces; those become status=superseded */
  supersedes?: string[];
};

export type ProposalEdge = {
  id?: string;
  from_id: string;
  from_type: "claim" | "flow" | "component";
  to_id: string;
  to_type: "claim" | "flow" | "component";
  kind: string;
};

export type Proposal = {
  components?: ProposalComponent[];
  flows?: ProposalFlow[];
  claims?: ProposalClaim[];
  edges?: ProposalEdge[];
};

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  proposal: Proposal;
};

const OBJECT_TYPES = new Set(["claim", "flow", "component"]);
const CONFLICT_JACCARD = 0.45;

export function parseProposalJson(raw: string): Proposal {
  const data = JSON.parse(raw) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Proposal must be a JSON object");
  }
  return data as Proposal;
}

function normalizeSupersedes(claim: ProposalClaim): string[] {
  if (!claim.supersedes) return [];
  return [...new Set(claim.supersedes.filter((id) => typeof id === "string" && id.trim()))];
}

/** Collect explicit supersede targets from claims + supersedes edges. */
export function collectSupersedeTargets(proposal: Proposal): Map<string, string> {
  // oldId -> newId
  const map = new Map<string, string>();
  for (const claim of proposal.claims ?? []) {
    for (const oldId of normalizeSupersedes(claim)) {
      if (oldId !== claim.id) map.set(oldId, claim.id);
    }
  }
  for (const edge of proposal.edges ?? []) {
    if (edge.kind === "supersedes" && edge.from_type === "claim" && edge.to_type === "claim") {
      if (edge.from_id && edge.to_id && edge.from_id !== edge.to_id) {
        map.set(edge.to_id, edge.from_id);
      }
    }
  }
  return map;
}

function shareAnchor(a: string[], b: string[]): boolean {
  const set = new Set(a);
  return b.some((x) => set.has(x));
}

export type ClaimConflict = {
  claimId: string;
  otherId: string;
  otherText: string;
  similarity: number;
  sharedAnchors: string[];
  withinProposal: boolean;
};

/**
 * Likely conflict: share ≥1 code_anchor and high text overlap, different ids,
 * and the older claim is not explicitly superseded by this proposal.
 */
export function findClaimConflicts(
  proposal: Proposal,
  existingActive: ClaimRow[],
): ClaimConflict[] {
  const conflicts: ClaimConflict[] = [];
  const supersedeTargets = collectSupersedeTargets(proposal);
  const incomingIds = new Set((proposal.claims ?? []).map((c) => c.id));

  for (const claim of proposal.claims ?? []) {
    const anchors = claim.code_anchors ?? [];
    if (anchors.length === 0 || !claim.text) continue;

    for (const other of existingActive) {
      if (other.id === claim.id) continue;
      if (incomingIds.has(other.id) && (proposal.claims ?? []).some((c) => c.id === other.id)) {
        continue;
      }
      if (supersedeTargets.get(other.id) === claim.id) continue;
      if (supersedeTargets.has(other.id)) continue;

      const otherAnchors = parseAnchors(other.code_anchors);
      if (!shareAnchor(anchors, otherAnchors)) continue;
      const sim = tokenJaccard(claim.text, other.text);
      if (sim >= CONFLICT_JACCARD) {
        conflicts.push({
          claimId: claim.id,
          otherId: other.id,
          otherText: other.text,
          similarity: sim,
          sharedAnchors: anchors.filter((a) => otherAnchors.includes(a)),
          withinProposal: false,
        });
      }
    }

    for (const peer of proposal.claims ?? []) {
      if (peer.id <= claim.id) continue;
      const peerAnchors = peer.code_anchors ?? [];
      if (!shareAnchor(anchors, peerAnchors)) continue;
      if (normalizeSupersedes(claim).includes(peer.id) || normalizeSupersedes(peer).includes(claim.id)) {
        continue;
      }
      const sim = tokenJaccard(claim.text, peer.text ?? "");
      if (sim >= CONFLICT_JACCARD) {
        conflicts.push({
          claimId: claim.id,
          otherId: peer.id,
          otherText: peer.text ?? "",
          similarity: sim,
          sharedAnchors: anchors.filter((a) => peerAnchors.includes(a)),
          withinProposal: true,
        });
      }
    }
  }

  return conflicts;
}

export function findConflictWarnings(
  proposal: Proposal,
  existingActive: ClaimRow[],
): string[] {
  return findClaimConflicts(proposal, existingActive).map((c) =>
    c.withinProposal
      ? `claims ${c.claimId} and ${c.otherId} look conflicting in the same proposal — set supersedes on the winner.`
      : `claim ${c.claimId} may conflict with active ${c.otherId} (shared anchors, text similarity ${(c.similarity * 100).toFixed(0)}%). Add "supersedes": ["${c.otherId}"] if this replaces it.`,
  );
}

/** Attach supersede targets to the first claim (Brain “replace older facts”). */
export function applySupersedes(proposal: Proposal, otherIds: string[]): Proposal {
  const extra = [...new Set(otherIds.filter((id) => id.trim()))];
  if (extra.length === 0) return proposal;
  const claims = (proposal.claims ?? []).map((claim, index) => {
    if (index !== 0) return claim;
    return {
      ...claim,
      supersedes: [...new Set([...normalizeSupersedes(claim), ...extra.filter((id) => id !== claim.id)])],
    };
  });
  return { ...proposal, claims };
}

export function validateProposal(
  proposal: Proposal,
  policy?: AmemPolicy,
  opts: { existingClaims?: ClaimRow[] } = {},
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const componentIds = new Set<string>();
  const flowIds = new Set<string>();
  const claimIds = new Set<string>();

  for (const c of proposal.components ?? []) {
    if (!c.id || !c.name) errors.push("component requires id and name");
    else componentIds.add(c.id);
  }
  for (const f of proposal.flows ?? []) {
    if (!f.id || !f.name) errors.push("flow requires id and name");
    else flowIds.add(f.id);
  }
  for (const claim of proposal.claims ?? []) {
    if (!claim.id || !claim.kind || !claim.text) {
      errors.push(`claim ${claim.id ?? "(missing id)"} requires id, kind, and text`);
    } else {
      claimIds.add(claim.id);
      if (!claim.code_anchors || claim.code_anchors.length === 0) {
        errors.push(`claim ${claim.id} should include at least one code_anchor`);
      }
      for (const oldId of normalizeSupersedes(claim)) {
        if (oldId === claim.id) {
          errors.push(`claim ${claim.id} cannot supersede itself`);
        }
      }
    }
  }

  for (const edge of proposal.edges ?? []) {
    if (!OBJECT_TYPES.has(edge.from_type) || !OBJECT_TYPES.has(edge.to_type)) {
      errors.push(`edge has invalid types: ${edge.from_type} -> ${edge.to_type}`);
      continue;
    }
    if (!edge.from_id || !edge.to_id || !edge.kind) {
      errors.push("edge requires from_id, to_id, and kind");
    }
  }

  if (
    (proposal.components?.length ?? 0) === 0 &&
    (proposal.flows?.length ?? 0) === 0 &&
    (proposal.claims?.length ?? 0) === 0 &&
    (proposal.edges?.length ?? 0) === 0
  ) {
    errors.push("proposal is empty");
  }

  errors.push(...checkProposalAgainstPolicy(proposal, policy));

  const existing = opts.existingClaims ?? [];
  const activeExisting = existing.filter((c) => (c.status ?? "active") === "active");
  warnings.push(...findConflictWarnings(proposal, activeExisting));

  // dangling supersedes targets (informational)
  const existingIds = new Set(existing.map((c) => c.id));
  for (const claim of proposal.claims ?? []) {
    for (const oldId of normalizeSupersedes(claim)) {
      if (!existingIds.has(oldId) && !claimIds.has(oldId)) {
        warnings.push(
          `claim ${claim.id} supersedes unknown id ${oldId} (will no-op if missing at apply)`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, proposal };
}

/** Block claims that look like secrets / credentials (builtin + policy patterns). */
export function checkProposalAgainstPolicy(
  proposal: Proposal,
  policy?: AmemPolicy,
): string[] {
  const errors: string[] = [];
  let patterns: RegExp[];
  try {
    patterns = compiledDenyPatterns(policy);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }

  for (const claim of proposal.claims ?? []) {
    const haystacks = [
      claim.id ?? "",
      claim.text ?? "",
      claim.source_ref ?? "",
      ...(claim.code_anchors ?? []),
    ];
    for (const re of patterns) {
      for (const text of haystacks) {
        if (text && re.test(text)) {
          errors.push(
            `claim ${claim.id ?? "(missing id)"} blocked by deny_claim_patterns /${re.source}/i`,
          );
          break;
        }
      }
    }
  }
  return errors;
}

export function loadProposalFile(path: string): Proposal {
  return parseProposalJson(readFileSync(path, "utf8"));
}

export type ProposalDiff = {
  claimsAdded: string[];
  claimsUpdated: string[];
  claimsUnchanged: string[];
  willSupersede: string[];
  componentsAdded: string[];
  flowsAdded: string[];
};

function anchorsEqual(a: string | undefined, b: string[] | undefined): boolean {
  let left: string[] = [];
  try {
    left = a ? (JSON.parse(a) as string[]) : [];
  } catch {
    left = [];
  }
  const right = b ?? [];
  if (left.length !== right.length) return false;
  const s = new Set(left);
  return right.every((x) => s.has(x));
}

/** Preview what apply would change against current active (+ superseded targets). */
export function diffProposal(repoId: string, proposal: Proposal): ProposalDiff {
  const existing = listClaims(repoId, { includeSuperseded: true });
  const byId = new Map(existing.map((c) => [c.id, c]));
  const components = listComponents(repoId);
  const flows = listFlows(repoId);
  const componentIds = new Set(components.map((c) => c.id));
  const flowIds = new Set(flows.map((f) => f.id));

  const claimsAdded: string[] = [];
  const claimsUpdated: string[] = [];
  const claimsUnchanged: string[] = [];
  for (const claim of proposal.claims ?? []) {
    const prior = byId.get(claim.id);
    if (!prior) {
      claimsAdded.push(claim.id);
      continue;
    }
    const same =
      prior.text === claim.text &&
      prior.kind === claim.kind &&
      anchorsEqual(prior.code_anchors, claim.code_anchors) &&
      (prior.status ?? "active") === "active";
    if (same) claimsUnchanged.push(claim.id);
    else claimsUpdated.push(claim.id);
  }

  const willSupersede = [...collectSupersedeTargets(proposal).keys()].filter((id) => {
    const row = byId.get(id);
    return row && (row.status ?? "active") === "active";
  });

  return {
    claimsAdded,
    claimsUpdated,
    claimsUnchanged,
    willSupersede,
    componentsAdded: (proposal.components ?? [])
      .map((c) => c.id)
      .filter((id) => !componentIds.has(id)),
    flowsAdded: (proposal.flows ?? []).map((f) => f.id).filter((id) => !flowIds.has(id)),
  };
}

export function formatProposalDiff(diff: ProposalDiff): string {
  const lines: string[] = ["Diff:"];
  const push = (label: string, ids: string[]) => {
    if (!ids.length) return;
    lines.push(`- ${label}: ${ids.map((id) => `\`${id}\``).join(", ")}`);
  };
  push("add claims", diff.claimsAdded);
  push("update claims", diff.claimsUpdated);
  push("unchanged claims", diff.claimsUnchanged);
  push("supersede", diff.willSupersede);
  push("add components", diff.componentsAdded);
  push("add flows", diff.flowsAdded);
  if (lines.length === 1) lines.push("- (no claim/component/flow changes detected)");
  return lines.join("\n");
}

export type ApplyResult = {
  components: number;
  flows: number;
  claims: number;
  edges: number;
  superseded: number;
};

export function applyProposal(
  repoId: string,
  proposal: Proposal,
  policy?: AmemPolicy,
): ApplyResult {
  const existing = listClaims(repoId, { includeSuperseded: true });
  const validated = validateProposal(proposal, policy, { existingClaims: existing });
  if (!validated.ok) {
    throw new Error(`Invalid proposal:\n- ${validated.errors.join("\n- ")}`);
  }

  const db = openDb();
  const ts = nowIso();
  let components = 0;
  let flows = 0;
  let claims = 0;
  let edges = 0;
  let superseded = 0;

  const upsertComponent = db.prepare(
    `INSERT INTO components (repo_id, id, name, code_anchor)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(repo_id, id) DO UPDATE SET
       name = excluded.name,
       code_anchor = excluded.code_anchor`,
  );
  const upsertFlow = db.prepare(
    `INSERT INTO flows (repo_id, id, name)
     VALUES (?, ?, ?)
     ON CONFLICT(repo_id, id) DO UPDATE SET name = excluded.name`,
  );
  const upsertClaim = db.prepare(
    `INSERT INTO claims (repo_id, id, kind, text, code_anchors, source_ref, created_at, updated_at, status, superseded_by, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, 0)
     ON CONFLICT(repo_id, id) DO UPDATE SET
       kind = excluded.kind,
       text = excluded.text,
       code_anchors = excluded.code_anchors,
       source_ref = COALESCE(excluded.source_ref, claims.source_ref),
       updated_at = excluded.updated_at,
       status = 'active',
       superseded_by = NULL`,
  );
  const markSuperseded = db.prepare(
    `UPDATE claims SET status = 'superseded', superseded_by = ?, updated_at = ?
     WHERE repo_id = ? AND id = ? AND id != ?`,
  );
  const upsertEdge = db.prepare(
    `INSERT INTO edges (repo_id, id, from_id, from_type, to_id, to_type, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, id) DO UPDATE SET
       from_id = excluded.from_id,
       from_type = excluded.from_type,
       to_id = excluded.to_id,
       to_type = excluded.to_type,
       kind = excluded.kind`,
  );

  const supersedeMap = collectSupersedeTargets(proposal);

  db.exec("BEGIN");
  try {
    for (const c of proposal.components ?? []) {
      upsertComponent.run(repoId, c.id, c.name, c.code_anchor ?? null);
      components += 1;
    }
    for (const f of proposal.flows ?? []) {
      upsertFlow.run(repoId, f.id, f.name);
      flows += 1;
    }
    for (const claim of proposal.claims ?? []) {
      const prior = db
        .prepare("SELECT created_at FROM claims WHERE repo_id = ? AND id = ?")
        .get(repoId, claim.id) as { created_at: string } | undefined;
      upsertClaim.run(
        repoId,
        claim.id,
        claim.kind,
        claim.text,
        JSON.stringify(claim.code_anchors ?? []),
        claim.source_ref ?? null,
        prior?.created_at ?? ts,
        ts,
      );
      claims += 1;
    }
    for (const [oldId, newId] of supersedeMap) {
      const result = markSuperseded.run(newId, ts, repoId, oldId, newId);
      superseded += Number(result.changes ?? 0);
    }
    for (const edge of proposal.edges ?? []) {
      const id = edge.id ?? newId("edge");
      upsertEdge.run(
        repoId,
        id,
        edge.from_id,
        edge.from_type,
        edge.to_id,
        edge.to_type,
        edge.kind,
      );
      edges += 1;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  reindexClaimsSearch(repoId);
  return { components, flows, claims, edges, superseded };
}

export function exportRepoMemory(repoId: string): {
  components: ComponentRow[];
  flows: FlowRow[];
  claims: ClaimRow[];
  edges: EdgeRow[];
} {
  return {
    components: listComponents(repoId),
    flows: listFlows(repoId),
    claims: listClaims(repoId, { includeSuperseded: true }),
    edges: listEdges(repoId),
  };
}
