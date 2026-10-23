import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { amemHome } from "./paths.js";

/**
 * Stop-hook checkpoint: ask the agent to save durable context to amem, but only when
 * the turns since the last checkpoint actually changed something (edits, commands,
 * writes through MCP tools) and nothing was saved to amem after that work.
 * Opt-in with AMEM_STOP_CHECKPOINT=1 so installs without it keep today's behaviour.
 */

export const CHECKPOINT_REASON =
  "amem checkpoint: this turn changed things since the last save. If it produced durable context not yet in amem " +
  "(decisions, plans, commitments, feedback, people and roles, links to docs/tickets, preferences, reportable work, " +
  "or a repeatable procedure), save it now: facts with amem_remember, procedures with amem_skill_save. Update stale " +
  "entries instead of duplicating. Never save secret values, credentials or compensation figures. If nothing new is " +
  "worth saving, do nothing. Then finish with at most one short line, e.g. 'Saved to amem: …'.";

/** Tools that only read: they never make a checkpoint worthwhile on their own. */
const READ_ONLY_TOOLS = new Set([
  "Read", "Grep", "Glob", "LS", "ToolSearch", "WebFetch", "WebSearch", "TodoWrite", "Skill",
  "AskUserQuestion", "ListAgents", "ReportFindings",
]);
const READ_VERB = /(?:^|[_-])(?:get|list|read|search|query|fetch|describe|view|find|status|whoami|show|stats|context|lookup)(?=[_-]|$)/i;
const WRITE_VERB = /(?:^|[_-])(?:create|update|delete|add|remove|set|send|post|write|save|apply|merge|transition|archive|upload|publish|cancel|run|execute|trigger|reset|clear|link|edit|patch|move|start|stop|approve|deny|ingest|import|reorder|deploy|refresh)(?=[_-]|$)/i;

/** MCP tool name without the mcp__<server>__ prefix, camelCase split into snake_case. */
function mcpToolName(name: string): string {
  const tool = name.split("__").slice(2).join("__") || name;
  return tool.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
const AMEM_SAVE = /amem_(?:remember|supersede|skill_save|task_add|task_update|task_complete|cli_save)$/;
/** The same saves made through the CLI from a shell tool (`amem remember "…"`). */
const AMEM_CLI_SAVE = /(?:^|[\s;&|(/])amem\s+(?:remember|supersede|skills?\s+(?:new|import)|task\s+(?:add|update|complete|delete))\b/;

export function isMutatingTool(name: string): boolean {
  if (!name || READ_ONLY_TOOLS.has(name)) return false;
  if (/amem_/.test(name)) return false;
  if (name.startsWith("mcp__")) {
    const tool = mcpToolName(name);
    return WRITE_VERB.test(tool) || !READ_VERB.test(tool);
  }
  return true; // Edit, Write, Bash, NotebookEdit, Agent, …
}

export function isAmemSave(name: string): boolean {
  return AMEM_SAVE.test(name);
}

/** Tool names called in transcript JSONL text, in order. */
export function toolCallsInTranscript(jsonl: string): string[] {
  const names: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"tool_use"')) continue;
    try {
      const entry = JSON.parse(line) as { message?: { content?: unknown } };
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "tool_use") {
          const { name, input } = block as { name?: string; input?: { command?: unknown } };
          if (typeof name !== "string") continue;
          const command = typeof input?.command === "string" ? input.command : "";
          // A shell call that saves to amem counts as a save, not as an unsaved change.
          names.push(AMEM_CLI_SAVE.test(command) ? "amem_cli_save" : name);
        }
      }
    } catch {
      // partial or non-JSON line
    }
  }
  return names;
}

/** True when some mutating tool ran after the last amem save in this window. */
export function needsCheckpoint(toolNames: string[]): boolean {
  let pending = false;
  for (const name of toolNames) {
    if (isAmemSave(name)) pending = false;
    else if (isMutatingTool(name)) pending = true;
  }
  return pending;
}

function stateFile(sessionId: string): string {
  const dir = join(amemHome(), "checkpoints");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.offset`);
}

/**
 * Decide the Stop hook answer. Reads the transcript from the byte offset of the last
 * checkpoint, so each window is judged once. Never blocks while the agent is already
 * continuing from this hook.
 */
export function stopCheckpoint(input: {
  sessionId: string;
  transcriptPath?: string | null;
  stopHookActive?: boolean;
  enabled?: boolean;
}): { decision: "block"; reason: string } | null {
  const enabled = input.enabled ?? process.env.AMEM_STOP_CHECKPOINT === "1";
  if (!enabled || input.stopHookActive) return null;
  const path = input.transcriptPath;
  if (!path || !existsSync(path)) return null;

  const file = stateFile(input.sessionId || "unknown");
  const size = statSync(path).size;
  let offset = Number(existsSync(file) ? readFileSync(file, "utf8") : 0) || 0;
  if (offset > size) offset = 0; // transcript was rewritten (e.g. compaction)
  const window = readFileSync(path).subarray(offset).toString("utf8");
  writeFileSync(file, String(size));

  return needsCheckpoint(toolCallsInTranscript(window))
    ? { decision: "block", reason: CHECKPOINT_REASON }
    : null;
}
