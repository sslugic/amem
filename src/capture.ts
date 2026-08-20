import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  insertProposalDraft,
  listProposalDrafts,
  listUsageEvents,
  type ProposalDraftRow,
  type RepoRow,
  type UsageEventRow,
} from "./db.js";
import { compactClaimText, inferClaimKind, isDurableCapture } from "./kinds.js";
import type { Proposal } from "./proposal.js";

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
  // Prefer real code anchors; allow README only for strongly durable kinds
  const kind = input.forceKind ?? inferClaimKind(input.prompt, input.answer ?? "");
  const usableAnchors =
    anchors.length > 0 ? anchors : kind === "constraint" || kind === "gotcha" ? ["README.md"] : [];
  if (!isDurableCapture(input.prompt, input.answer, usableAnchors.length)) {
    // Still allow weak session drafts when we have some path signal
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

/**
 * Build a pending proposal draft from the latest user/assistant turn.
 * Does not write durable claims until the user applies the draft in the UI/CLI.
 */
export function captureSessionDraft(input: {
  repo: RepoRow;
  platform: string;
  sessionId?: string | null;
  prompt: string;
  answer?: string;
}): ProposalDraftRow | null {
  const built = buildClaimDraft({
    prompt: input.prompt,
    answer: input.answer,
    repoRoot: input.repo.root_path,
    idPrefix: "claim.session",
    sourceRef: "session-end-draft",
  });
  if (!built) return null;

  const source = `session-end:${built.id}`;
  if (draftExistsWithSource(input.repo.id, source)) return null;

  const title = input.prompt.trim().replace(/\s+/g, " ").slice(0, 96);
  return insertProposalDraft({
    repoId: input.repo.id,
    platform: input.platform,
    sessionId: input.sessionId,
    title: title || built.id,
    proposal: built.proposal,
    source,
  });
}

/** Recent context lookups that returned no durable claims (a miss). */
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

/**
 * After a miss, if the agent answer cites real files, queue a durable draft.
 * This is the miss → learn loop.
 */
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
  // Miss-learn requires at least one real code path (not only README)
  const realAnchors = built.anchors.filter((a) => a !== "README.md");
  if (realAnchors.length === 0) return null;
  built.proposal.claims![0]!.code_anchors = realAnchors;

  const title = `Learned: ${prompt.replace(/\s+/g, " ").slice(0, 80)}`;
  return insertProposalDraft({
    repoId: input.repo.id,
    platform: input.platform,
    sessionId: input.sessionId,
    title,
    proposal: built.proposal,
    source,
  });
}

export function pendingDraftCount(repoId: string): number {
  return listProposalDrafts(repoId, { status: "pending" }).length;
}
