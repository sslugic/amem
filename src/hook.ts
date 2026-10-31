import { wordHit } from "./search.js";
import { seedRepoIfEmpty } from "./repo-seed.js";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { amemHome } from "./paths.js";
import { logContextUsage } from "./api/routes.js";
import {
  captureMissLearnDraft,
  captureSessionDraft,
  findRecentContextMisses,
  isUsefulCaptureText,
} from "./capture.js";
import {
  getRepoByCwd,
  insertConversationNote,
  listConversationNotes,
  upsertRepo,
  type RepoRow,
} from "./db.js";
import { detectRepoIdentity } from "./repo-identity.js";
import { attestSessionFromTranscript } from "./usage-attest.js";
import { stopCheckpoint } from "./checkpoint.js";
import { listWorkPersonalClaims, repoTokens } from "./personal.js";
import { clipText } from "./text-clip.js";
import { captureSkillRevision, captureSkillSuggestion } from "./skill-capture.js";
import { looksLikeSecretValue } from "./secret-detect.js";

export type HookPayload = {
  hook_event_name?: string;
  /** Claude Code uses `hook_event_name` or top-level event aliases */
  event?: string;
  prompt?: string;
  text?: string;
  conversation_id?: string;
  session_id?: string;
  workspace_roots?: string[];
  cwd?: string;
  transcript_path?: string | null;
  /** Claude Code: true while the agent is continuing because a Stop hook blocked */
  stop_hook_active?: boolean;
};

export type HookResponse = Record<string, unknown>;


function workspaceRoot(payload: HookPayload): string {
  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) {
    return resolve(roots[0]);
  }
  if (typeof payload.cwd === "string" && payload.cwd.trim()) {
    return resolve(payload.cwd);
  }
  const envRoot = process.env.CURSOR_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR;
  if (envRoot) return resolve(envRoot);
  return process.cwd();
}

function sessionId(payload: HookPayload): string {
  return payload.conversation_id || payload.session_id || process.env.CURSOR_SESSION_ID || "unknown";
}

function bindRepo(cwd: string): RepoRow | null {
  if (!existsSync(cwd)) return null;
  const existing = getRepoByCwd(cwd);
  if (existing) return existing;
  const identity = detectRepoIdentity(cwd);
  return upsertRepo(identity, hookPlatform());
}

function cap(text: string, max = 2400): string {
  if (text.length <= max) return text;
  return `${clipText(text, max, "")}\n\n_[amem truncated]_`;
}

function hookPlatform(): "cursor" | "claude" {
  if (process.env.CLAUDE_PROJECT_DIR && !process.env.CURSOR_PROJECT_DIR) return "claude";
  return "cursor";
}

/** Normalize Cursor + Claude Code event names into the Cursor-style set. */
export function normalizeHookEvent(raw: string): string {
  const e = (raw || "").trim();
  if (!e) return "";
  const lower = e.toLowerCase();
  if (lower === "userpromptsubmit" || e === "UserPromptSubmit") return "beforeSubmitPrompt";
  if (lower === "stop" || e === "Stop") return "stop";
  if (lower === "sessionstart" || e === "SessionStart") return "sessionStart";
  if (lower === "sessionend" || e === "SessionEnd") return "sessionEnd";
  return e;
}

/** Claude Code event names arrive PascalCase; Cursor uses camelCase. */
function isClaudeEvent(raw: string): boolean {
  return /^(?:SessionStart|UserPromptSubmit|Stop|SessionEnd|PreToolUse|PostToolUse)$/.test(raw.trim());
}

/**
 * Context for the agent in both dialects. Cursor reads `additional_context`; Claude Code
 * only reads `hookSpecificOutput.additionalContext` (anything else is ignored).
 */
function contextResponse(rawEvent: string, text: string): HookResponse {
  const out: HookResponse = { continue: true, additional_context: text };
  if (isClaudeEvent(rawEvent)) {
    out.hookSpecificOutput = { hookEventName: rawEvent.trim(), additionalContext: text };
  }
  return out;
}

/** Personal memories about how the user works: they apply in every repository. */
const STANDING_KINDS = new Set(["preference", "feedback", "constraint", "gotcha", "howto", "procedure", "people", "convention"]);

/**
 * Recent personal memories (cross-repo) for session start. Private ones are left out.
 * Worklogs, findings and other facts come only when they mention this repository:
 * another project's are noise here, and a question about them still finds them.
 */
export function recentPersonalContext(
  repo?: Pick<RepoRow, "repo_name" | "remote_url"> | null,
  days = 7,
  limit = 8,
): string | null {
  const since = Date.now() - days * 86_400_000;
  const tokens = repo ? repoTokens(repo) : [];
  const relevance = (text: string) => {
    const lower = text.toLowerCase();
    return tokens.reduce((n, t) => n + (wordHit(lower, t) ? 1 : 0), 0);
  };
  const recent = listWorkPersonalClaims()
    .filter((c) => Date.parse(c.updated_at) >= since)
    .map((c) => ({ c, score: relevance(c.text) }))
    .filter(({ c, score }) => !repo || score > 0 || STANDING_KINDS.has((c.kind || "").toLowerCase()))
    .sort((a, b) => b.score - a.score || b.c.updated_at.localeCompare(a.c.updated_at))
    .slice(0, limit)
    .map(({ c }) => c);
  if (recent.length === 0) return null;
  const lines = recent.map(
    (c) => `- (${c.kind}, ${c.updated_at.slice(0, 10)}) ${clipText(c.text.replace(/\s+/g, " "), 420)}`,
  );
  return `Recent personal memory (last ${days} days):\n${lines.join("\n")}`;
}

