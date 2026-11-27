import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Which AI clients are wired to amem on this machine, and which are installed but not.
 *
 * Used by the Activity page to show clients that are connected but have never called
 * amem (so they do not look missing). Only checks whether an `amem` entry exists in a
 * client's config: no other config values (tokens, env, other servers) are read out
 * or returned.
 */

export type ConnectedClient = {
  /** Activity client id (what normalizeClient() logs for its calls). */
  id: string;
  label: string;
  /** How amem is wired in: an MCP server entry, hooks, or both. */
  via: string[];
};

export type DetectedClient = {
  id: string;
  label: string;
  /** One-line next step to connect it. */
  nextStep: string;
  /** Setup guide for this app (docs/CLIENTS.md section). */
  guide: string;
};

/** Installed apps that cannot talk to a local MCP server, with what to use instead. */
export type UnsupportedClient = { id: string; label: string; instead: string; guide: string };

export type ClientScan = { connected: ConnectedClient[]; detected: DetectedClient[]; unsupported: UnsupportedClient[] };

export const CLIENTS_GUIDE = "https://github.com/sslugic/amem/blob/main/docs/CLIENTS.md";

/** docs/CLIENTS.md section per client id. */
const GUIDE_ANCHORS: Record<string, string> = {
  "claude-code": "one-command-setup",
  cursor: "one-command-setup",
  "claude-desktop": "one-command-setup",
  windsurf: "one-command-setup",
  zed: "one-command-setup",
  continue: "one-command-setup",
  codex: "openai-codex-cli-ide-extension-and-app",
  copilot: "github-copilot-vs-code-agent-mode",
  gemini: "gemini-cli",
  antigravity: "google-antigravity",
  cline: "cline-roo-code-kilo-code",
  roo: "cline-roo-code-kilo-code",
  kilo: "cline-roo-code-kilo-code",
  jetbrains: "jetbrains-ai-assistant--junie",
  "lm-studio": "lm-studio",
  goose: "goose",
  perplexity: "perplexity-mac-app",
  warp: "warp",
  chatgpt: "apps-that-cant-use-amem-yet",
  "gemini-app": "apps-that-cant-use-amem-yet",
};

export function clientGuide(id: string): string {
  return `${CLIENTS_GUIDE}#${GUIDE_ANCHORS[id] ?? "one-command-setup"}`;
}

type ScanOpts = { home?: string; platform?: NodeJS.Platform; appDirs?: string[]; env?: NodeJS.ProcessEnv };

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** True when `cfg[key]` is an object with an `amem` entry. Values are never returned. */
function hasAmemEntry(path: string, key = "mcpServers"): boolean {
  const servers = readJson(path)?.[key];
  return Boolean(servers && typeof servers === "object" && "amem" in (servers as object));
}

