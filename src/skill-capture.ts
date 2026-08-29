/**
 * Deciding when a session is worth writing up as a skill.
 *
 * This is tuned for precision, not recall. Memory drafts already taught us that a noisy
 * queue is worse than an empty one — a user facing hundreds of suggestions stops reading
 * all of them. A session must show several independent signals before it earns one
 * suggestion, and a session can never produce more than one.
 */
import {
  insertSkillDraft,
  listRecentSkillUses,
  listSkillsUsedInSession,
  skillDraftExists,
  type RepoRow,
  type SkillDraftRow,
} from "./db.js";
import { loadPolicy } from "./policy.js";

export type SessionNote = { role: string; text: string };

/** Numbered or bulleted command-ish steps — the shape of a procedure. */
const STEP_RE = /^\s*(?:\d+[.)]\s+|[-*]\s+)/gm;
const COMMAND_RE =
  /\b(?:npm|pnpm|yarn|npx|git|docker|kubectl|make|cargo|go|python3?|node|psql|aws|terraform|ssh|curl)\s+[\w-]/g;
const ERROR_RE =
  /\b(?:error|failed|failure|exception|traceback|not found|cannot find|denied|timed? out|broken|does ?n[o']t work)\b/i;
const RESOLUTION_RE =
  /\b(?:fixed|resolved|works now|that did it|success(?:ful)?|passing|green|it works|solved|now working)\b/i;
const CORRECTION_RE =
  /\b(?:no,|nope|actually|that'?s wrong|not quite|instead of|don'?t do that|wrong approach|try again)\b/i;

export type SkillOpportunity = {
  title: string;
  summary: string;
  reasons: string[];
  score: number;
};

function assistantText(notes: SessionNote[]): string {
  return notes
    .filter((n) => n.role === "assistant")
    .map((n) => n.text)
    .join("\n\n");
}

function userText(notes: SessionNote[]): string {
  return notes
    .filter((n) => n.role === "user")
    .map((n) => n.text)
    .join("\n\n");
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/**
 * Score a session against the three triggers Hermes names: a multi-step workflow worth
 * repeating, a dead end the agent found the way past, and a correction from the user.
 * Requires at least two distinct signals plus real procedural content.
 */
export function detectSkillOpportunity(notes: SessionNote[]): SkillOpportunity | null {
  if (!Array.isArray(notes) || notes.length < 4) return null;

  const assistant = assistantText(notes);
  const user = userText(notes);
  if (assistant.trim().length < 400) return null;

  const reasons: string[] = [];
  let score = 0;

  const steps = countMatches(assistant, STEP_RE);
  const commands = countMatches(assistant, COMMAND_RE);
  // A procedure needs enumerated steps or repeated concrete commands, not just prose.
  if (steps >= 3) {
    score += 30;
    reasons.push(`${steps} enumerated steps`);
  }
  if (commands >= 3) {
    score += 20;
    reasons.push(`${commands} shell commands`);
  }
  if (steps < 3 && commands < 3) return null;

  const hitError = ERROR_RE.test(assistant);
  if (hitError && RESOLUTION_RE.test(assistant)) {
    score += 25;
    reasons.push("hit an error and found the working path");
  }
  if (CORRECTION_RE.test(user)) {
    score += 20;
    reasons.push("user corrected the approach");
  }
  const turns = notes.filter((n) => n.role === "user").length;
  if (turns >= 3) {
    score += 10;
    reasons.push(`${turns} back-and-forth turns`);
  }

  // Two independent signals minimum: one lone heuristic is not evidence of a procedure.
  if (reasons.length < 2 || score < 55) return null;

  const firstUser = notes.find((n) => n.role === "user")?.text ?? "";
  const title = firstUser.replace(/\s+/g, " ").trim().slice(0, 96) || "Multi-step workflow";
  return {
    title,
    summary: firstUser.replace(/\s+/g, " ").trim().slice(0, 400),
    reasons,
    score,
  };
}

/**
 * Queue at most one suggestion per session. The agent, not amem, writes the actual
 * SKILL.md — amem has no model, so it only points at the material.
 */
export function captureSkillSuggestion(input: {
  repo: RepoRow;
  sessionId?: string | null;
  notes: SessionNote[];
}): SkillDraftRow | null {
  if (!loadPolicy().policy.skill_capture) return null;
  const sid = input.sessionId || "unknown";
  const source = `skill-suggest:${sid}`;
  if (skillDraftExists(source)) return null;

  const opportunity = detectSkillOpportunity(input.notes);
  if (!opportunity) return null;

  return insertSkillDraft({
    repoId: input.repo.id,
    title: opportunity.title,
    summary: opportunity.summary,
    kind: "suggestion",
    source,
    sessionId: input.sessionId,
    reasons: opportunity.reasons,
  });
}

/**
 * A skill was followed this session and things still went wrong — that is the signal the
 * skill itself needs work. Mirrors the existing miss→learn loop, pointed at procedures.
 */
export function captureSkillRevision(input: {
  repo: RepoRow;
  sessionId?: string | null;
  notes: SessionNote[];
}): SkillDraftRow | null {
  if (!loadPolicy().policy.skill_capture) return null;
  const sid = input.sessionId || "";
  // Prefer the exact session; fall back to recent use in this memory, because MCP
  // clients do not reliably pass a session id through to skill views.
  const used = sid ? listSkillsUsedInSession(sid, 3) : [];
  const candidates = used.length > 0 ? used : listRecentSkillUses(input.repo.id, 120, 3);
  if (candidates.length === 0) return null;

  const assistant = assistantText(input.notes);
  const user = userText(input.notes);
  const struggled =
    (ERROR_RE.test(assistant) && RESOLUTION_RE.test(assistant)) || CORRECTION_RE.test(user);
  if (!struggled) return null;

  const target = candidates[0]!;
  const source = `skill-revise:${sid || input.repo.id}:${target}`;
  if (skillDraftExists(source)) return null;

  const reasons = [
    `followed ${target} but still hit trouble`,
    CORRECTION_RE.test(user) ? "user corrected the approach" : "error then recovery in the session",
  ];
  return insertSkillDraft({
    repoId: input.repo.id,
    title: `Revise ${target}`,
    summary: `The ${target} skill was loaded this session but the work still went sideways. Check whether the procedure is missing a step or a pitfall.`,
    kind: "revision",
    targetSkill: target,
    source,
    sessionId: input.sessionId,
    reasons,
  });
}
