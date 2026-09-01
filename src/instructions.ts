import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { KNOWN_PLATFORMS, resolvePlatformId, type KnownPlatform } from "./platforms.js";

/**
 * Teaching every host how to use amem.
 *
 * Cursor got a rule file and everyone else got an MCP endpoint with no
 * explanation, so most hosts could reach memory but had no idea they should —
 * and never looked at the task board at all. This renders one canonical set of
 * instructions into whatever file each host actually reads.
 */

export const BEGIN_MARKER = "<!-- BEGIN amem (generated) -->";
export const END_MARKER = "<!-- END amem -->";

/** How amem writes a host's instruction file. */
export type InstructionMode =
  /** amem owns the whole file. */
  | "file"
  /** amem maintains a marked block inside a file the user also edits. */
  | "block";

/** What the host can actually call. */
export type InstructionSurface = "mcp" | "cli";

export type InstructionTarget = {
  /** Repo-relative path of the file to write. */
  path: string;
  mode: InstructionMode;
  surface: InstructionSurface;
  /** Platform ids that read this file. */
  platforms: string[];
  /** Front matter for hosts that require it (Cursor .mdc). */
  frontmatter?: string;
};

/**
 * Where each host reads project instructions.
 *
 * Anything not listed here falls back to AGENTS.md, which most current agents
 * read and which costs nothing when they do not.
 */
const HOST_FILES: Record<string, { path: string; mode: InstructionMode; frontmatter?: string }> = {
  cursor: {
    path: ".cursor/rules/amem.mdc",
    mode: "file",
    frontmatter: [
      "---",
      "description: Use local personal amem memory and tasks before broad codebase exploration",
      "globs:",
      "alwaysApply: true",
      "---",
      "",
    ].join("\n"),
  },
  claude: { path: "CLAUDE.md", mode: "block" },
  copilot: { path: ".github/copilot-instructions.md", mode: "block" },
  gemini: { path: "GEMINI.md", mode: "block" },
  windsurf: { path: ".windsurf/rules/amem.md", mode: "file" },
  continue: { path: ".continue/rules/amem.md", mode: "file" },
  cline: { path: ".clinerules/amem.md", mode: "file" },
  roo: { path: ".roo/rules/amem.md", mode: "file" },
  kilo: { path: ".kilocode/rules/amem.md", mode: "file" },
  augment: { path: ".augment/rules/amem.md", mode: "file" },
  kiro: { path: ".kiro/steering/amem.md", mode: "file" },
  trae: { path: ".trae/rules/amem.md", mode: "file" },
  jetbrains: { path: ".junie/guidelines.md", mode: "block" },
  "amazon-q": { path: ".amazonq/rules/amem.md", mode: "file" },
  goose: { path: ".goosehints", mode: "block" },
  aider: { path: ".aider.amem.md", mode: "file" },
};

/** Hosts with no MCP transport — they get CLI instructions instead. */
const CLI_ONLY = new Set(["aider"]);

/** The convergent default for hosts without their own convention. */
const FALLBACK_FILE = "AGENTS.md";

function platformLabel(id: string): string {
  return KNOWN_PLATFORMS.find((p) => p.id === id)?.label ?? id;
}

function selectablePlatforms(): KnownPlatform[] {
  // Internal ids (app, luna) are not editors a person configures.
  return KNOWN_PLATFORMS.filter((p) => p.group !== "internal");
}

/**
 * Resolve the instruction files to write for a set of platforms, merging hosts
 * that share a file so AGENTS.md is written once rather than fifteen times.
 */
export function instructionTargets(platformIds: string[]): InstructionTarget[] {
  const byPath = new Map<string, InstructionTarget>();
  for (const raw of platformIds) {
    const id = resolvePlatformId(raw) ?? raw;
    const known = KNOWN_PLATFORMS.find((p) => p.id === id);
    if (!known || known.group === "internal") continue;
    const spec = HOST_FILES[id] ?? { path: FALLBACK_FILE, mode: "block" as InstructionMode };
    const surface: InstructionSurface = CLI_ONLY.has(id) ? "cli" : "mcp";
    const key = `${spec.path}::${surface}`;
    const existing = byPath.get(key);
    if (existing) {
      if (!existing.platforms.includes(id)) existing.platforms.push(id);
      continue;
    }
    byPath.set(key, {
      path: spec.path,
      mode: spec.mode,
      surface,
      platforms: [id],
      frontmatter: spec.frontmatter,
    });
  }
  return [...byPath.values()];
}

/** Every platform a user could pick — used by `--all`. */
export function allInstructionTargets(): InstructionTarget[] {
  return instructionTargets(selectablePlatforms().map((p) => p.id));
}