function mentionsAmem(path: string): boolean {
  try {
    return /\bamem\b/.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

/** `[mcp_servers.amem]` (or a quoted key) in a TOML config such as Codex's. */
function tomlHasAmemServer(path: string): boolean {
  try {
    return /^\s*\[\s*mcp_servers\.("?)amem\1\s*\]/m.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

function hooksMentionAmem(path: string): boolean {
  const hooks = readJson(path)?.hooks;
  return Boolean(hooks && /\bamem\b|cli\.js/.test(JSON.stringify(hooks)));
}

function antigravityConfigs(home: string): string[] {
  const gem = join(home, ".gemini");
  try {
    return readdirSync(gem)
      .filter((d) => d.startsWith("antigravity"))
      .map((d) => join(gem, d, "mcp_config.json"));
  } catch {
    return [];
  }
}

function antigravityHasAmemDir(home: string): boolean {
  const gem = join(home, ".gemini");
  try {
    return readdirSync(gem)
      .filter((d) => d.startsWith("antigravity"))
      .some((d) => existsSync(join(gem, d, "mcp", "amem")));
  } catch {
    return false;
  }
}

/** Installed desktop apps we know how to point at amem, by bundle name. */
const DESKTOP_APPS: Array<{ app: string; id: string; label: string; nextStep: string }> = [
  { app: "Claude.app", id: "claude-desktop", label: "Claude Desktop", nextStep: "Run `amem setup --platform claude-desktop`" },
  { app: "Cursor.app", id: "cursor", label: "Cursor", nextStep: "Run `amem setup --platform cursor`" },
  { app: "Windsurf.app", id: "windsurf", label: "Windsurf", nextStep: "Run `amem setup --platform windsurf`" },
  { app: "Zed.app", id: "zed", label: "Zed", nextStep: "Run `amem setup --platform zed`" },
  { app: "Antigravity.app", id: "antigravity", label: "Antigravity", nextStep: "Add amem in Antigravity's MCP settings (`amem recipe` prints the entry)" },
  { app: "Perplexity.app", id: "perplexity", label: "Perplexity", nextStep: "Add amem in the app's settings → Connectors" },
  { app: "Warp.app", id: "warp", label: "Warp", nextStep: "Add amem in the app's settings → Connectors" },
];

/** Desktop apps that can't reach a local MCP server today. */
const UNSUPPORTED_APPS: Array<{ app: string; id: string; label: string; instead: string }> = [
  { app: "Gemini.app", id: "gemini-app", label: "Gemini app", instead: "Not supported: use Gemini CLI" },
  { app: "ChatGPT.app", id: "chatgpt", label: "ChatGPT", instead: "Not supported: use Codex" },
];

export function scanClients(opts: ScanOpts = {}): ClientScan {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const claudeHome = env.CLAUDE_HOME ?? join(home, ".claude");
  const cursorHome = env.CURSOR_HOME ?? join(home, ".cursor");
  const claudeJson = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");
  const desktopCfg =
    platform === "darwin"
      ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : platform === "win32"
        ? join(env.APPDATA || join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
        : join(home, ".config", "Claude", "claude_desktop_config.json");
  const zedDir = platform === "darwin" ? join(home, "Library", "Application Support", "Zed") : join(home, ".config", "zed");

  const checks: Array<{ id: string; label: string; via: Array<[string, boolean]> }> = [
    {
      id: "claude-code",
      label: "Claude Code",
      via: [
        ["hooks", hooksMentionAmem(join(claudeHome, "settings.json"))],
        ["mcp", hasAmemEntry(claudeJson)],
      ],
    },
    {
      id: "cursor",
      label: "Cursor",
      via: [
        ["mcp", hasAmemEntry(join(cursorHome, "mcp.json"))],
        ["hooks", hooksMentionAmem(join(cursorHome, "hooks.json"))],
      ],
    },
    { id: "claude-desktop", label: "Claude Desktop", via: [["mcp", hasAmemEntry(desktopCfg)]] },
    { id: "windsurf", label: "Windsurf", via: [["mcp", hasAmemEntry(join(home, ".codeium", "windsurf", "mcp_config.json"))]] },
    { id: "gemini", label: "Gemini CLI", via: [["mcp", hasAmemEntry(join(home, ".gemini", "settings.json"))]] },
    { id: "antigravity", label: "Antigravity", via: [["mcp", antigravityConfigs(home).some((p) => hasAmemEntry(p))]] },
    { id: "codex", label: "OpenAI Codex", via: [["mcp", tomlHasAmemServer(join(home, ".codex", "config.toml"))]] },
    { id: "zed", label: "Zed", via: [["mcp", hasAmemEntry(join(zedDir, "settings.json"), "context_servers")]] },
    {
      id: "continue",
      label: "Continue",
      via: [["mcp", existsSync(join(home, ".continue", "mcpServers", "amem.yaml")) || mentionsAmem(join(home, ".continue", "config.json"))]],
    },
  ];

  const connected: ConnectedClient[] = checks
    .map((c) => ({ id: c.id, label: c.label, via: c.via.filter(([, on]) => on).map(([how]) => how) }))
    .filter((c) => c.via.length > 0);
  const connectedIds = new Set(connected.map((c) => c.id));

  const detected: DetectedClient[] = [];
  const seen = new Set<string>();
  const add = (d: Omit<DetectedClient, "guide">) => {
    if (connectedIds.has(d.id) || seen.has(d.id)) return;
    seen.add(d.id);
    detected.push({ ...d, guide: clientGuide(d.id) });
  };
  // CLI clients whose config folder exists but has no amem entry.
  if (existsSync(join(home, ".gemini", "settings.json"))) {
    add({ id: "gemini", label: "Gemini CLI", nextStep: "Add amem under mcpServers in ~/.gemini/settings.json (`amem recipe` prints the entry)" });
  }
  if (antigravityHasAmemDir(home) || antigravityConfigs(home).some((p) => existsSync(p))) {
    add({ id: "antigravity", label: "Antigravity", nextStep: "Add amem in Antigravity's MCP settings (`amem recipe` prints the entry)" });
  }
  if (existsSync(join(home, ".codex"))) {
    add({ id: "codex", label: "OpenAI Codex", nextStep: "Add [mcp_servers.amem] to ~/.codex/config.toml (`amem recipe` prints the entry)" });
  }
  const unsupported: UnsupportedClient[] = [];
  if (platform === "darwin") {
    const dirs = opts.appDirs ?? ["/Applications", join(home, "Applications")];
    const installed = (app: string) => dirs.some((d) => existsSync(join(d, app)));
    for (const a of DESKTOP_APPS) {
      if (installed(a.app)) add({ id: a.id, label: a.label, nextStep: a.nextStep });
    }
    for (const a of UNSUPPORTED_APPS) {
      if (installed(a.app)) unsupported.push({ id: a.id, label: a.label, instead: a.instead, guide: clientGuide(a.id) });
    }
  }
  return { connected, detected, unsupported };
}

/**
 * Activity names a connected client may log under. Clients identify themselves in
 * MCP clientInfo however they like; normalizeClient() folds the common spellings, and
 * this covers the rest (e.g. Antigravity reporting through the Gemini stack).
 */
export const CLIENT_ACTIVITY_ALIASES: Record<string, string[]> = {
  "claude-code": ["claude-code", "claude"],
  cursor: ["cursor"],
  "claude-desktop": ["claude-desktop", "claude-ai"],
  windsurf: ["windsurf"],
  gemini: ["gemini", "gemini-cli", "gemini-cli-mcp-client"],
  antigravity: ["antigravity"],
  codex: ["codex", "codex-mcp-client"],
  zed: ["zed"],
  continue: ["continue"],
};

/** Connected clients with no calls among the given activity client ids. */
export function idleClients(scan: ClientScan, activeClientIds: Iterable<string>): ConnectedClient[] {
  const active = new Set([...activeClientIds].map((c) => String(c).toLowerCase()));
  return scan.connected.filter((c) => !(CLIENT_ACTIVITY_ALIASES[c.id] ?? [c.id]).some((name) => active.has(name)));
}
