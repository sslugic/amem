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

function continueMcpYamlPath(): string {
  return join(homedir(), ".continue", "mcpServers", "amem.yaml");
}

/** Continue.dev: ~/.continue/config.json plus mcpServers/amem.yaml (1.x HTTP). */
export function installContinue(workspace = "personal"): HostInstallResult {
  const dir = join(homedir(), ".continue");
  ensureDir(dir);
  ensureDir(join(dir, "mcpServers"));
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
  const yaml = continueMcpYamlPath();
  writeFileSync(
    yaml,
    `name: amem
type: sse
url: ${cfg.http.url}
`,
    "utf8",
  );
  return {
    host: "continue",
    paths: [path, yaml],
    notes: [
      `Continue MCP amem → ${cfg.http.url}. Keep amem ui running.`,
      `Drop-in: ${yaml}`,
    ],
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
  const cfg = mcpClientConfig(workspace);
  servers.amem = {
    source: "custom",
    command: amem.split(/\s+/)[0],
    args: amem.split(/\s+/).slice(1).concat(["mcp", "--workspace", workspace]),
    env: {},
    url: cfg.http.url,
  };
  writeJson(path, {
    ...existing,
    context_servers: servers,
    amem_http_mcp: cfg.http,
  });
  return {
    host: "zed",
    paths: [path],
    notes: [
      `Zed context_servers.amem → ${cfg.http.url} (HTTP while amem ui runs; command is the fallback).`,
    ],
  };
}

function fileMentionsAmem(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, "utf8").includes("amem");
  } catch {
    return false;
  }
}

export function continueInstallHealth(): string[] {
  const json = join(homedir(), ".continue", "config.json");
  const yaml = continueMcpYamlPath();
  if (!fileMentionsAmem(json) && !fileMentionsAmem(yaml)) {
    return ["Continue has no amem MCP entry — run amem init --platform continue"];
  }
  return [];
}

export function zedInstallHealth(): string[] {
  const dir =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "Zed")
      : join(homedir(), ".config", "zed");
  const path = join(dir, "settings.json");
  if (!fileMentionsAmem(path)) {
    return ["Zed settings have no amem context server — run amem init --platform zed"];
  }
  return [];
}

export function windsurfInstallHealth(): string[] {
  const path = join(homedir(), ".codeium", "windsurf", "mcp_config.json");
  if (!fileMentionsAmem(path)) {
    return ["Windsurf has no amem MCP entry — run amem init --platform windsurf"];
  }
  return [];
}

export function hostInstallHealth(host: string): string[] {
  switch (host) {
    case "continue":
      return continueInstallHealth();
    case "zed":
      return zedInstallHealth();
    case "windsurf":
      return windsurfInstallHealth();
    default:
      return [];
  }
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
