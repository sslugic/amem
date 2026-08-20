import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  insertProposalDraft,
  listProposalDrafts,
  type ProposalDraftRow,
  type RepoRow,
} from "./db.js";
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
  const existing = unique.filter((p) => existsSync(resolve(repoRoot, p)));
  return existing.length > 0 ? existing : ["README.md"];
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
  if (!isUsefulCaptureText(input.prompt)) return null;

  const takeaway = input.answer?.replace(/\s+/g, " ").trim().slice(0, 240) ?? "";
  const text = takeaway
    ? `${input.prompt.trim().slice(0, 280)}\n\nPrior outcome: ${takeaway}`
    : input.prompt.trim().slice(0, 400);

  const id = `claim.session_${createHash("sha256").update(input.prompt).digest("hex").slice(0, 12)}`;
  const proposal: Proposal = {
    claims: [
      {
        id,
        kind: "session",
        text,
        code_anchors: extractCaptureAnchors(
          `${input.prompt}\n${input.answer ?? ""}`,
          input.repo.root_path,
        ),
        source_ref: "session-end-draft",
      },
    ],
  };

  const title = input.prompt.trim().replace(/\s+/g, " ").slice(0, 96);
  return insertProposalDraft({
    repoId: input.repo.id,
    platform: input.platform,
    sessionId: input.sessionId,
    title: title || id,
    proposal,
    source: "session-end",
  });
}

export function pendingDraftCount(repoId: string): number {
  return listProposalDrafts(repoId, { status: "pending" }).length;
}
