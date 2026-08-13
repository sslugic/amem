import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { logContextUsage } from "./api/routes.js";
import {
  getRepoByCwd,
  insertConversationNote,
  listConversationNotes,
  upsertRepo,
  type RepoRow,
} from "./db.js";
import { applyProposal } from "./proposal.js";
import { detectRepoIdentity } from "./repo-identity.js";

export type HookPayload = {
  hook_event_name?: string;
  prompt?: string;
  text?: string;
  conversation_id?: string;
  session_id?: string;
  workspace_roots?: string[];
  transcript_path?: string | null;
};

export type HookResponse = Record<string, unknown>;

const TRIVIAL = /^(ok|okay|yes|yep|no|nah|thanks|thank you|continue|go ahead|sure|please)\.?$/i;
const SECRET = /password|api[_-]?key|secret|token\s*[:=]|begin (rsa |openssh )?private/i;
const PATH_RE = /\b(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|md|json|yml|yaml|sql)\b/g;

function workspaceRoot(payload: HookPayload): string {
  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) {
    return resolve(roots[0]);
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
  return upsertRepo(identity, "cursor");
}

function cap(text: string, max = 2400): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n_[amem truncated]_`;
}

function isUsefulPrompt(prompt: string): boolean {
  const t = prompt.trim();
  if (t.length < 16) return false;
  if (TRIVIAL.test(t)) return false;
  if (SECRET.test(t)) return false;
  return true;
}

function extractAnchors(text: string, repoRoot: string): string[] {
  const found = [...text.matchAll(PATH_RE)].map((m) => m[0]);
  const unique = [...new Set(found)].slice(0, 6);
  const existing = unique.filter((p) => existsSync(resolve(repoRoot, p)));
  return existing.length > 0 ? existing : ["README.md"];
}

function hookPlatform(): "cursor" | "claude" {
  if (process.env.CLAUDE_PROJECT_DIR && !process.env.CURSOR_PROJECT_DIR) return "claude";
  return "cursor";
}

function injectPacket(repo: RepoRow, query: string, session: string, platform: string): string | null {
  const { markdown, packet } = logContextUsage({
    repoId: repo.id,
    platform,
    sessionId: session,
    query: query || "(session start)",
  });
  if (packet.claims.length === 0 && packet.notes.length === 0) return null;
  return cap(markdown);
}

function saveSessionClaim(repo: RepoRow, prompt: string, answer?: string): void {
  if (!isUsefulPrompt(prompt)) return;
  const id = `claim.session_${createHash("sha256").update(prompt).digest("hex").slice(0, 12)}`;
  const takeaway = answer?.replace(/\s+/g, " ").trim().slice(0, 240) ?? "";
  const text = takeaway
    ? `${prompt.trim().slice(0, 280)}\n\nPrior outcome: ${takeaway}`
    : prompt.trim().slice(0, 400);
  applyProposal(repo.id, {
    claims: [
      {
        id,
        kind: "session",
        text,
        code_anchors: extractAnchors(`${prompt}\n${answer ?? ""}`, repo.root_path),
        source_ref: "cursor-hook",
      },
    ],
  });
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

  const event = payload.hook_event_name || "";
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
    if (isUsefulPrompt(prompt)) {
      insertConversationNote({
        repoId: repo.id,
        platform,
        sessionId: sid,
        role: "user",
        text: prompt,
      });
    }
    const context = isUsefulPrompt(prompt) ? injectPacket(repo, prompt, sid, platform) : null;
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
    }
    return {};
  }

  if (event === "stop" || event === "sessionEnd") {
    const recent = listConversationNotes(repo.id, 12);
    const lastUser = recent.find((n) => n.role === "user");
    const lastAssistant = recent.find((n) => n.role === "assistant");
    if (lastUser) saveSessionClaim(repo, lastUser.text, lastAssistant?.text);
    return {};
  }

  return { continue: true };
}
