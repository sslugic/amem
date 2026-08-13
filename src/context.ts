import {
  listClaims,
  listComponents,
  listConversationNotes,
  listEdges,
  listFlows,
  type ClaimRow,
  type ComponentRow,
  type ConversationNoteRow,
  type FlowRow,
} from "./db.js";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 1);
}

function scoreNote(note: ConversationNoteRow, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const hay = note.text.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (hay.includes(token)) score += token.length > 4 ? 3 : 2;
  }
  return score;
}

function scoreClaim(claim: ClaimRow, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const hay = `${claim.id} ${claim.kind} ${claim.text} ${claim.code_anchors}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (hay.includes(token)) {
      score += token.length > 4 ? 3 : 2;
      if (claim.text.toLowerCase().includes(token)) score += 1;
      if (claim.id.toLowerCase().includes(token)) score += 2;
    }
  }
  return score;
}

export type ContextPacket = {
  query: string;
  claims: Array<ClaimRow & { score: number }>;
  flows: FlowRow[];
  components: ComponentRow[];
  notes: Array<ConversationNoteRow & { score: number }>;
};

export function buildContext(repoId: string, query: string, limit = 12): ContextPacket {
  const queryTokens = tokenize(query);
  const claims = listClaims(repoId)
    .map((c) => ({ ...c, score: scoreClaim(c, queryTokens) }))
    .filter((c) => (queryTokens.length === 0 ? true : c.score > 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // If no keyword hits, return newest claims as a weak fallback for empty memory probes
  const selected =
    claims.length > 0
      ? claims
      : listClaims(repoId)
          .slice(0, Math.min(5, limit))
          .map((c) => ({ ...c, score: 0 }));

  const edges = listEdges(repoId);
  const flowIds = new Set<string>();
  const componentIds = new Set<string>();

  for (const claim of selected) {
    for (const e of edges) {
      if (e.from_type === "claim" && e.from_id === claim.id && e.to_type === "flow") {
        flowIds.add(e.to_id);
      }
      if (e.to_type === "claim" && e.to_id === claim.id && e.from_type === "flow") {
        flowIds.add(e.from_id);
      }
    }
  }

  for (const flowId of flowIds) {
    for (const e of edges) {
      if (e.from_type === "flow" && e.from_id === flowId && e.to_type === "component") {
        componentIds.add(e.to_id);
      }
      if (e.to_type === "flow" && e.to_id === flowId && e.from_type === "component") {
        componentIds.add(e.from_id);
      }
    }
  }

  const flows = listFlows(repoId).filter((f) => flowIds.has(f.id));
  const components = listComponents(repoId).filter((c) => componentIds.has(c.id));

  const notesRaw = listConversationNotes(repoId, 40)
    .map((n) => ({ ...n, score: scoreNote(n, queryTokens) }))
    .filter((n) => (queryTokens.length === 0 ? true : n.score > 0))
    .sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at))
    .slice(0, 5);
  const notes =
    notesRaw.length > 0
      ? notesRaw
      : listConversationNotes(repoId, 5).map((n) => ({ ...n, score: 0 }));

  return { query, claims: selected, flows, components, notes };
}

export function renderContextMarkdown(packet: ContextPacket): string {
  const lines: string[] = ["# Agent Memory Context", "", `Query: ${packet.query}`, ""];

  if (packet.claims.length === 0 && packet.notes.length === 0) {
    lines.push("No claims stored for this repository yet.", "");
    lines.push("Seed memory with the `amem-bootstrap` skill or `amem propose apply <file>`.");
    return lines.join("\n");
  }

  if (packet.claims.length === 0) {
    lines.push("No durable claims yet — using recent conversation memory.", "");
  }

  if (packet.claims.length > 0) {
    lines.push("## Best Claims", "");
    for (const claim of packet.claims) {
      lines.push(`### ${claim.id}`);
      lines.push(`Kind: \`${claim.kind}\``);
      lines.push("");
      lines.push(claim.text);
      lines.push("");
      let anchors: string[] = [];
      try {
        anchors = JSON.parse(claim.code_anchors) as string[];
      } catch {
        anchors = [];
      }
      if (anchors.length > 0) {
        lines.push(`Anchors: ${anchors.map((a) => `\`${a}\``).join(", ")}`);
        lines.push("");
      }
    }
  }

  if (packet.flows.length > 0) {
    lines.push("## Related Flows", "");
    for (const flow of packet.flows) {
      lines.push(`- \`${flow.id}\`: ${flow.name}`);
    }
    lines.push("");
  }

  if (packet.components.length > 0) {
    lines.push("## Related Components", "");
    for (const component of packet.components) {
      const anchor = component.code_anchor ? ` — \`${component.code_anchor}\`` : "";
      lines.push(`- \`${component.id}\`: ${component.name}${anchor}`);
    }
    lines.push("");
  }

  if (packet.notes.length > 0) {
    lines.push("## Recent conversation memory", "");
    for (const note of packet.notes) {
      const label = note.role === "user" ? "You asked" : note.role === "assistant" ? "Prior answer" : note.role;
      lines.push(`- (${label}) ${note.text.replace(/\s+/g, " ").slice(0, 280)}`);
    }
    lines.push("");
  }

  lines.push(
    "_Memory is personal and local (`~/.amem`). Prefer these anchors over broad exploration. Verify current code before changing anything._",
  );
  return lines.join("\n");
}
