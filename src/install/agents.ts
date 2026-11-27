import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { replaceFile } from "../fs-replace.js";
import { launch, mergeMcpServer, type McpRegistration } from "./mcp-register.js";

/**
 * Command-line agents that run inside a project folder, like Claude Code.
 *
 * Each one gets a user-scope stdio MCP entry (`amem mcp`), so the server starts in
 * whatever repo the agent was opened in and binds to it. The repo itself is bound
 * by `amem init`, and the agent's instruction file (AGENTS.md, GEMINI.md, QWEN.md)
 * is written there too.
 */
export const AGENT_INSTALL_IDS = new Set(["codex", "gemini", "qwen", "opencode"]);

export type AgentInstallResult = {
  host: string;
  paths: string[];
  notes: string[];
  mcp: McpRegistration;
};

/** Codex keeps its config in $CODEX_HOME (default ~/.codex). */
export function codexConfigPath(): string {
  const dir = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(dir, "config.toml");
}

export function geminiSettingsPath(): string {
  return join(homedir(), ".gemini", "settings.json");
}

export function qwenSettingsPath(): string {
  return join(homedir(), ".qwen", "settings.json");
}

export function opencodeConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "opencode", "opencode.json");
}

/** TOML basic strings share JSON's escapes for quotes, backslashes and control characters. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Replace (or add) the `[mcp_servers.amem]` table in a Codex config.toml, leaving every
 * other table and comment as written. Sub-tables such as `[mcp_servers.amem.env]` belong
 * to the old entry and go with it.
 */
export function upsertCodexToml(source: string, command: string, args: string[]): string {
  const lines = source.split(/\r?\n/);
  const kept: string[] = [];
  let inAmem = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (header) {
      const name = header[1]!.replace(/["']/g, "");
      inAmem = name === "mcp_servers.amem" || name.startsWith("mcp_servers.amem.");
    }
    if (!inAmem) kept.push(line);
  }
  while (kept.length && kept[kept.length - 1]!.trim() === "") kept.pop();
  const block = [
    "[mcp_servers.amem]",
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
  ];
  return `${[...kept, ...(kept.length ? [""] : []), ...block].join("\n")}\n`;
}

export function registerCodexMcp(): McpRegistration {
  const path = codexConfigPath();
  const { command, args } = launch();
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const after = upsertCodexToml(before, command, args);
  if (after === before) return { path, status: "unchanged" };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.amem-tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, after, "utf8");
  replaceFile(tmp, path);
  return { path, status: /^\s*\[mcp_servers\.amem\]/m.test(before) ? "updated" : "added" };
}

export function installAgent(id: string): AgentInstallResult {
  const { command, args } = launch();
  switch (id) {
    case "codex": {
      const mcp = registerCodexMcp();
      return {
        host: "codex",
        paths: [mcp.path],
        notes: ["Codex starts amem over stdio in each project. Open a new Codex session to load it."],
        mcp,
      };
    }
    case "gemini": {
      const mcp = mergeMcpServer(geminiSettingsPath(), { command, args });
      return {
        host: "gemini",
        paths: [mcp.path],
        notes: ["Gemini CLI loads MCP servers at startup; run /mcp in a new session to see amem."],
        mcp,
      };
    }
    case "qwen": {
      const mcp = mergeMcpServer(qwenSettingsPath(), { command, args });
      return {
        host: "qwen",
        paths: [mcp.path],
        notes: ["Qwen Code loads MCP servers at startup; run /mcp in a new session to see amem."],
        mcp,
      };
    }
    case "opencode": {
      const mcp = mergeMcpServer(
        opencodeConfigPath(),
        { type: "local", command: [command, ...args], enabled: true },
        "mcp",
      );
      return {
        host: "opencode",
        paths: [mcp.path],
        notes: ["OpenCode reads opencode.json at startup; restart it to load amem."],
        mcp,
      };
    }
    default:
      throw new Error(`No agent installer for: ${id}`);
  }
}

function agentConfigPath(id: string): string | null {
  switch (id) {
    case "codex":
      return codexConfigPath();
    case "gemini":
      return geminiSettingsPath();
    case "qwen":
      return qwenSettingsPath();
    case "opencode":
      return opencodeConfigPath();
    default:
      return null;
  }
}

export function agentInstallHealth(id: string): string[] {
  const path = agentConfigPath(id);
  if (!path) return [];
  let mentions = false;
  try {
    mentions = existsSync(path) && readFileSync(path, "utf8").includes("amem");
  } catch {
    mentions = false;
  }
  return mentions ? [] : [`${id} has no amem MCP entry — run amem init --platform ${id}`];
}
