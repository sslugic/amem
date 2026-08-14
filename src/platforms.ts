export type KnownPlatform = {
  id: string;
  label: string;
  hint: string;
  installs?: "cursor" | "claude";
};

/** Clients the Setup picker can record. Cursor/Claude also get local installers. */
export const KNOWN_PLATFORMS: KnownPlatform[] = [
  { id: "cursor", label: "Cursor", hint: "Rules, skills, hooks", installs: "cursor" },
  { id: "claude", label: "Claude Code", hint: "Skills and settings hooks", installs: "claude" },
  { id: "copilot", label: "GitHub Copilot", hint: "MCP / HTTP API" },
  { id: "codex", label: "ChatGPT / Codex", hint: "MCP / HTTP API" },
  { id: "gemini", label: "Gemini", hint: "MCP / HTTP API" },
  { id: "windsurf", label: "Windsurf", hint: "MCP / HTTP API" },
  { id: "grok", label: "Grok", hint: "MCP / HTTP API" },
];

const KNOWN_IDS = new Set(KNOWN_PLATFORMS.map((p) => p.id));

export function isKnownPlatform(id: string): boolean {
  return KNOWN_IDS.has(id);
}

export function normalizePlatforms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const id = value.trim().toLowerCase();
    if (!KNOWN_IDS.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}
