#!/usr/bin/env node
/**
 * Generate the amem plugin pack from the package itself, so versions, skills and agent
 * instructions never drift. Run after `npm run build` and after every version bump:
 *
 *   node scripts/sync-plugins.mjs          # write
 *   node scripts/sync-plugins.mjs --check  # exit 1 if anything is out of date (CI)
 *
 * Outputs (all committed):
 *   plugins/amem/                 one plugin for Claude Code, Cursor, Codex (Agent Plugins)
 *   plugins/amem-desktop/         Claude Desktop bundle source (.mcpb, packed in release CI)
 *   .claude-plugin/marketplace.json   `/plugin marketplace add sslugic/amem` (Claude Code; also read by ChatGPT desktop)
 *   .agents/plugins/marketplace.json  `codex plugin marketplace add sslugic/amem`
 *   .cursor-plugin/marketplace.json   Cursor multi-plugin repo pointer
 *   gemini-extension.json             `gemini extensions install https://github.com/sslugic/amem`
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { instructionTargets, renderInstructions } = await import(pathToFileURL(join(root, "dist", "instructions.js")).href);

const VERSION = pkg.version;
const TAGLINE = "amem — agent memory, anchored to your code";
const DESCRIPTION =
  "Local memory for coding agents: file-anchored facts that flag themselves stale, on-demand skills and a shared task board, in one SQLite file on your machine. No cloud, no API keys.";
const AUTHOR = { name: "amem", url: "https://getamem.com" };
const HOMEPAGE = "https://getamem.com";
const REPO = "https://github.com/sslugic/amem";
const KEYWORDS = ["memory", "mcp", "agent-memory", "context", "local-first", "sqlite", "skills", "tasks"];

/** MCP launch: npx works on macOS, Linux and Windows and needs no prior install. */
const NPX_MCP = { command: "npx", args: ["-y", "@iamem/amem@latest", "mcp"] };
/** Hooks run on every prompt: prefer an installed amem (fast), fall back to npx. */
const hookCmd = (verb) =>
  `sh -c 'if command -v amem >/dev/null 2>&1; then exec amem ${verb}; else exec npx -y @iamem/amem@latest ${verb}; fi'`;

const files = new Map();
const put = (path, content) => files.set(path, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);

const P = "plugins/amem";

// --- Agent Plugins (portable) manifest: Codex and Cursor ---------------------------
put(`${P}/plugin.json`, {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "amem",
  version: VERSION,
  description: `${TAGLINE}. ${DESCRIPTION}`,
  author: AUTHOR,
  homepage: HOMEPAGE,
  repository: REPO,
  license: "MIT",
  keywords: KEYWORDS,
  extensions: {
    "com.openai": {
      interface: {
        displayName: "amem",
        shortDescription: "Agent memory, anchored to your code",
        longDescription: DESCRIPTION,
        developerName: "amem",
        category: "Developer Tools",
        websiteURL: HOMEPAGE,
        brandColor: "#2ec4b6",
        logo: "./assets/icon.png",
        defaultPrompt: "Call amem_bootstrap and tell me what you remember about this project.",
      },
    },
  },
});
put(`${P}/mcp.json`, {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: { amem: { type: "stdio", ...NPX_MCP } },
});

// --- Claude Code ----------------------------------------------------------------
put(`${P}/.claude-plugin/plugin.json`, {
  name: "amem",
  version: VERSION,
  description: `${TAGLINE}. ${DESCRIPTION}`,
  author: AUTHOR,
  homepage: HOMEPAGE,
  repository: REPO,
  license: "MIT",
  keywords: KEYWORDS,
  // Memory never leaves the machine; npx fetches the package from npm when amem is not installed.
  network: { hosts: ["registry.npmjs.org"] },
});
put(`${P}/.mcp.json`, { mcpServers: { amem: NPX_MCP } });
// Same schema for Claude Code and Codex desktop (Codex asks the user to trust hooks first).
const fullHook = { type: "command", command: hookCmd("hook") };
put(`${P}/hooks/hooks.json`, {
  description: "amem: hand the agent ranked memory at session start and on each prompt; capture what it learned at the end.",
  hooks: {
    SessionStart: [{ hooks: [fullHook] }],
    UserPromptSubmit: [{ hooks: [fullHook] }],
    Stop: [{ hooks: [fullHook] }],
  },
});

// --- Cursor ---------------------------------------------------------------------
put(`${P}/.cursor-plugin/plugin.json`, {
  name: "amem",
  version: VERSION,
  description: `${TAGLINE}. ${DESCRIPTION}`,
  author: AUTHOR,
  homepage: HOMEPAGE,
  repository: REPO,
  license: "MIT",
  keywords: KEYWORDS,
  logo: "assets/icon.png",
  rules: "./rules/",
  skills: "./skills/",
  mcpServers: "./mcp.json",
  hooks: "./hooks/cursor-hooks.json",
});
const cursorEntry = { command: hookCmd("hook"), description: "amem: inject and store local memory" };
put(`${P}/hooks/cursor-hooks.json`, {
  version: 1,
  hooks: Object.fromEntries(
    ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse", "stop", "sessionEnd"].map((e) => [e, [cursorEntry]]),
  ),
});

// --- Agent instructions, from the same text `amem instructions` writes --------------
const [cursorTarget] = instructionTargets(["cursor"]);
put(`${P}/rules/amem.mdc`, renderInstructions(cursorTarget));
const [geminiTarget] = instructionTargets(["gemini"]);
put(`${P}/AMEM.md`, renderInstructions({ ...geminiTarget, mode: "file", frontmatter: "" }));

