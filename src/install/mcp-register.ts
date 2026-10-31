import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getPackageRoot, resolveAmemProgramArgs } from "./skills.js";

export type McpRegistration = {
  path: string;
  status: "added" | "updated" | "unchanged" | "skipped";
  note?: string;
};

/**
 * Add or refresh `mcpServers.amem` in a host's JSON config. Hooks alone inject context,
 * but the amem_* tools the instructions tell the agent to call only exist once the host
 * knows the server. A file that does not parse is left alone: ~/.claude.json holds the
 * user's whole Claude Code state, and rewriting it from {} would wipe that.
 */
export function mergeMcpServer(path: string, server: Record<string, unknown>): McpRegistration {
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      config = parsed as Record<string, unknown>;
    } catch {
      return { path, status: "skipped", note: `${path} is not valid JSON, so amem left it alone` };
    }
  }
  const servers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
  const before = servers.amem === undefined ? null : JSON.stringify(servers.amem);
  if (before === JSON.stringify(server)) return { path, status: "unchanged" };
  config.mcpServers = { ...servers, amem: server };
  const tmp = `${path}.amem-tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return { path, status: before === null ? "added" : "updated" };
}

function launch(): { command: string; args: string[] } {
  const [command, ...args] = resolveAmemProgramArgs("mcp");
  return { command: command!, args };
}

/** Claude Code keeps user-scope MCP servers in ~/.claude.json (or $CLAUDE_CONFIG_DIR). */
export function claudeUserConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? join(dir, ".claude.json") : join(homedir(), ".claude.json");
}

/** User scope: the server starts in each project's folder and binds to that repo. */
export function registerClaudeMcp(): McpRegistration {
  return mergeMcpServer(claudeUserConfigPath(), { type: "stdio", ...launch(), env: {} });
}

export function registerCursorMcp(cursorHome: string): McpRegistration {
  return mergeMcpServer(join(cursorHome, "mcp.json"), { ...launch(), env: {} });
}

/** npx runs from a cache npm may clear; hooks and MCP must point at something that stays. */
export function runningFromNpxCache(root = getPackageRoot()): boolean {
  return /[\\/]_npx[\\/]/.test(root);
}

/**
 * Under `npx @iamem/amem setup`, install the same version globally so the hooks and MCP
 * entries written next keep working. Returns a note for the user either way.
 */
export function ensureStableCli(version: string): string | null {
  if (!runningFromNpxCache() || process.env.AMEM_SKIP_GLOBAL_INSTALL === "1") return null;
  try {
    execFileSync("npm", ["install", "-g", `@iamem/amem@${version}`], { stdio: "inherit" });
    return `Installed the amem CLI globally (@iamem/amem@${version}).`;
  } catch {
    return (
      "Could not install amem globally, so hooks point into the npx cache and may break when npm clears it. " +
      "Run: npm i -g @iamem/amem && amem setup --platform <host>"
    );
  }
}
