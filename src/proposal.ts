import { readFileSync } from "node:fs";
import {
  listClaims,
  listComponents,
  listEdges,
  listFlows,
  nowIso,
  openDb,
  type ClaimRow,
  type ComponentRow,
  type EdgeRow,
  type FlowRow,
} from "./db.js";
import { newId } from "./repo-identity.js";

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
  proposal: Proposal;
};

const OBJECT_TYPES = new Set(["claim", "flow", "component"]);

export function parseProposalJson(raw: string): Proposal {
  const data = JSON.parse(raw) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Proposal must be a JSON object");
  }
  return data as Proposal;
}

export function validateProposal(proposal: Proposal): ValidationResult {
  const errors: string[] = [];
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

  return { ok: errors.length === 0, errors, proposal };
}

export function loadProposalFile(path: string): Proposal {
  return parseProposalJson(readFileSync(path, "utf8"));
}

export type ApplyResult = {
  components: number;
  flows: number;
  claims: number;
  edges: number;
};

export function applyProposal(repoId: string, proposal: Proposal): ApplyResult {
  const validated = validateProposal(proposal);
  if (!validated.ok) {
    throw new Error(`Invalid proposal:\n- ${validated.errors.join("\n- ")}`);
  }

  const db = openDb();
  const ts = nowIso();
  let components = 0;
  let flows = 0;
  let claims = 0;
  let edges = 0;

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
    `INSERT INTO claims (repo_id, id, kind, text, code_anchors, source_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, id) DO UPDATE SET
       kind = excluded.kind,
       text = excluded.text,
       code_anchors = excluded.code_anchors,
       source_ref = COALESCE(excluded.source_ref, claims.source_ref),
       updated_at = excluded.updated_at`,
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
      const existing = db
        .prepare("SELECT created_at FROM claims WHERE repo_id = ? AND id = ?")
        .get(repoId, claim.id) as { created_at: string } | undefined;
      upsertClaim.run(
        repoId,
        claim.id,
        claim.kind,
        claim.text,
        JSON.stringify(claim.code_anchors ?? []),
        claim.source_ref ?? null,
        existing?.created_at ?? ts,
        ts,
      );
      claims += 1;
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

  return { components, flows, claims, edges };
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
    claims: listClaims(repoId),
    edges: listEdges(repoId),
  };
}
