import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentInstallHealth } from "./install/agents.js";
import { claudeDesktopConfigPath, hostInstallHealth } from "./install/hosts.js";
import { claudeUserConfigPath } from "./install/mcp-register.js";
import { KNOWN_PLATFORMS } from "./platforms.js";

/**
 * Which AI tools are on this machine, for the setup wizard to tick by default.
 *
 * Read-only and quick: it looks for each tool's config folder, app bundle or command,
 * and never starts anything. `configured` says whether amem is already wired into it.
 */
export type DetectedClient = {
  id: string;
  label: string;
  installed: boolean;
  /** What gave it away, shown under the name ("~/.codex", "Cursor.app"). */
  evidence?: string;
  configured: boolean;
  /** amem can write this tool's config itself (otherwise it gets the MCP recipe). */
  autoSetup: boolean;
};

const HOME = () => homedir();

function onPath(command: string): string | null {
  try {
    const win = process.platform === "win32";
    const out = execFileSync(win ? "where" : "which", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    return out.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

function macApp(name: string): string | null {
  if (process.platform !== "darwin") return null;
  for (const dir of ["/Applications", join(HOME(), "Applications")]) {
    const path = join(dir, `${name}.app`);
    if (existsSync(path)) return path;
  }
  return null;
}

function winApp(...relative: string[]): string | null {
  if (process.platform !== "win32") return null;
  const local = process.env.LOCALAPPDATA || join(HOME(), "AppData", "Local");
  const path = join(local, ...relative);
  return existsSync(path) ? path : null;
}

function dir(...parts: string[]): string | null {
  const path = join(HOME(), ...parts);
  return existsSync(path) ? path : null;
}

function short(path: string): string {
  const home = HOME();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

type Probe = () => string | null;

/** Each tool's tell-tale signs, most specific first. */
const PROBES: Record<string, Probe[]> = {
  claude: [() => onPath("claude"), () => dir(".claude")],
  cursor: [() => macApp("Cursor"), () => winApp("Programs", "cursor"), () => dir(".cursor")],
  codex: [() => onPath("codex"), () => (process.env.CODEX_HOME && existsSync(process.env.CODEX_HOME) ? process.env.CODEX_HOME : null), () => dir(".codex")],
  gemini: [() => onPath("gemini"), () => dir(".gemini")],
  qwen: [() => onPath("qwen"), () => dir(".qwen")],
  opencode: [() => onPath("opencode"), () => dir(".config", "opencode")],
  "claude-desktop": [() => macApp("Claude"), () => winApp("AnthropicClaude"), () => (existsSync(claudeDesktopConfigPath()) ? claudeDesktopConfigPath() : null)],
  windsurf: [() => macApp("Windsurf"), () => winApp("Programs", "Windsurf"), () => dir(".codeium", "windsurf")],
  zed: [() => macApp("Zed"), () => onPath("zed"), () => dir(".config", "zed")],
  continue: [() => dir(".continue")],
  aider: [() => onPath("aider")],
  copilot: [() => macApp("Visual Studio Code"), () => winApp("Programs", "Microsoft VS Code"), () => onPath("code")],
};

function configured(id: string): boolean {
  switch (id) {
    case "claude":
      return hasAmemEntry(claudeUserConfigPath());
    case "cursor":
      return hasAmemEntry(join(HOME(), ".cursor", "mcp.json"));
    case "codex":
    case "gemini":
    case "qwen":
    case "opencode":
      return agentInstallHealth(id).length === 0;
    case "claude-desktop":
    case "windsurf":
    case "zed":
    case "continue":
      return hostInstallHealth(id).length === 0;
    default:
      return false;
  }
}

/** Does a JSON config file have an `"amem":` server entry? */
function hasAmemEntry(path: string): boolean {
  try {
    return existsSync(path) && /"amem"\s*:/.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

export function detectClients(): DetectedClient[] {
  const out: DetectedClient[] = [];
  for (const [id, probes] of Object.entries(PROBES)) {
    const platform = KNOWN_PLATFORMS.find((p) => p.id === id);
    if (!platform) continue;
    let evidence: string | null = null;
    for (const probe of probes) {
      try {
        evidence = probe();
      } catch {
        evidence = null;
      }
      if (evidence) break;
    }
    out.push({
      id,
      label: platform.label,
      installed: Boolean(evidence),
      ...(evidence ? { evidence: short(evidence) } : {}),
      configured: evidence ? configured(id) : false,
      autoSetup: Boolean(platform.installs),
    });
  }
  // Installed first, then the order above.
  return out.sort((a, b) => Number(b.installed) - Number(a.installed));
}
