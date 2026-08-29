import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
import { captureSkillRevision, captureSkillSuggestion } from "./skill-capture.js";

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
};

export type HookResponse = Record<string, unknown>;

const SECRET = /password|api[_-]?key|secret|token\s*[:=]|begin (rsa |openssh )?private/i;

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
  return `${text.slice(0, max)}\n\n_[amem truncated]_`;
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

function injectPacket(repo: RepoRow, query: string, session: string, platform: string): string | null {
  const { markdown, packet } = logContextUsage({
    repoId: repo.id,
    platform,
    sessionId: session,
    query: query || "(session start)",
  });
  if (packet.claims.length === 0 && packet.notes.length === 0 && (packet.tasks?.length ?? 0) === 0) {
    return null;
  }
  return cap(markdown);
}

export function handleHookPayload(raw: string): HookResponse {
  try {
    return handleHookPayloadInner(raw);
  } catch {
    return { continue: true };
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

  const event = normalizeHookEvent(payload.hook_event_name || payload.event || "");
  const cwd = workspaceRoot(payload);
  const repo = bindRepo(cwd);
  if (!repo) return { continue: true };

  const sid = sessionId(payload);
  const platform = hookPlatform();

  if (event === "sessionStart") {
    const context = injectPacket(repo, "", sid, platform);
    return context
      ? {
          continue: true,
          additional_context: `amem local memory for ${repo.repo_name}. Prefer these file anchors over broad exploration.\n\n${context}`,
        }
      : { continue: true };
  }

  if (event === "beforeSubmitPrompt") {
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    if (isUsefulCaptureText(prompt)) {
      insertConversationNote({
        repoId: repo.id,
        platform,
        sessionId: sid,
        role: "user",
        text: prompt,
      });
    }
    const context = isUsefulCaptureText(prompt) ? injectPacket(repo, prompt, sid, platform) : null;
    return context
      ? {
          continue: true,
          additional_context: `amem already knows this about ${repo.repo_name}. Use it before grepping broadly.\n\n${context}`,
        }
      : { continue: true };
  }

  if (event === "afterAgentResponse") {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (text.trim().length > 40 && !SECRET.test(text)) {
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
    return {};
  }

  return { continue: true };
}