function mcpBody(): string {
  return `## amem — local personal memory & tasks

amem keeps durable facts about this repo, plus a task board, in a private local
database (\`~/.amem\`). It is personal to this machine and never uploaded.

**Start here, before exploring the tree.**

### 1. Open tasks — check these first
There may be work already queued from an earlier session. Do not start fresh
without looking.

- \`amem_task_list\` — pending and in-progress tasks. Check it at the start of a session.
- \`amem_task_add\` — record deferred work, follow-ups, or anything that would otherwise be lost when the chat ends.
- \`amem_task_update <id> --status doing\` — claim a task before working it.
- \`amem_task_complete <id>\` — mark it finished as soon as it is done, so history survives.

### 2. Memory before exploration
- \`amem_context "<question>"\` — durable facts with file anchors, ranked. Query this before broad greps or multi-folder reads.
- Prefer the returned anchors over searching. Still verify the code before editing: trust **fresh** claims, re-check anything marked **stale**.
- The **Why:** line explains ranking. It is explainability, not proof.
- \`amem_remember "<fact>"\` — store a durable, anchored fact when you learn one. Facts about the repo, not chat filler.

### 3. Skills — procedures worth repeating
- A \`## Relevant skills\` section lists names only. If one applies, call \`amem_skill_view\` to load it **before** working the problem out yourself.
- \`amem_skill_save\` — write up a multi-step workflow, a dead end you found the way past, or a correction you were given.

### 4. Report what the memory was worth
- After acting on an amem packet, call \`amem_usage_report\` with \`anchors_opened\` (which of the packet's anchor files you opened anyway) and \`answered\` (did it spare you broad exploration).
- Do **not** estimate token counts. Report only what you observed; amem computes the saving from real file sizes.
- "I opened all of them" and \`answered: false\` are correct answers when true. Under-reporting makes amem's own numbers dishonest, which is worse than a low score.

Memory is personal and local. Do not commit exports, backups, or database copies.`;
}

function cliBody(): string {
  return `## amem — local personal memory & tasks

amem keeps durable facts about this repo, plus a task board, in a private local
database (\`~/.amem\`). It is personal to this machine and never uploaded.

**Start here, before exploring the tree.**

### 1. Open tasks — check these first
There may be work already queued from an earlier session.

\`\`\`bash
amem task list                      # pending and in-progress work
amem task add "..." --body "..."    # record deferred work so it survives the chat
amem task update <id> --status doing
amem task complete <id>             # as soon as it is finished
\`\`\`

### 2. Memory before exploration

\`\`\`bash
amem context "<question>"           # durable facts with file anchors, ranked
amem remember "<fact>" --anchor path/to/file
\`\`\`

Prefer the returned anchors over broad greps. Verify the code before editing:
trust **fresh** claims, re-check anything marked **stale**.

### 3. Report what the memory was worth

\`\`\`bash
amem usage attest --opened "path/a.ts,path/b.ts"   # anchors you opened anyway
\`\`\`

Do not estimate token counts — report only what you observed. amem computes the
saving from real file sizes.

Memory is personal and local. Do not commit exports, backups, or database copies.`;
}

/** The instruction text for one target. */
export function renderInstructions(target: InstructionTarget): string {
  const body = target.surface === "cli" ? cliBody() : mcpBody();
  const hosts = target.platforms.map(platformLabel).join(", ");
  const note = `<!-- Generated by amem for: ${hosts}. Safe to commit: guidance only, no memory contents. -->`;
  if (target.mode === "file") {
    return `${target.frontmatter ?? ""}${note}\n\n${body}\n`;
  }
  return `${BEGIN_MARKER}\n${note}\n\n${body}\n${END_MARKER}\n`;
}

export type InstructionStatus = "written" | "updated" | "unchanged" | "would-write";

export type InstructionApplyResult = {
  path: string;
  platforms: string[];
  status: InstructionStatus;
};

function upsertBlock(existing: string, block: string): string {
  const start = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + END_MARKER.length).replace(/^\n/, "");
    return `${before}${block}${after}`;
  }
  // Never clobber a file the user already writes in — append instead.
  const trimmed = existing.replace(/\s*$/, "");
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

/**
 * Write instructions for the given targets. Dry run reports what would change
 * without touching disk, so `--check` can be used in CI or by doctor.
 */
export function applyInstructions(
  repoRoot: string,
  targets: InstructionTarget[],
  opts: { dryRun?: boolean } = {},
): InstructionApplyResult[] {
  const results: InstructionApplyResult[] = [];
  for (const target of targets) {
    const full = join(repoRoot, target.path);
    const rendered = renderInstructions(target);
    const exists = existsSync(full);
    const existing = exists ? readFileSync(full, "utf8") : "";
    const next = target.mode === "file" ? rendered : upsertBlock(existing, rendered);

    let status: InstructionStatus;
    if (exists && existing === next) status = "unchanged";
    else if (opts.dryRun) status = "would-write";
    else status = exists ? "updated" : "written";

    if (!opts.dryRun && status !== "unchanged") {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, next, "utf8");
    }
    results.push({ path: target.path, platforms: target.platforms, status });
  }
  return results;
}

/** Targets whose file is missing or out of date. */
export function missingInstructions(
  repoRoot: string,
  targets: InstructionTarget[],
): InstructionApplyResult[] {
  return applyInstructions(repoRoot, targets, { dryRun: true }).filter(
    (r) => r.status !== "unchanged",
  );
}
