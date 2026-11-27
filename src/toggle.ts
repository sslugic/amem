/**
 * `amem off` / `amem on`: take amem out of a client completely, and put back exactly what
 * was there. Built for measuring what amem saves: with amem off the client must not even
 * load amem's tool schemas or skill index, or the comparison is not fair.
 *
 * Claude Code wiring that `off` removes and backs up:
 *   - hooks in ~/.claude/settings.json whose command runs amem
 *   - mcpServers.amem in ~/.claude.json (user scope)
 *   - the amem-* skill folders in ~/.claude/skills
 *   - the amem@… plugin, if enabled (enabledPlugins → false)
 * Every switch is appended to ~/.amem/toggle/history.jsonl so usage reports can label each
 * response with the state it ran under.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { replaceFile } from "./fs-replace.js";
import { claudeUserConfigPath } from "./install/mcp-register.js";
import { isAmemHookCommand } from "./install/skills.js";
import { amemHome } from "./paths.js";

export type TogglePlatform = "claude";
export const TOGGLE_PLATFORMS: TogglePlatform[] = ["claude"];

type HookEntry = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };

export type ToggleState = { platform: TogglePlatform; state: "on" | "off"; since: string | null };

export type ToggleBackup = {
  platform: TogglePlatform;
  at: string;
  hooks: Record<string, HookEntry[]>;
  mcp: unknown;
  skills: string[];
  plugins: string[];
};

export type ToggleResult = {
  platform: TogglePlatform;
  state: "on" | "off";
  changed: boolean;
  removed?: { hooks: number; mcp: boolean; skills: number; plugins: number };
  restored?: { hooks: number; mcp: boolean; skills: number; plugins: number };
  notes: string[];
};

const claudeHome = () => process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
const toggleDir = () => join(amemHome(), "toggle");
const platformDir = (p: TogglePlatform) => join(toggleDir(), p);
const statePath = (p: TogglePlatform) => join(platformDir(p), "state.json");
const backupPath = (p: TogglePlatform) => join(platformDir(p), "backup.json");
export const toggleHistoryPath = () => join(toggleDir(), "history.jsonl");

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null; // never rewrite a file we could not parse
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.amem-tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  replaceFile(tmp, path);
}

const isAmemCommand = (c: string | undefined) =>
  Boolean(c) && (isAmemHookCommand(c!) || /\bamem\b.*\bsession touch\b/.test(c!));

export function toggleState(platform: TogglePlatform = "claude"): ToggleState {
  const s = readJson(statePath(platform));
  if (s && s.state === "off") return { platform, state: "off", since: typeof s.at === "string" ? s.at : null };
  return { platform, state: "on", since: s && typeof s.at === "string" ? s.at : null };
}

/** True while `amem off` is in effect for the platform; hooks use it to stay silent. */
export function isOff(platform: TogglePlatform): boolean {
  try {
    return toggleState(platform).state === "off";
  } catch {
    return false;
  }
}

function record(platform: TogglePlatform, state: "on" | "off", at: string): void {
  mkdirSync(platformDir(platform), { recursive: true });
  writeJsonAtomic(statePath(platform), { platform, state, at });
  appendFileSync(toggleHistoryPath(), `${JSON.stringify({ platform, state, at })}\n`);
}

export function amemOff(platform: TogglePlatform = "claude"): ToggleResult {
  const notes: string[] = [];
  if (toggleState(platform).state === "off") {
    return { platform, state: "off", changed: false, notes: ["amem is already off for Claude Code."] };
  }
  const at = new Date().toISOString();
  const backup: ToggleBackup = { platform, at, hooks: {}, mcp: null, skills: [], plugins: [] };
  mkdirSync(platformDir(platform), { recursive: true });

  // 1. Hooks + plugin, in ~/.claude/settings.json
  const settingsPath = join(claudeHome(), "settings.json");
  const settings = readJson(settingsPath);
  if (settings === null) {
    notes.push(`${settingsPath} is not valid JSON; left it alone.`);
  } else {
    const hooks = (settings.hooks as Record<string, HookEntry[]> | undefined) ?? {};
    let changed = false;
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;
      const keep: HookEntry[] = [];
      for (const entry of entries) {
        const cmds = entry?.hooks ?? [];
        const amemCmds = cmds.filter((h) => isAmemCommand(h?.command));
        if (amemCmds.length === 0) {
          keep.push(entry);
          continue;
        }
        (backup.hooks[event] ??= []).push({ ...entry, hooks: amemCmds });
        const rest = cmds.filter((h) => !isAmemCommand(h?.command));
        if (rest.length) keep.push({ ...entry, hooks: rest });
        changed = true;
      }
      if (keep.length) hooks[event] = keep;
      else delete hooks[event];
    }
    const enabled = (settings.enabledPlugins as Record<string, boolean> | undefined) ?? {};
    for (const [id, on] of Object.entries(enabled)) {
      if (on && /^amem@/.test(id)) {
        enabled[id] = false;
        backup.plugins.push(id);
        changed = true;
      }
    }
    if (changed) {
      settings.hooks = hooks;
      if (Object.keys(enabled).length) settings.enabledPlugins = enabled;
      writeJsonAtomic(settingsPath, settings);
    }
  }

  // 2. MCP server, in ~/.claude.json
  const userCfgPath = claudeUserConfigPath();
  const userCfg = readJson(userCfgPath);
  if (userCfg === null) {
    notes.push(`${userCfgPath} is not valid JSON; the amem MCP server was left registered.`);
  } else {
    const servers = userCfg.mcpServers as Record<string, unknown> | undefined;
    if (servers && servers.amem !== undefined) {
      backup.mcp = servers.amem;
      delete servers.amem;
      writeJsonAtomic(userCfgPath, userCfg);
    }
  }

  // 3. Skills: move the folders aside so Claude does not list them.
  const skillsDir = join(claudeHome(), "skills");
  const parked = join(platformDir(platform), "skills");
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir)) {
      if (!name.startsWith("amem-")) continue;
      mkdirSync(parked, { recursive: true });
      const to = join(parked, name);
      rmSync(to, { recursive: true, force: true });
      moveDir(join(skillsDir, name), to);
      backup.skills.push(name);
    }
  }

  writeJsonAtomic(backupPath(platform), backup);
  record(platform, "off", at);
  const hookCount = Object.values(backup.hooks).reduce((n, e) => n + e.reduce((m, x) => m + (x.hooks?.length ?? 0), 0), 0);
  notes.push("Start a new Claude Code session (or restart the app): running sessions keep what they loaded.");
  return {
    platform,
    state: "off",
    changed: true,
    removed: { hooks: hookCount, mcp: backup.mcp !== null, skills: backup.skills.length, plugins: backup.plugins.length },
    notes,
  };
}

