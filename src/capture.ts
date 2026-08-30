import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PLACEHOLDER_ANCHOR } from "./freshness.js";
import {
  insertProposalDraft,
  listProposalDrafts,
  listProposalDraftsAll,
  listUsageEvents,
  setProposalDraftStatus,
  type ProposalDraftRow,
  type RepoRow,
  type UsageEventRow,
} from "./db.js";
import {
  compactClaimText,
  compactFromNotes,
  inferClaimKind,
  isDurableCapture,
  isFactLike,
} from "./kinds.js";
import { loadPolicy } from "./policy.js";
import { applyProposal, type Proposal } from "./proposal.js";
import { scoreProposal } from "./draft-quality.js";
import { tokenJaccard } from "./search.js";
import { isAutoApplyAll } from "./prefs.js";

const TRIVIAL =
  /^(ok|okay|yes|yep|no|nah|thanks|thank you|continue|go ahead|sure|please|test|testing|hello|hi|hey|ping|asdf|foo|bar)\.?$/i;
const SECRET = /password|api[_-]?key|secret|token\s*[:=]|begin (rsa |openssh )?private/i;
const PATH_RE =
  /\b(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|md|json|yml|yaml|sql)\b/g;

/** Reject empty / chat-noise / secret-like text before it becomes a claim. */
export function isUsefulCaptureText(text: string): boolean {
  const t = text.trim();
  if (t.length < 16) return false;
  if (TRIVIAL.test(t)) return false;
  if (SECRET.test(t)) return false;
  return true;
}

/** Same guard for explicit amem_remember / API writes (including short “test”). */
export function isUsefulRememberText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (TRIVIAL.test(t)) return false;
  if (t.length < 8) return false;
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
    anchors.length > 0
      ? anchors
      : kind === "constraint" || kind === "gotcha"
        ? [PLACEHOLDER_ANCHOR]
        : [];
  if (!isDurableCapture(input.prompt, input.answer, usableAnchors.length)) {
    if (usableAnchors.length === 0) return null;
  }
  const text = compactClaimText(input.prompt, input.answer);
  // Single choke point for every capture path. Conversational residue never
  // becomes a durable claim, however many file paths it happens to mention.
  if (!isFactLike(text)) return null;
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

const AUTO_APPLY_SCORE = 60;
const DURABLE_AUTO_KINDS = new Set(["constraint", "gotcha", "structure", "howto", "owner"]);

/** High-quality durable facts apply without waiting for amem_remember. */
export function shouldAutoApplyProposal(proposal: Proposal): boolean {
  const quality = scoreProposal(proposal);
  if (quality.reject || quality.score < AUTO_APPLY_SCORE) return false;
  const claim = proposal.claims?.[0];
  if (!claim) return false;
  if (!DURABLE_AUTO_KINDS.has((claim.kind || "").toLowerCase())) return false;
  const anchors = (claim.code_anchors ?? []).filter((a) => a && a !== PLACEHOLDER_ANCHOR);
  return anchors.length > 0;
}

function maybeAutoApplyDraft(
  repoId: string,
  draft: ProposalDraftRow,
  proposal: Proposal,
): ProposalDraftRow {
  const kinds = loadPolicy().policy.auto_apply_kinds ?? [];
  const claimKind = proposal.claims?.[0]?.kind;
  const policyHit =
    Boolean(claimKind) &&
    kinds.length > 0 &&
    kinds.map((k) => k.toLowerCase()).includes(claimKind!.toLowerCase());
  if (!isAutoApplyAll() && !policyHit && !shouldAutoApplyProposal(proposal)) return draft;
  try {
    applyProposal(repoId, proposal, loadPolicy().policy);
    return setProposalDraftStatus(draft.id, "applied") ?? draft;
  } catch {
    return draft;
  }
}

/** Apply pending drafts (skips quality.reject). Used when auto-approve is turned on. */
export function applyPendingDrafts(repoId?: string): { applied: string[]; skipped: number } {
  const pending = repoId
    ? listProposalDrafts(repoId, { status: "pending", limit: 200 })
    : listProposalDraftsAll({ status: "pending", limit: 200 });
  const applied: string[] = [];
  let skipped = 0;
  const policy = loadPolicy().policy;
  for (const draft of pending) {
    let proposal: Proposal;
    try {
      proposal = JSON.parse(draft.proposal_json) as Proposal;
    } catch {
      skipped += 1;
      continue;
    }
    if (scoreProposal(proposal).reject) {
      skipped += 1;
      continue;
    }
    try {
      applyProposal(draft.repo_id, proposal, policy);
      setProposalDraftStatus(draft.id, "applied");
      applied.push(draft.id);
    } catch {
      skipped += 1;
    }
  }
  return { applied, skipped };
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
  if (scoreProposal(built.proposal).reject) return null;

  const first = storeDraft({
    repo: input.repo,
    platform: input.platform,
    sessionId: input.sessionId,
    title: prompt.trim().replace(/\s+/g, " ").slice(0, 96),
    source: `session-end:${built.id}`,
    built,
  });
  for (const extra of extraSessionFacts(input, built.id)) {
    storeDraft({
      repo: input.repo,
      platform: input.platform,
      sessionId: input.sessionId,
      title: extra.proposal.claims?.[0]?.text?.slice(0, 96) || extra.id,
      source: `session-end:${extra.id}`,
      built: extra,
    });
  }
  return first;
}

function extraSessionFacts(
  input: {
    repo: RepoRow;
    prompt: string;
    answer?: string;
  },
  skipId: string,
): Array<{ proposal: Proposal; kind: string; anchors: string[]; id: string }> {
  const answer = input.answer ?? "";
  const sentences = answer
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 48 && [...s.matchAll(PATH_RE)].length > 0 && isFactLike(s));
  const out: Array<{ proposal: Proposal; kind: string; anchors: string[]; id: string }> = [];
  for (const sentence of sentences.slice(0, 3)) {
    const built = buildClaimDraft({
      prompt: sentence,
      answer: sentence,
      repoRoot: input.repo.root_path,
      idPrefix: "claim.auto",
      sourceRef: "session-auto-capture",
    });
    if (!built || built.id === skipId) continue;
    if (scoreProposal(built.proposal).reject) continue;
    if (tokenJaccard(sentence, input.answer || input.prompt) > 0.72) continue;
    out.push(built);
    if (out.length >= 2) break;
  }
  return out;
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
  const realAnchors = built.anchors.filter((a) => a !== PLACEHOLDER_ANCHOR);
  if (realAnchors.length === 0) return null;
  built.proposal.claims![0]!.code_anchors = realAnchors;
  if (scoreProposal(built.proposal).reject) return null;

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
