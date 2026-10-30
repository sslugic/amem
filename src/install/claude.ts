import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { copyBundledSkills, isAmemHookCommand, readJsonObject, resolveAmemBin, writeJson } from "./skills.js";
import { claudeUserConfigPath, registerClaudeMcp, type McpRegistration } from "./mcp-register.js";

export type InstallResult = {
  skills: string[];
  settingsPath?: string;
  mcp?: McpRegistration;
};

function claudeHome(): string {
  return process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
}

function mergeClaudeHooks(settingsPath: string): string {
  const amem = resolveAmemBin();
  const settings = readJsonObject(settingsPath);
  const hooks = (settings.hooks as Record<string, unknown>) ?? {};

  const track = {
    type: "command",
    command: `${amem} session touch --platform claude`,
  };
  const fullHook = {
    type: "command",
    command: `${amem} hook`,
  };

  const ensureEvent = (name: string, entry: { type: string; command: string }) => {
    const existing = Array.isArray(hooks[name]) ? (hooks[name] as unknown[]) : [];
    const filtered = existing.filter((row) => {
      if (!row || typeof row !== "object") return true;
      const matcher = row as { hooks?: Array<{ command?: string }> };
      const cmds = matcher.hooks ?? [];
      return !cmds.some(
        (h) =>
          (h.command ?? "").includes("amem session touch") ||
          isAmemHookCommand(h.command ?? ""),
      );
    });
    hooks[name] = [
      ...filtered,
      {
        matcher: "",
        hooks: [entry],
      },
    ];
  };

  // Full hook pipeline (inject + notes + drafts). Keep Stop on the same path as Cursor.
  ensureEvent("SessionStart", fullHook);
  ensureEvent("UserPromptSubmit", fullHook);
  ensureEvent("Stop", fullHook);
  // Lightweight session touch remains useful if UserPromptSubmit payload is sparse
  ensureEvent("Notification", track);
  settings.hooks = hooks;
  writeJson(settingsPath, settings);
  return settingsPath;
}

export function installClaude(_repoRoot: string): InstallResult {
  const skills = copyBundledSkills(join(claudeHome(), "skills"));
  const settingsPath = join(claudeHome(), "settings.json");
  mergeClaudeHooks(settingsPath);
  const mcp = registerClaudeMcp();
  return { skills, settingsPath, mcp };
}

export function claudeInstallHealth(): string[] {
  const issues: string[] = [];
  const skill = join(claudeHome(), "skills", "amem-bootstrap", "SKILL.md");
  if (!existsSync(skill)) issues.push(`Missing Claude skill: ${skill}`);
  const settingsPath = join(claudeHome(), "settings.json");
  if (!existsSync(settingsPath)) {
    issues.push(`Missing Claude settings: ${settingsPath}`);
  } else {
    const raw = JSON.stringify(readJsonObject(settingsPath));
    if (!isAmemHookCommand(raw.replace(/\\"/g, '"'))) {
      issues.push("Claude settings.json does not call `amem hook` — re-run amem init --platform claude");
    }
  }
  const mcpServers = readJsonObject(claudeUserConfigPath()).mcpServers as Record<string, unknown> | undefined;
  if (!mcpServers?.amem) {
    issues.push("Claude Code has no amem MCP server, so amem_* tools are missing — re-run amem init --platform claude");
  }
  return issues;
}
