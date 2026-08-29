/**
 * Procedural memory. Claims are small facts that ride in every packet; a skill is a
 * longer procedure that should only load when it is relevant.
 *
 * Files on disk are the source of truth (`~/.amem/skills/<name>/SKILL.md`), because every
 * other agent tool in this ecosystem — Cursor, Claude, Hermes — discovers skills by
 * scanning folders, and a skill's `references/` and `scripts/` do not fit in a column.
 * SQLite only indexes them for ranking and usage stats; see `src/db.ts`.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { pruneSkillRows, upsertSkillRow } from "./db.js";
import { amemHome } from "./paths.js";
import { compiledDenyPatterns } from "./policy.js";
import { tokenize } from "./search.js";

export const SKILL_FILE = "SKILL.md";
/** Subdirectories a skill may carry, matching the agentskills.io layout. */
export const SKILL_ASSET_DIRS = ["references", "templates", "scripts", "examples", "assets"];

export type SkillSource = "local" | "bundled" | "import";

export type SkillMeta = {
  name: string;
  description: string;
  version: string | null;
  tags: string[];
  /** Absolute path to the skill's SKILL.md. */
  path: string;
  /** Absolute path to the skill directory. */
  dir: string;
  hash: string;
  source: SkillSource;
};

export function skillsDir(): string {
  return join(amemHome(), "skills");
}

export function ensureSkillsDir(): string {
  const dir = skillsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function hashSkillContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/**
 * Skill names become directory names and slash commands, so keep them to the identifier
 * shape the ecosystem uses and never let one escape the skills directory.
 */
export function slugifySkillName(raw: string): string {
  const slug = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug;
}

export function isValidSkillName(raw: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(String(raw || "")) && String(raw).length <= 64;
}

export type Frontmatter = { meta: Record<string, string | string[]>; body: string };

/**
 * Minimal YAML-frontmatter reader — enough for the scalar and inline-list keys skills
 * actually use. Nested keys are flattened to their leaf (`metadata.hermes.tags` -> `tags`)
 * so a Hermes-authored skill and a Cursor-authored one both parse.
 */
export function parseFrontmatter(raw: string): Frontmatter {
  const text = String(raw ?? "").replace(/^\uFEFF/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { meta: {}, body: text.trim() };

  const meta: Record<string, string | string[]> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].split(".").pop()!.toLowerCase();
    const value = kv[2].trim();
    if (!value) continue; // a bare `metadata:` parent carries nothing itself
    if (value.startsWith("[") && value.endsWith("]")) {
      meta[key] = value
        .slice(1, -1)
        .split(",")
        .map((v) => stripQuotes(v.trim()))
        .filter(Boolean);
    } else {
      meta[key] = stripQuotes(value);
    }
  }
  return { meta, body: text.slice(match[0].length).trim() };
}

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function metaString(meta: Record<string, string | string[]>, key: string): string | null {
  const v = meta[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function metaList(meta: Record<string, string | string[]>, key: string): string[] {
  const v = meta[key];
  if (Array.isArray(v)) return v.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim());
  if (typeof v === "string" && v.trim()) return v.split(/[,\s]+/).filter(Boolean);
  return [];
}

/** First markdown heading, used when a skill has no `description:` to show. */
function firstHeading(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const h = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (h) return h[1].trim();
  }
  return "";
}

export function readSkillMeta(dir: string, source: SkillSource = "local"): SkillMeta | null {
  const file = join(dir, SKILL_FILE);
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  const raw = readFileSync(file, "utf8");
  const { meta, body } = parseFrontmatter(raw);
  // Name resolution mirrors the ecosystem: frontmatter first, then the folder name.
  const declared = metaString(meta, "name");
  const name = isValidSkillName(declared || "") ? declared! : slugifySkillName(dir.split(sep).pop() || "");
  if (!name) return null;
  return {
    name,
    description: metaString(meta, "description") || firstHeading(body),
    version: metaString(meta, "version"),
    tags: metaList(meta, "tags"),
    path: file,
    dir,
    hash: hashSkillContent(raw),
    source,
  };
}