function injectPacket(repo: RepoRow, query: string, session: string, platform: string): string | null {
  const { markdown, packet } = logContextUsage({
    repoId: repo.id,
    platform,
    sessionId: session,
    query: query || "(session start)",
    // A prompt only gets memories that are about it; session start gets the overview.
    strict: query.length > 0,
  });
  if (
    packet.claims.length === 0 &&
    packet.notes.length === 0 &&
    (packet.tasks?.length ?? 0) === 0 &&
    (query.length === 0 || (packet.skills?.length ?? 0) === 0)
  ) {
    return null;
  }
  return cap(markdown);
}

export function handleHookPayload(raw: string): HookResponse {
  try {
    return handleHookPayloadInner(raw);
  } catch (err) {
    logHookError(err);
    return { continue: true };
  }
}

/** A hook must never block the agent, but a failure should leave a trace. Kept under 256 KB. */
export function logHookError(err: unknown): void {
  try {
    mkdirSync(amemHome(), { recursive: true });
    const path = join(amemHome(), "hook.err.log");
    const line = `${new Date().toISOString()} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`;
    if (existsSync(path) && statSync(path).size > 256 * 1024) writeFileSync(path, line);
    else appendFileSync(path, line);
  } catch {
    // Nowhere left to report it.
  }
}

function handleHookPayloadInner(raw: string): HookResponse {
  let payload: HookPayload = {};
  const trimmed = raw.trim();
  if (trimmed) {
    try {
      payload = JSON.parse(trimmed) as HookPayload;
    } catch {
      return { continue: true };
    }
  }

  const rawEvent = payload.hook_event_name || payload.event || "";
  const event = normalizeHookEvent(rawEvent);
  const cwd = workspaceRoot(payload);
  const repo = bindRepo(cwd);
  if (!repo) return { continue: true };

  const sid = sessionId(payload);
  const platform = hookPlatform();

  if (event === "sessionStart") {
    seedRepoIfEmpty(repo);
    const packet = injectPacket(repo, "", sid, platform);
    const personal = recentPersonalContext(repo);
    // Hint and personal memory first: the cap trims from the end, and the repo packet is
    // the part that is cheapest to fetch again with amem_context.
    const hint =
      "Before answering anything that builds on earlier work, check amem (amem_context, amem_skill_list).";
    const parts = [
      hint,
      personal ?? "",
      packet ? `amem local memory for ${repo.repo_name}. Prefer these file anchors over broad exploration.\n\n${packet}` : "",
    ].filter(Boolean);
    return contextResponse(rawEvent, cap(parts.join("\n\n"), 4000));
  }

  if (event === "beforeSubmitPrompt") {
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    // Build the packet before saving the prompt, or the prompt comes back as a "note".
    const context = isUsefulCaptureText(prompt) ? injectPacket(repo, prompt, sid, platform) : null;
    if (isUsefulCaptureText(prompt)) {
      insertConversationNote({
        repoId: repo.id,
        platform,
        sessionId: sid,
        role: "user",
        text: prompt,
      });
    }
    return context
      ? contextResponse(
          rawEvent,
          `amem already knows this about ${repo.repo_name}. Use it before grepping broadly.\n\n${context}`,
        )
      : { continue: true };
  }

  if (event === "afterAgentResponse") {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (text.trim().length > 40 && !looksLikeSecretValue(text)) {
      insertConversationNote({
        repoId: repo.id,
        platform,
        sessionId: sid,
        role: "assistant",
        text,
      });
      // Miss → learn: if a recent context lookup returned nothing, draft from this answer.
      const misses = findRecentContextMisses(repo.id, { sessionId: sid, limit: 3 });
      for (const miss of misses) {
        captureMissLearnDraft({
          repo,
          platform,
          sessionId: sid,
          miss,
          answer: text,
        });
      }
    }
    return {};
  }

  if (event === "stop" || event === "sessionEnd") {
    const recent = listConversationNotes(repo.id, 12);
    const lastUser = recent.find((n) => n.role === "user");
    const lastAssistant = recent.find((n) => n.role === "assistant");
    if (lastAssistant?.text) {
      const misses = findRecentContextMisses(repo.id, { sessionId: sid, limit: 3 });
      for (const miss of misses) {
        captureMissLearnDraft({
          repo,
          platform,
          sessionId: sid,
          miss,
          answer: lastAssistant.text,
        });
      }
    }
    if (lastUser) {
      captureSessionDraft({
        repo,
        platform,
        sessionId: sid,
        prompt: lastUser.text,
        answer: lastAssistant?.text,
        notes: recent.slice(0, 8).map((n) => ({ role: n.role, text: n.text })),
      });
    }
    // Procedural memory: was this session a workflow worth writing up, or evidence that a
    // skill we already followed is wrong? Chronological order matters to the heuristics.
    const ordered = [...recent].reverse().map((n) => ({ role: n.role, text: n.text }));
    captureSkillRevision({ repo, sessionId: sid, notes: ordered }) ??
      captureSkillSuggestion({ repo, sessionId: sid, notes: ordered });
    // Close the savings loop from the transcript rather than hoping the agent
    // remembered to self-report. Skips itself when the transcript is unreadable.
    try {
      attestSessionFromTranscript({
        repoId: repo.id,
        sessionId: sid,
        transcriptPath: payload.transcript_path ?? null,
      });
    } catch {
      // attestation is bookkeeping; never fail a session stop over it
    }
    if (event === "stop") {
      try {
        const checkpoint = stopCheckpoint({
          sessionId: sid,
          transcriptPath: payload.transcript_path ?? null,
          stopHookActive: payload.stop_hook_active === true,
        });
        if (checkpoint) return checkpoint;
      } catch {
        // a checkpoint is a nudge; never fail a session stop over it
      }
    }
    return {};
  }

  return { continue: true };
}
