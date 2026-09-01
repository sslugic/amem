export type PlatformGroup = "cli" | "ide" | "desktop" | "cloud" | "internal";

export type KnownPlatform = {
  id: string;
  label: string;
  hint: string;
  group: PlatformGroup;
  /** Shown in the Setup picker before the user expands "Show all". */
  popular?: boolean;
  /** Hidden from the Setup picker (internal ids that still pass policy). */
  hidden?: boolean;
  installs?: "cursor" | "claude" | "host";
};

export const PLATFORM_GROUPS: { id: PlatformGroup; label: string }[] = [
  { id: "cli", label: "Command-line agents" },
  { id: "ide", label: "Editors & IDE extensions" },
  { id: "desktop", label: "Desktop apps" },
  { id: "cloud", label: "Cloud agents" },
  { id: "internal", label: "amem" },
];

/**
 * Clients the Setup picker can record and the policy allow-list understands.
 *
 * Everything here speaks MCP (or, for Aider, reads a CLI hint file), so a
 * client only needs an entry to be allowed — `installs` marks the few we can
 * configure for the user rather than handing them the `amem recipe` URL.
 */
export const KNOWN_PLATFORMS: KnownPlatform[] = [
  // --- Command-line agents -------------------------------------------------
  {
    id: "claude",
    label: "Claude Code",
    hint: "Skills and settings hooks",
    group: "cli",
    popular: true,
    installs: "claude",
  },
  { id: "codex", label: "OpenAI Codex", hint: "MCP / HTTP API", group: "cli", popular: true },
  { id: "gemini", label: "Gemini CLI", hint: "MCP / HTTP API", group: "cli", popular: true },
  { id: "grok", label: "Grok", hint: "MCP / HTTP API", group: "cli", popular: true },
  {
    id: "aider",
    label: "Aider",
    hint: "CLI hint file in repo",
    group: "cli",
    popular: true,
    installs: "host",
  },
  { id: "opencode", label: "OpenCode", hint: "MCP / HTTP API", group: "cli" },
  { id: "goose", label: "Goose", hint: "MCP / HTTP API", group: "cli" },
  { id: "crush", label: "Crush", hint: "MCP / HTTP API", group: "cli" },
  { id: "amp", label: "Amp", hint: "MCP / HTTP API", group: "cli" },
  { id: "qwen", label: "Qwen Code", hint: "MCP / HTTP API", group: "cli" },
  { id: "droid", label: "Factory Droid", hint: "MCP / HTTP API", group: "cli" },
  { id: "openhands", label: "OpenHands", hint: "MCP / HTTP API", group: "cli" },
  { id: "amazon-q", label: "Amazon Q Developer", hint: "MCP / HTTP API", group: "cli" },
  { id: "warp", label: "Warp", hint: "MCP / HTTP API", group: "cli" },

  // --- Editors & IDE extensions -------------------------------------------
  {
    id: "cursor",
    label: "Cursor",
    hint: "Rules, skills, hooks",
    group: "ide",
    popular: true,
    installs: "cursor",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    hint: "MCP config installer",
    group: "ide",
    popular: true,
    installs: "host",
  },
  {
    id: "continue",
    label: "Continue",
    hint: "MCP config installer",
    group: "ide",
    popular: true,
    installs: "host",
  },
  {
    id: "zed",
    label: "Zed",
    hint: "context_servers MCP",
    group: "ide",
    popular: true,
    installs: "host",
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    hint: "VS Code / CLI, MCP",
    group: "ide",
    popular: true,
  },
  { id: "cline", label: "Cline", hint: "MCP / HTTP API", group: "ide" },
  { id: "roo", label: "Roo Code", hint: "MCP / HTTP API", group: "ide" },
  { id: "kilo", label: "Kilo Code", hint: "MCP / HTTP API", group: "ide" },
  { id: "augment", label: "Augment Code", hint: "MCP / HTTP API", group: "ide" },
  { id: "cody", label: "Sourcegraph Cody", hint: "MCP / HTTP API", group: "ide" },
  { id: "jetbrains", label: "JetBrains AI / Junie", hint: "MCP / HTTP API", group: "ide" },
  { id: "kiro", label: "Kiro", hint: "MCP / HTTP API", group: "ide" },
  { id: "trae", label: "Trae", hint: "MCP / HTTP API", group: "ide" },
  { id: "antigravity", label: "Antigravity", hint: "MCP / HTTP API", group: "ide" },
  { id: "neovim", label: "Neovim", hint: "Avante / CodeCompanion MCP", group: "ide" },

  // --- Desktop apps --------------------------------------------------------
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    hint: "MCP config installer",
    group: "desktop",
    popular: true,
    installs: "host",
  },

  // --- Cloud agents --------------------------------------------------------
  { id: "devin", label: "Devin", hint: "MCP / HTTP API", group: "cloud" },
  { id: "jules", label: "Jules", hint: "MCP / HTTP API", group: "cloud" },

  // --- Internal ------------------------------------------------------------
  { id: "app", label: "amem app", hint: "Built-in workspaces", group: "internal", hidden: true },
  { id: "luna", label: "Luna", hint: "amem-native agent", group: "internal", hidden: true },
];

const KNOWN_IDS = new Set(KNOWN_PLATFORMS.map((p) => p.id));

