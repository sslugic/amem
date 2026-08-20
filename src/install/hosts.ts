import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mcpClientConfig } from "../mcp.js";
import { resolveAmemBin, writeJson, readJsonObject } from "./skills.js";

export type HostInstallResult = {
  host: string;
  paths: string[];
  notes: string[];
};

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Windsurf: MCP in ~/.codeium/windsurf/mcp_config.json (common layout). */
export function installWindsurf(workspace = "personal"): HostInstallResult {
  const dir = join(homedir(), ".codeium", "windsurf");
  ensureDir(dir);
  const path = join(dir, "mcp_config.json");
  const existing = readJsonObject(path);
  const servers = (existing.mcpServers as Record<string, unknown>) ?? {};
  const cfg = mcpClientConfig(workspace);
  servers.amem = {
    url: cfg.http.url,
  };
  writeJson(path, { ...existing, mcpServers: servers });
  return {
    host: "windsurf",
    paths: [path],
    notes: [`MCP server amem → ${cfg.http.url}. Keep amem ui running. Restart Windsurf if needed.`],
  };
}

/** Continue.dev: ~/.continue/config.json mcpServers (Continue 1.x). */
export function installContinue(workspace = "personal"): HostInstallResult {
  const dir = join(homedir(), ".continue");
  ensureDir(dir);
  const path = join(dir, "config.json");
  const existing = existsSync(path) ? readJsonObject(path) : { models: [] };
  const experimental = (existing.experimental as Record<string, unknown>) ?? {};
  const modelContext = (experimental.modelContextProtocolServers as unknown[]) ?? [];
  const filtered = modelContext.filter((e) => {
    if (!e || typeof e !== "object") return true;
    const name = (e as { name?: string }).name;
    return name !== "amem";
  });
  const cfg = mcpClientConfig(workspace);
  filtered.push({
    name: "amem",
    url: cfg.http.url,
  });
  experimental.modelContextProtocolServers = filtered;
  writeJson(path, { ...existing, experimental });
  return {
    host: "continue",
    paths: [path],
    notes: [`Continue MCP amem → ${cfg.http.url}. Keep amem ui running.`],
  };
}

/** Aider: drop a small CONVENTIONS hint + shell helper (Aider has no MCP). */
export function installAider(repoRoot: string): HostInstallResult {
  const path = join(repoRoot, ".aider.amem.md");
  const body = `# amem + Aider

Before large exploration, run:

\`\`\`bash
amem context "\${user question}" 
\`\`\`

After durable discoveries:

\`\`\`bash
amem remember "…" --anchor path/to/file
\`\`\`

Memory stays in ~/.amem (personal, local).
`;
  writeFileSync(path, body, "utf8");
  return {
    host: "aider",
    paths: [path],
    notes: [
      "Aider has no MCP — added .aider.amem.md with CLI hints. Consider: aider --read .aider.amem.md",
    ],
  };
}

/** Zed: settings.json context_servers / mcp style. */
export function installZed(workspace = "personal"): HostInstallResult {
  const dir = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Zed")
    : join(homedir(), ".config", "zed");
  ensureDir(dir);
  const path = join(dir, "settings.json");
  const existing = existsSync(path) ? readJsonObject(path) : {};
  const servers = (existing.context_servers as Record<string, unknown>) ?? {};
  const amem = resolveAmemBin();
  servers.amem = {
    command: amem.split(/\s+/)[0],
    args: amem.split(/\s+/).slice(1).concat(["mcp", "--workspace", workspace]),
    env: {},
  };
  // Also store HTTP hint
  const cfg = mcpClientConfig(workspace);
  writeJson(path, {
    ...existing,
    context_servers: servers,
    amem_http_mcp: cfg.http,
  });
  return {
    host: "zed",
    paths: [path],
    notes: [
      `Zed context_servers.amem configured. Prefer HTTP ${cfg.http.url} while amem ui is running.`,
    ],
  };
}

export function installHost(
  host: string,
  opts: { repoRoot?: string; workspace?: string } = {},
): HostInstallResult {
  const ws = opts.workspace || "personal";
  switch (host) {
    case "windsurf":
      return installWindsurf(ws);
    case "continue":
      return installContinue(ws);
    case "aider":
      return installAider(opts.repoRoot || process.cwd());
    case "zed":
      return installZed(ws);
    default:
      throw new Error(`No thin installer for host: ${host}`);
  }
}