/** Every skill on disk, sorted by name. Skips dot/underscore dirs like the hub state. */
export function scanSkills(root = skillsDir()): SkillMeta[] {
  if (!existsSync(root)) return [];
  const out: SkillMeta[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const dir = join(root, entry.name);
    const meta = readSkillMeta(dir);
    if (meta) {
      out.push(meta);
      continue;
    }
    // One level of category nesting, the way Hermes groups skills (mlops/axolotl).
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      if (!child.isDirectory() || child.name.startsWith(".")) continue;
      const nested = readSkillMeta(join(dir, child.name));
      if (nested) out.push(nested);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function findSkillOnDisk(name: string, root = skillsDir()): SkillMeta | null {
  const slug = slugifySkillName(name);
  if (!slug) return null;
  return scanSkills(root).find((s) => s.name === slug) ?? null;
}

export function skillDirFor(name: string, root = skillsDir()): string {
  const slug = slugifySkillName(name);
  if (!isValidSkillName(slug)) throw new Error(`Invalid skill name: ${name}`);
  return join(root, slug);
}

export function readSkillBody(name: string, root = skillsDir()): string | null {
  const meta = findSkillOnDisk(name, root);
  return meta ? readFileSync(meta.path, "utf8") : null;
}

/**
 * Read a supporting file (`references/foo.md`). Skills come from other people, so the
 * path is resolved and re-checked rather than trusted.
 */
export function readSkillAsset(name: string, relPath: string, root = skillsDir()): string | null {
  const meta = findSkillOnDisk(name, root);
  if (!meta) return null;
  const base = resolve(meta.dir);
  const target = resolve(base, relPath);
  // resolve() collapses "..", and an absolute relPath lands outside base — both caught here.
  if (target !== base && !target.startsWith(base + sep)) return null;
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  return readFileSync(target, "utf8");
}

export function listSkillAssets(name: string, root = skillsDir()): string[] {
  const meta = findSkillOnDisk(name, root);
  if (!meta) return [];
  const out: string[] = [];
  for (const sub of SKILL_ASSET_DIRS) {
    const dir = join(meta.dir, sub);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) out.push(`${sub}/${entry.name}`);
    }
  }
  return out.sort();
}

/** Render a SKILL.md from parts, for `amem skills new` and agent-authored saves. */
export function renderSkillMarkdown(input: {
  name: string;
  description: string;
  body?: string;
  version?: string;
  tags?: string[];
}): string {
  const lines = ["---", `name: ${input.name}`, `description: ${input.description}`];
  if (input.version) lines.push(`version: ${input.version}`);
  if (input.tags?.length) lines.push(`tags: [${input.tags.join(", ")}]`);
  lines.push("---", "");
  const body = (input.body || "").trim();
  lines.push(body || defaultSkillBody(input.name));
  return `${lines.join("\n")}\n`;
}

function defaultSkillBody(name: string): string {
  const title = name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return [
    `# ${title}`,
    "",
    "## When to use",
    "",
    "Describe the trigger — the situation where this procedure applies.",
    "",
    "## Procedure",
    "",
    "1. First step.",
    "2. Second step.",
    "",
    "## Pitfalls",
    "",
    "- Known failure modes and how to get past them.",
    "",
    "## Verification",
    "",
    "How to confirm it worked.",
  ].join("\n");
}