/**
 * Spellings a client (or a person) may hand us for a platform we already know.
 *
 * Claude Code identifies itself as "claude-code", VS Code as "vscode", every
 * JetBrains IDE by its own product name. Blocking those as unknown platforms is
 * never what the allow-list is for, so they resolve to the canonical id.
 */
export const PLATFORM_ALIASES: Record<string, string> = {
  // Claude
  "claude-code": "claude",
  claudecode: "claude",
  cc: "claude",
  anthropic: "claude",
  claudedesktop: "claude-desktop",
  "claude-app": "claude-desktop",
  cowork: "claude-desktop",
  // OpenAI
  openai: "codex",
  chatgpt: "codex",
  "chatgpt-desktop": "codex",
  "openai-codex": "codex",
  "codex-cli": "codex",
  // Google
  google: "gemini",
  "gemini-cli": "gemini",
  "google-gemini": "gemini",
  "gemini-code-assist": "gemini",
  "google-jules": "jules",
  "google-antigravity": "antigravity",
  // xAI
  xai: "grok",
  "grok-cli": "grok",
  "grok-code": "grok",
  "grok-code-fast": "grok",
  // GitHub / VS Code
  "github-copilot": "copilot",
  githubcopilot: "copilot",
  "gh-copilot": "copilot",
  "copilot-cli": "copilot",
  "copilot-chat": "copilot",
  vscode: "copilot",
  "vs-code": "copilot",
  "visual-studio-code": "copilot",
  code: "copilot",
  // Editors
  "cursor-ide": "cursor",
  "cursor-cli": "cursor",
  codeium: "windsurf",
  "windsurf-ide": "windsurf",
  "zed-editor": "zed",
  "continue-dev": "continue",
  continuedev: "continue",
  "aider-chat": "aider",
  nvim: "neovim",
  vim: "neovim",
  avante: "neovim",
  codecompanion: "neovim",
  // JetBrains family
  intellij: "jetbrains",
  "intellij-idea": "jetbrains",
  idea: "jetbrains",
  junie: "jetbrains",
  pycharm: "jetbrains",
  webstorm: "jetbrains",
  goland: "jetbrains",
  rider: "jetbrains",
  phpstorm: "jetbrains",
  clion: "jetbrains",
  rubymine: "jetbrains",
  datagrip: "jetbrains",
  "android-studio": "jetbrains",
  "jetbrains-ai": "jetbrains",
  // CLI agents
  "sst-opencode": "opencode",
  "open-code": "opencode",
  "block-goose": "goose",
  "charm-crush": "crush",
  "sourcegraph-amp": "amp",
  "amp-code": "amp",
  "qwen-code": "qwen",
  qwencoder: "qwen",
  "qwen3-coder": "qwen",
  factory: "droid",
  "factory-droid": "droid",
  "open-hands": "openhands",
  "openhands-ai": "openhands",
  "all-hands": "openhands",
  q: "amazon-q",
  amazonq: "amazon-q",
  "aws-q": "amazon-q",
  "q-developer": "amazon-q",
  "amazon-q-developer": "amazon-q",
  "warp-terminal": "warp",
  "aws-kiro": "kiro",
  "trae-ide": "trae",
  "trae-ai": "trae",
  "claude-dev": "cline",
  "roo-code": "roo",
  roocode: "roo",
  "roo-cline": "roo",
  "kilo-code": "kilo",
  kilocode: "kilo",
  "augment-code": "augment",
  augmentcode: "augment",
  "sourcegraph-cody": "cody",
  cognition: "devin",
  "cognition-devin": "devin",
  // amem itself
  amem: "app",
  "amem-app": "app",
  desktop: "app",
};

/** Lowercase, trim, and fold separators so "Claude_Code" == "claude-code". */
function canonicalize(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\.app$/, "")
    .replace(/[\s_.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Resolve any spelling of a client to its canonical platform id. Unknown ids
 * come back canonicalized (not empty) so callers can report what was asked for.
 */
export function resolvePlatformId(raw: string): string {
  const id = canonicalize(raw);
  if (KNOWN_IDS.has(id)) return id;
  const aliased = PLATFORM_ALIASES[id];
  if (aliased && KNOWN_IDS.has(aliased)) return aliased;
  return id;
}

export function isKnownPlatform(id: string): boolean {
  return KNOWN_IDS.has(resolvePlatformId(id));
}

export function platformLabel(id: string): string {
  const resolved = resolvePlatformId(id);
  return KNOWN_PLATFORMS.find((p) => p.id === resolved)?.label ?? id;
}

/** Ids offered in the Setup picker (everything the user can actually pick). */
export const PICKABLE_PLATFORMS = KNOWN_PLATFORMS.filter((p) => !p.hidden);

export function normalizePlatforms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const id = resolvePlatformId(value);
    if (!KNOWN_IDS.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

export const HOST_INSTALL_IDS = new Set(
  KNOWN_PLATFORMS.filter((p) => p.installs === "host").map((p) => p.id),
);

/** Platforms with no local installer: they connect over MCP via `amem recipe`. */
export function usesGenericMcp(id: string): boolean {
  const resolved = resolvePlatformId(id);
  const entry = KNOWN_PLATFORMS.find((p) => p.id === resolved);
  return Boolean(entry) && !entry?.installs;
}
