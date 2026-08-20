import { listClaims, type ProposalDraftRow } from "./db.js";
import { kindRankBoost } from "./kinds.js";
import {
  findClaimConflicts,
  parseProposalJson,
  type ClaimConflict,
  type Proposal,
} from "./proposal.js";

export const REJECT_SCORE = 25;

export type QualityLabel = "high" | "medium" | "low" | "reject";

export type DraftQuality = {
  score: number;
  label: QualityLabel;
  reasons: string[];
  reject: boolean;
};

export type DecoratedDraft = ProposalDraftRow & {
  quality: DraftQuality;
  conflicts: ClaimConflict[];
};

function labelFor(score: number): QualityLabel {
  if (score < REJECT_SCORE) return "reject";
  if (score < 45) return "low";
  if (score < 60) return "medium";
  return "high";
}

/** Confidence 0–100 for a session-end / miss→learn proposal. */
export function scoreProposal(proposal: Proposal): DraftQuality {
  const reasons: string[] = [];
  let score = 10;
  const claims = proposal.claims ?? [];
  if (claims.length === 0) {
    return { score: 0, label: "reject", reasons: ["empty proposal"], reject: true };
  }

  for (const claim of claims) {
    const kind = (claim.kind || "session").toLowerCase();
    const kindPts = Math.min(30, kindRankBoost(kind) * 2);
    score += kindPts;
    reasons.push(`${kind} +${kindPts}`);

    const anchors = (claim.code_anchors ?? []).filter((a) => a && a !== "README.md");
    const anchorPts = Math.min(20, anchors.length * 10);
    score += anchorPts;
    if (anchorPts) reasons.push(`${anchors.length} file anchor${anchors.length === 1 ? "" : "s"} +${anchorPts}`);
    else reasons.push("no real file anchors");

    const text = (claim.text || "").trim();
    if (text.length >= 60) {
      score += 15;
      reasons.push("specific takeaway +15");
    } else if (text.length >= 40) {
      score += 8;
      reasons.push("short takeaway +8");
    } else {
      score -= 10;
      reasons.push("thin text −10");
    }

    if (/\b(must|never|always|gotcha|constraint|idempotent|before|entrypoint)\b/i.test(text)) {
      score += 10;
      reasons.push("durable language +10");
    }
    if (/\b(ok|thanks|sure|please)\b/i.test(text) && text.length < 50) {
      score -= 15;
      reasons.push("chat noise −15");
    }
    if (kind === "session" && anchors.length === 0) {
      score -= 20;
      reasons.push("session without anchors −20");
    }
  }

  score = Math.max(0, Math.min(100, score));
  const label = labelFor(score);
  return { score, label, reasons, reject: label === "reject" };
}

export function parseDraftProposal(draft: ProposalDraftRow): Proposal {
  try {
    return parseProposalJson(draft.proposal_json);
  } catch {
    return { claims: [] };
  }
}

export function decorateDraft(
  draft: ProposalDraftRow,
  existingActive = listClaims(draft.repo_id),
): DecoratedDraft {
  const proposal = parseDraftProposal(draft);
  const quality = scoreProposal(proposal);
  const conflicts = findClaimConflicts(
    proposal,
    existingActive.filter((c) => (c.status ?? "active") === "active"),
  );
  return { ...draft, quality, conflicts };
}

export function decorateDrafts(drafts: ProposalDraftRow[]): DecoratedDraft[] {
  const byRepo = new Map<string, ReturnType<typeof listClaims>>();
  return drafts.map((d) => {
    if (!byRepo.has(d.repo_id)) byRepo.set(d.repo_id, listClaims(d.repo_id));
    return decorateDraft(d, byRepo.get(d.repo_id));
  });
}
