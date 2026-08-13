import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { copyBundledSkills, readJsonObject, resolveAmemBin, writeJson } from "./skills.js";

export type InstallResult = {
  skills: string[];
  settingsPath?: string;
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

  const ensureEvent = (name: string) => {
    const existing = Array.isArray(hooks[name]) ? (hooks[name] as unknown[]) : [];
    const filtered = existing.filter((entry) => {
      if (!entry || typeof entry !== "object") return true;
      const matcher = entry as { hooks?: Array<{ command?: string }> };
      const cmds = matcher.hooks ?? [];
      return !cmds.some((h) => (h.command ?? "").includes("amem session touch"));
    });
    hooks[name] = [
      ...filtered,
      {
        matcher: "",
        hooks: [track],
      },
    ];
  };

  // Claude Code hook schema: events map to matcher groups with command hooks
  ensureEvent("UserPromptSubmit");
  ensureEvent("Stop");
  settings.hooks = hooks;
  writeJson(settingsPath, settings);
  return settingsPath;
}

export function installClaude(_repoRoot: string): InstallResult {
  const skills = copyBundledSkills(join(claudeHome(), "skills"));
  const settingsPath = join(claudeHome(), "settings.json");
  mergeClaudeHooks(settingsPath);
  return { skills, settingsPath };
}

export function claudeInstallHealth(): string[] {
  const issues: string[] = [];
  const skill = join(claudeHome(), "skills", "amem-bootstrap", "SKILL.md");
  if (!existsSync(skill)) issues.push(`Missing Claude skill: ${skill}`);
  return issues;
}