export function writeSkill(
  name: string,
  content: string,
  root = skillsDir(),
): { name: string; path: string; hash: string } {
  const slug = slugifySkillName(name);
  if (!isValidSkillName(slug)) throw new Error(`Invalid skill name: ${name}`);
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, SKILL_FILE);
  const body = content.endsWith("\n") ? content : `${content}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  return { name: slug, path, hash: hashSkillContent(body) };
}

export function deleteSkill(name: string, root = skillsDir()): boolean {
  const meta = findSkillOnDisk(name, root);
  if (!meta) return false;
  rmSync(meta.dir, { recursive: true, force: true });
  return true;
}

/**
 * Prompt-injection shapes that have no business in a stored procedure. A skill is riskier
 * than a claim: a claim is a fact the agent reads, a skill is an instruction it follows.
 */
const SKILL_INJECTION_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/i,
    reason: "prompt-injection directive",
  },
  { re: /disregard\s+(?:your\s+)?(?:system\s+prompt|safety|guidelines)/i, reason: "safety override" },
  { re: /\bcurl\b[^\n]*\|\s*(?:ba)?sh\b/i, reason: "pipes a remote script into a shell" },
  { re: /rm\s+-rf\s+[~/]\s*(?:$|[^\w/])/im, reason: "destructive filesystem command" },
  {
    re: /(?:curl|wget|fetch)[^\n]*(?:AWS_|API_KEY|SECRET|TOKEN|\.env\b|id_rsa)/i,
    reason: "looks like credential exfiltration",
  },
];

export type SkillScan = { ok: true } | { ok: false; reason: string };

/**
 * Gate content before it lands in the library. Deny patterns come from policy so an IT
 * operator's additions apply to skills too, not just claims.
 */
export function scanSkillContent(content: string, denyPatterns?: RegExp[]): SkillScan {
  const text = String(content ?? "");
  if (!text.trim()) return { ok: false, reason: "empty skill content" };
  for (const { re, reason } of SKILL_INJECTION_PATTERNS) {
    if (re.test(text)) return { ok: false, reason };
  }
  const deny = denyPatterns ?? compiledDenyPatterns();
  for (const re of deny) {
    if (re.test(text)) return { ok: false, reason: `matches deny pattern ${re.source}` };
  }
  return { ok: true };
}

/**
 * Import a skill from a local directory. Local paths only — no registries and no network,
 * which keeps this on the right side of the "no cloud, no hosted anything" line.
 * Supporting files come along, but only from the allowlisted asset directories.
 */
export function importSkillFromPath(
  sourcePath: string,
  overrideName?: string,
  root = skillsDir(),
): { name: string; path: string; files: string[] } {
  const src = resolve(sourcePath);
  if (!existsSync(src)) throw new Error(`No such path: ${sourcePath}`);
  const srcDir = statSync(src).isDirectory() ? src : join(src, "..");
  const skillFile = statSync(src).isDirectory() ? join(src, SKILL_FILE) : src;
  if (!existsSync(skillFile)) throw new Error(`No ${SKILL_FILE} found at ${sourcePath}`);

  const raw = readFileSync(skillFile, "utf8");
  const scan = scanSkillContent(raw);
  if (!scan.ok) throw new Error(`Refusing to import: ${scan.reason}`);

  const { meta } = parseFrontmatter(raw);
  const declared = typeof meta.name === "string" ? meta.name : "";
  const candidate = overrideName || declared || srcDir.split(sep).pop() || "";
  const slug = slugifySkillName(candidate);
  if (!isValidSkillName(slug)) {
    throw new Error(`Could not derive a skill name from ${sourcePath} — pass --name`);
  }

  const written = writeSkill(slug, raw, root);
  const destDir = join(root, slug);
  const files: string[] = [];
  for (const sub of SKILL_ASSET_DIRS) {
    const from = join(srcDir, sub);
    if (!existsSync(from) || !statSync(from).isDirectory()) continue;
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const target = join(destDir, sub, entry.name);
      mkdirSync(join(destDir, sub), { recursive: true, mode: 0o700 });
      writeFileSync(target, readFileSync(join(from, entry.name)), { mode: 0o600 });
      files.push(`${sub}/${entry.name}`);
    }
  }
  return { name: written.name, path: written.path, files };
}

export type IndexedSkill = SkillMeta & {
  repoId: string | null;
  uses: number;
  lastUsedAt: string | null;
  /** True when the file changed since it was installed — do not overwrite these. */
  modified: boolean;
};

/**
 * Reconcile the index with disk. Cheap enough to run before any read, which keeps the
 * index honest when a user or agent edits a SKILL.md with ordinary file tools.
 */
export function syncSkillIndex(root = skillsDir()): IndexedSkill[] {
  const found = scanSkills(root);
  const out: IndexedSkill[] = [];
  for (const meta of found) {
    const row = upsertSkillRow({
      name: meta.name,
      path: meta.path,
      description: meta.description,
      version: meta.version,
      tags: meta.tags,
      contentHash: meta.hash,
      source: meta.source,
    });
    out.push({
      ...meta,
      repoId: row.repo_id,
      uses: row.uses,
      lastUsedAt: row.last_used_at,
      modified: Boolean(row.origin_hash) && row.origin_hash !== meta.hash,
    });
  }
  pruneSkillRows(found.map((s) => s.name));
  return out;
}

export function listIndexedSkills(root = skillsDir()): IndexedSkill[] {
  return syncSkillIndex(root);
}

export type RankedSkill = IndexedSkill & { score: number; reasons: string[] };

/**
 * Rank skills for a query. Deliberately matches on the index fields only — name,
 * description, tags — because the whole point is to decide what is worth loading
 * without paying for the bodies.
 */
export function skillSummary(s: SkillMeta | IndexedSkill): Record<string, unknown> {
  return {
    name: s.name,
    description: s.description,
    version: s.version,
    tags: s.tags,
    path: s.path,
    dir: s.dir,
    hash: s.hash,
    source: s.source,
    ...("repoId" in s ? { repoId: s.repoId, uses: s.uses, lastUsedAt: s.lastUsedAt, modified: s.modified } : {}),
  };
}

export function rankSkills(
  skills: IndexedSkill[],
  query: string,
  limit = 3,
): RankedSkill[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const ranked: RankedSkill[] = [];
  for (const skill of skills) {
    const name = skill.name.toLowerCase();
    const haystack = `${name} ${skill.description} ${skill.tags.join(" ")}`.toLowerCase();
    let score = 0;
    const reasons: string[] = [];
    let hits = 0;
    for (const token of tokens) {
      if (name.includes(token)) {
        score += 6;
        hits += 1;
      } else if (haystack.includes(token)) {
        score += token.length > 4 ? 3 : 2;
        hits += 1;
      }
    }
    if (hits === 0) continue;
    reasons.push(`match+${score}`);
    // A skill that keeps getting used is a better bet than one nobody has opened.
    if (skill.uses > 0) {
      const useBoost = Math.min(4, Math.log2(skill.uses + 1) * 2);
      score += useBoost;
      reasons.push(`used×${skill.uses}`);
    }
    ranked.push({ ...skill, score, reasons });
  }
  return ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}