export function amemOn(platform: TogglePlatform = "claude"): ToggleResult {
  const notes: string[] = [];
  if (toggleState(platform).state === "on") {
    return { platform, state: "on", changed: false, notes: ["amem is already on for Claude Code."] };
  }
  const raw = readJson(backupPath(platform));
  const backup = (raw ?? {}) as Partial<ToggleBackup>;
  let hooksRestored = 0;

  const settingsPath = join(claudeHome(), "settings.json");
  const settings = readJson(settingsPath);
  if (settings === null) {
    notes.push(`${settingsPath} is not valid JSON; run \`amem setup --platform claude\` after fixing it.`);
  } else {
    const hooks = (settings.hooks as Record<string, HookEntry[]> | undefined) ?? {};
    for (const [event, entries] of Object.entries(backup.hooks ?? {})) {
      const current = Array.isArray(hooks[event]) ? hooks[event] : [];
      // Skip anything already present (setup may have run while amem was off).
      const present = new Set(current.flatMap((e) => (e.hooks ?? []).map((h) => h.command)));
      for (const entry of entries) {
        const fresh = (entry.hooks ?? []).filter((h) => !present.has(h.command));
        if (fresh.length) {
          current.push({ ...entry, hooks: fresh });
          hooksRestored += fresh.length;
        }
      }
      hooks[event] = current;
    }
    const enabled = (settings.enabledPlugins as Record<string, boolean> | undefined) ?? {};
    for (const id of backup.plugins ?? []) enabled[id] = true;
    settings.hooks = hooks;
    if (Object.keys(enabled).length) settings.enabledPlugins = enabled;
    writeJsonAtomic(settingsPath, settings);
  }

  let mcpRestored = false;
  if (backup.mcp) {
    const userCfgPath = claudeUserConfigPath();
    const userCfg = readJson(userCfgPath);
    if (userCfg === null) {
      notes.push(`${userCfgPath} is not valid JSON; re-register with \`amem setup --platform claude\`.`);
    } else {
      const servers = (userCfg.mcpServers as Record<string, unknown> | undefined) ?? {};
      if (servers.amem === undefined) {
        servers.amem = backup.mcp;
        userCfg.mcpServers = servers;
        writeJsonAtomic(userCfgPath, userCfg);
      }
      mcpRestored = true;
    }
  }

  const skillsDir = join(claudeHome(), "skills");
  const parked = join(platformDir(platform), "skills");
  let skillsRestored = 0;
  for (const name of backup.skills ?? []) {
    const from = join(parked, name);
    const to = join(skillsDir, name);
    if (!existsSync(from)) continue;
    if (existsSync(to)) {
      rmSync(from, { recursive: true, force: true }); // setup reinstalled it meanwhile; keep the newer one
    } else {
      mkdirSync(skillsDir, { recursive: true });
      moveDir(from, to);
    }
    skillsRestored += 1;
  }

  record(platform, "on", new Date().toISOString());
  notes.push("Start a new Claude Code session (or restart the app) to load amem again.");
  return {
    platform,
    state: "on",
    changed: true,
    restored: { hooks: hooksRestored, mcp: mcpRestored, skills: skillsRestored, plugins: backup.plugins?.length ?? 0 },
    notes,
  };
}

/** Every recorded switch, oldest first. */
export function toggleHistory(): Array<{ platform: string; state: "on" | "off"; at: string }> {
  const path = toggleHistoryPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as { platform: string; state: "on" | "off"; at: string };
      } catch {
        return null;
      }
    })
    .filter((x): x is { platform: string; state: "on" | "off"; at: string } => Boolean(x));
}

function moveDir(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    // Across devices: copy, then remove.
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}
