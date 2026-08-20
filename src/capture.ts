import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  insertProposalDraft,
  listProposalDrafts,
  listUsageEvents,
  setProposalDraftStatus,
  type ProposalDraftRow,
  type RepoRow,
  type UsageEventRow,
} from "./db.js";
import { compactClaimText, compactFromNotes, inferClaimKind, isDurableCapture } from "./kinds.js";
import { loadPolicy } from "./policy.js";
import { applyProposal, type Proposal } from "./proposal.js";

const TRIVIAL = /^(ok|okay|yes|yep|no|nah|thanks|thank you|continue|go ahead|sure|please)\.?$/i;
const SECRET = /password|api[_-]?key|secret|token\s*[:=]|begin (rsa |openssh )?private/i;
const PATH_RE =
  /\b(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|md|json|yml|yaml|sql)\b/g;

export function isUsefulCaptureText(text: string): boolean {
  const t = text.trim();
  if (t.length < 16) return false;
  if (TRIVIAL.test(t)) return false;
  if (SECRET.test(t)) return false;
  return true;
}

export function extractCaptureAnchors(text: string, repoRoot: string): string[] {
  const found = [...text.matchAll(PATH_RE)].map((m) => m[0]);
  const unique = [...new Set(found)].slice(0, 6);
  return unique.filter((p) => existsSync(resolve(repoRoot, p)));
}

function draftExistsWithSource(repoId: string, source: string): boolean {
  return listProposalDrafts(repoId, { limit: 40 }).some((d) => d.source === source);
}

function buildClaimDraft(input: {
  prompt: string;
  answer?: string;
  repoRoot: string;
  idPrefix: string;
  sourceRef: string;
  forceKind?: string;
}): { proposal: Proposal; kind: string; anchors: string[]; id: string } | null {
  if (!isUsefulCaptureText(input.prompt) && !isUsefulCaptureText(input.answer ?? "")) {
    return null;
  }
  const anchors = extractCaptureAnchors(
    `${input.prompt}\n${input.answer ?? ""}`,
    input.repoRoot,
  );
  const kind = input.forceKind ?? inferClaimKind(input.prompt, input.answer ?? "");
  const usableAnchors =
    anchors.length > 0 ? anchors : kind === "constraint" || kind === "gotcha" ? ["README.md"] : [];
  if (!isDurableCapture(input.prompt, input.answer, usableAnchors.length)) {
    if (usableAnchors.length === 0) return null;
  }
  const text = compactClaimText(input.prompt, input.answer);
  const id = `${input.idPrefix}_${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
  return {
    id,
    kind,
    anchors: usableAnchors,
    proposal: {
      claims: [
        {
          id,
          kind,
          text,
          code_anchors: usableAnchors,
          source_ref: input.sourceRef,
        },
      ],
    },
  };
}

function maybeAutoApplyDraft(
  repoId: string,
  draft: ProposalDraftRow,
  proposal: Proposal,
): ProposalDraftRow {
  const kinds = loadPolicy().policy.auto_apply_kinds ?? [];
  if (kinds.length === 0) return draft;
  const claimKind = proposal.claims?.[0]?.kind;
  if (!claimKind || !kinds.map((k) => k.toLowerCase()).includes(claimKind.toLowerCase())) {
    return draft;
  }
  try {
    applyProposal(repoId, proposal, loadPolicy().policy);
    return setProposalDraftStatus(draft.id, "applied") ?? draft;
  } catch {
    return draft;
  }
}

function storeDraft(input: {
  repo: RepoRow;
  platform: string;
  sessionId?: string | null;
  title: string;
  source: string;
  built: { proposal: Proposal; id: string };
}): ProposalDraftRow | null {
  if (draftExistsWithSource(input.repo.id, input.source)) return null;
  const draft = insertProposalDraft({
    repoId: input.repo.id,
    platform: input.platform,
    sessionId: input.sessionId,
    title: input.title || input.built.id,
    proposal: input.built.proposal,
    source: input.source,
  });
  return maybeAutoApplyDraft(input.repo.id, draft, input.built.proposal);
}

export function captureSessionDraft(input: {
  repo: RepoRow;
  platform: string;
  sessionId?: string | null;
  prompt: string;
  answer?: string;
  notes?: Array<{ role: string; text: string }>;
}): ProposalDraftRow | null {
  let prompt = input.prompt;
  let answer = input.answer;
  if (input.notes && input.notes.length >= 2) {
    const compacted = compactFromNotes(input.notes);
    if (compacted) {
      prompt = compacted.prompt;
      answer = compacted.answer || answer;
    }
  }
  const built = buildClaimDraft({
    prompt,
    answer,
    repoRoot: input.repo.root_path,
    idPrefix: "claim.session",
    sourceRef: "session-end-draft",
  });
  if (!built) return null;

  return storeDraft({
    repo: input.repo,
    platform: input.platform,
    sessionId: input.sessionId,
    title: prompt.trim().replace(/\s+/g, " ").slice(0, 96),
    source: `session-end:${built.id}`,
    built,
  });
}

export function findRecentContextMisses(
  repoId: string,
  opts: { sessionId?: string | null; limit?: number } = {},
): UsageEventRow[] {
  const limit = opts.limit ?? 8;
  const events = listUsageEvents({ repoId, days: 2 }).slice(0, 40);
  return events
    .filter((e) => {
      if ((e.claims_count ?? 0) > 0) return false;
      if (e.query === "(session start)") return false;
      if (opts.sessionId && e.session_id && e.session_id !== opts.sessionId) return false;
      return true;
    })
    .slice(0, limit);
}

export function captureMissLearnDraft(input: {
  repo: RepoRow;
  platform: string;
  sessionId?: string | null;
  miss: UsageEventRow;
  answer: string;
}): ProposalDraftRow | null {
  if (!input.answer || input.answer.trim().length < 40) return null;
  if (SECRET.test(input.answer)) return null;

  const source = `miss-learn:${input.miss.id}`;
  if (draftExistsWithSource(input.repo.id, source)) return null;

  const prompt = input.miss.query?.trim() || "Prior unanswered question";
  const built = buildClaimDraft({
    prompt,
    answer: input.answer,
    repoRoot: input.repo.root_path,
    idPrefix: "claim.learned",
    sourceRef: source,
    forceKind: inferClaimKind(prompt, input.answer) === "session" ? "gotcha" : undefined,
  });
  if (!built) return null;
  const realAnchors = built.anchors.filter((a) => a !== "README.md");
  if (realAnchors.length === 0) return null;
  built.proposal.claims![0]!.code_anchors = realAnchors;

  return storeDraft({
    repo: input.repo,
    platform: input.platform,
    sessionId: input.sessionId,
    title: `Learned: ${prompt.replace(/\s+/g, " ").slice(0, 80)}`,
    source,
    built,
  });
}

export function pendingDraftCount(repoId: string): number {
  return listProposalDrafts(repoId, { status: "pending" }).length;
}