put(`${P}/README.md`, `# amem plugin

*${TAGLINE}.*

One plugin folder for Claude Code, Cursor and Codex, plus a Gemini CLI extension at the repo root. It wires the amem MCP server (\`npx -y @iamem/amem mcp\`), the agent instructions, the amem skills and, where the host supports them, the hooks that hand your agent memory automatically.

| App | Install |
| --- | --- |
| Claude Code | \`/plugin marketplace add sslugic/amem\` then \`/plugin install amem@amem\` |
| Codex | \`codex plugin marketplace add sslugic/amem\`, then \`/plugins\` in Codex and install **amem** |
| Cursor | Cursor Marketplace (search "amem"), or symlink this folder into \`~/.cursor/plugins/local/\` |
| Gemini CLI | \`gemini extensions install https://github.com/sslugic/amem\` |
| Claude Desktop | Download \`amem.mcpb\` from the [latest release](${REPO}/releases/latest) and double-click it |

Requires Node 20+. Memory stays in \`~/.amem\` on your machine. Generated by \`scripts/sync-plugins.mjs\`; do not edit by hand.
`);

// --- Marketplaces and Gemini --------------------------------------------------------
put(".claude-plugin/marketplace.json", {
  name: "amem",
  owner: { name: "amem", url: HOMEPAGE },
  metadata: { description: TAGLINE, version: VERSION },
  plugins: [
    {
      name: "amem",
      source: `./${P}`,
      description: `${TAGLINE}. ${DESCRIPTION}`,
      version: VERSION,
      category: "development",
      homepage: HOMEPAGE,
    },
  ],
});
put(".agents/plugins/marketplace.json", {
  name: "amem",
  interface: { displayName: "amem" },
  plugins: [
    {
      name: "amem",
      source: { source: "local", path: `./${P}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools",
    },
  ],
});
put(".cursor-plugin/marketplace.json", {
  name: "amem",
  owner: { name: "amem", url: HOMEPAGE },
  plugins: [{ name: "amem", source: `./${P}`, description: TAGLINE }],
});
put("gemini-extension.json", {
  name: "amem",
  version: VERSION,
  description: `${TAGLINE}. ${DESCRIPTION}`,
  mcpServers: { amem: NPX_MCP },
  contextFileName: `${P}/AMEM.md`,
});

// --- Claude Desktop bundle (.mcpb) ----------------------------------------------------
const D = "plugins/amem-desktop";
put(`${D}/manifest.json`, {
  manifest_version: "0.3",
  name: "amem",
  display_name: "amem",
  version: VERSION,
  description: TAGLINE,
  long_description: `${DESCRIPTION}\n\nThis bundle starts the amem installed on your machine, or runs it with npx if none is installed. Node 20+ is required.`,
  author: AUTHOR,
  homepage: HOMEPAGE,
  repository: { type: "git", url: REPO },
  license: "MIT",
  icon: "icon.png",
  keywords: KEYWORDS,
  server: {
    type: "node",
    entry_point: "server/launcher.cjs",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/launcher.cjs"],
      env: { AMEM_WORKSPACE: "${user_config.workspace}" },
    },
  },
  user_config: {
    workspace: {
      type: "string",
      title: "Memory to use",
      description: "\"personal\" is your memory shared across projects. Use a workspace name to keep Claude Desktop on one project.",
      default: "personal",
      required: false,
    },
  },
  compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=20.0.0" } },
});

// Copy trees that live elsewhere in the repo.
const copies = [
  ["skills", `${P}/skills`],
  ["desktop/icons/icon.png", `${P}/assets/icon.png`],
  ["desktop/icons/icon.png", `${D}/icon.png`],
];

function listTree(src) {
  if (statSync(src).isFile()) return [""];
  const out = [];
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const rel = entry.name;
    if (entry.isDirectory()) for (const r of listTree(join(src, rel))) out.push(join(rel, r));
    else out.push(rel);
  }
  return out;
}

/** Byte-equal, or equal text once CRLF is normalised (git autocrlf on Windows). */
function sameFile(a, b) {
  const x = readFileSync(a);
  const y = readFileSync(b);
  if (Buffer.compare(x, y) === 0) return true;
  const norm = (buf) => buf.toString("utf8").replace(/\r\n/g, "\n");
  return !x.includes(0) && !y.includes(0) && norm(x) === norm(y);
}

let stale = [];
for (const [path, content] of files) {
  const abs = join(root, path);
  // Windows checkouts may convert line endings; compare content, not newline style.
  const current = existsSync(abs) ? readFileSync(abs, "utf8").replace(/\r\n/g, "\n") : null;
  if (current === content) continue;
  stale.push(path);
  if (!check) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}
for (const [src, dest] of copies) {
  const from = join(root, src);
  const to = join(root, dest);
  for (const rel of listTree(from)) {
    const a = rel ? join(from, rel) : from;
    const b = rel ? join(to, rel) : to;
    if (existsSync(b) && sameFile(a, b)) continue;
    stale.push(relative(root, b));
  }
  if (!check && stale.some((s) => s.startsWith(dest))) {
    if (statSync(from).isDirectory()) rmSync(to, { recursive: true, force: true });
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
}

if (check) {
  if (stale.length) {
    console.error(`Plugin pack is out of date (${stale.length} file(s)): ${stale.slice(0, 8).join(", ")}`);
    console.error("Run: npm run build && node scripts/sync-plugins.mjs");
    process.exit(1);
  }
  console.log(`Plugin pack up to date (v${VERSION}).`);
} else {
  console.log(stale.length ? `Updated ${stale.length} file(s) for v${VERSION}.` : `Plugin pack already up to date (v${VERSION}).`);
}
