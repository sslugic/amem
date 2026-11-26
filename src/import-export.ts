/**
 * `amem import` / `amem export`: move facts, tasks and skills in and out of amem.
 * Import reads CLAUDE.md / AGENTS.md / .cursorrules / *.mdc / Markdown and amem JSON
 * exports. Every item gets a content-derived id, so importing the same file twice adds
 * nothing the second time.
 */
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import {
  CLAIM_TEXT_MAX_CHARS,
  getClaim,
  insertTask,
  listClaims,
  listTasks,
  normalizeTaskStatus,
  openDb,
  setClaimExpiry,
  writeTx,
  type AgentTaskRow,
  type ClaimRow,
  type RepoRow,
} from "./db.js";
import { inferClaimKind } from "./kinds.js";
import { applyProposal, type ProposalClaim } from "./proposal.js";
import { scopeOf } from "./recall.js";
import { parseWorkspaceSlug } from "./repo-identity.js";
import { redactSecrets } from "./secret-detect.js";
import {
  findSkillOnDisk,
  isValidSkillName,
  listIndexedSkills,
  parseFrontmatter,
  readSkillBody,
  scanSkillContent,
  slugifySkillName,
  syncSkillIndex,
  writeSkill,
} from "./skills.js";

export type ImportClaim = {
  id?: string;
  text: string;
  kind?: string;
  anchors?: string[];
  status?: string;
  superseded_by?: string | null;
  expires_at?: string | null;
  pinned?: boolean;
};
export type ImportTask = { title: string; body?: string; status?: string; anchors?: string[] };
export type ImportSkill = { name: string; content: string };
export type ParsedImport = { claims: ImportClaim[]; tasks: ImportTask[]; skills: ImportSkill[] };

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[`*_>#]/g, "").replace(/\s+/g, " ").trim();
}

export function importClaimId(text: string): string {
  return `claim.import_${createHash("sha256").update(normalizeText(text)).digest("hex").slice(0, 12)}`;
}

function clip(text: string): string {
  const t = text.trim();
  return t.length > CLAIM_TEXT_MAX_CHARS ? `${t.slice(0, CLAIM_TEXT_MAX_CHARS - 1)}…` : t;
}

const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const CHECKBOX = /^\[( |x|X)\]\s+(.*)$/;

/**
 * Markdown and rules files → facts and tasks. Top-level bullets become facts (nested
 * bullets fold into their parent), paragraphs become facts, `- [ ]` items become tasks.
 * Each fact is prefixed with its section heading so it still reads on its own.
 */
export function parseMarkdownRules(raw: string, source: string): ParsedImport {
  const { body } = parseFrontmatter(raw);
  const anchor = basename(source) || "import";
  const claims: ImportClaim[] = [];
  const tasks: ImportTask[] = [];
  const headings: string[] = [];
  let current: { text: string; indent: number } | null = null;
  let paragraph: string[] = [];
  let inFence = false;
  // Our own Markdown export: facts are written verbatim, so re-importing must not prefix
  // them or keep the "(kind, pinned; anchors)" annotation, and history/skills are skipped.
  const amemExport = /^#\s+amem export\b/.test(body);

  const section = () => headings.filter(Boolean).slice(-2).join(" › ");
  const skipSection = () => amemExport && /^(History|Skills)\b/.test(headings[headings.length - 1] ?? "");
  const emit = (text: string) => {
    let t = text.replace(/\s+/g, " ").trim();
    if (skipSection() || (amemExport && t.startsWith(">"))) return;
    if (amemExport) t = t.replace(/\s+_\([^)]*\)_$/, "");
    if (t.length < 12) return;
    if (amemExport) {
      claims.push({ text: clip(t), anchors: [anchor] });
      return;
    }
    const sec = section();
    claims.push({ text: clip(sec ? `${sec}: ${t}` : t), anchors: [anchor] });
  };
  const flushBullet = () => {
    if (current) emit(current.text);
    current = null;
  };
  const flushParagraph = () => {
    // In our own export only bullets are memory; paragraphs are headers and dates.
    if (paragraph.length && !amemExport) emit(paragraph.join(" "));
    paragraph = [];
  };

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flushBullet();
      flushParagraph();
      const level = h[1]!.length;
      headings.length = Math.max(0, level - 1);
      headings[level - 1] = h[2]!.trim();
      continue;
    }
    if (!line.trim()) {
      flushBullet();
      flushParagraph();
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      flushParagraph();
      const indent = b[1]!.replace(/\t/g, "  ").length;
      const item = b[2]!.trim();
      const box = CHECKBOX.exec(item);
      if (box) {
        flushBullet();
        if (skipSection()) continue;
        tasks.push({ title: box[2]!.replace(/\s+_\(\w+\)_$/, "").trim().slice(0, 200), status: box[1] === " " ? (amemExport && /_\((\w+)\)_$/.test(box[2]!) ? /_\((\w+)\)_$/.exec(box[2]!)![1] : "backlog") : "done", body: `Imported from ${anchor}` });
        continue;
      }
      if (current && indent >= 2 && indent > current.indent) {
        current.text += `; ${item}`;
        continue;
      }
      flushBullet();
      current = { text: item, indent };
      continue;
    }
    if (current && /^\s{2,}\S/.test(line)) {
      current.text += ` ${line.trim()}`;
      continue;
    }
    flushBullet();
    paragraph.push(line.trim());
  }
  flushBullet();
  flushParagraph();
  return { claims, tasks, skills: [] };
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") {
    try {
      return asStringArray(JSON.parse(v));
    } catch {
      return v ? [v] : [];
    }
  }
  return [];
}

/** amem JSON exports (single repo or `--all`), or a plain array of strings / {text}. */
export function parseJsonImport(raw: string): ParsedImport {
  const data = JSON.parse(raw) as unknown;
  const out: ParsedImport = { claims: [], tasks: [], skills: [] };
  const take = (block: Record<string, unknown>) => {
    for (const c of (Array.isArray(block.claims) ? block.claims : []) as Array<Record<string, unknown>>) {
      if (typeof c?.text !== "string") continue;
      out.claims.push({
        id: typeof c.id === "string" ? c.id : undefined,
        text: clip(c.text),
        kind: typeof c.kind === "string" ? c.kind : undefined,
        anchors: asStringArray(c.code_anchors ?? c.anchors),
        status: typeof c.status === "string" ? c.status : undefined,
        superseded_by: typeof c.superseded_by === "string" ? c.superseded_by : null,
        expires_at: typeof c.expires_at === "string" ? c.expires_at : null,
        pinned: Number(c.pinned || 0) > 0,
      });
    }
    for (const t of (Array.isArray(block.tasks) ? block.tasks : []) as Array<Record<string, unknown>>) {
      if (typeof t?.title !== "string") continue;
      out.tasks.push({
        title: t.title,
        body: typeof t.body === "string" ? t.body : "",
        status: typeof t.status === "string" ? t.status : "backlog",
        anchors: asStringArray(t.anchors),
      });
    }
    for (const s of (Array.isArray(block.skills) ? block.skills : []) as Array<Record<string, unknown>>) {
      if (typeof s?.name === "string" && typeof s.content === "string") out.skills.push({ name: s.name, content: s.content });
    }
  };
  if (Array.isArray(data)) {
    for (const item of data) {
      const text = typeof item === "string" ? item : typeof (item as { text?: unknown })?.text === "string" ? (item as { text: string }).text : null;
      if (text) out.claims.push({ text: clip(text) });
    }
    return out;
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    take(obj);
    if (Array.isArray(obj.repos)) for (const r of obj.repos) if (r && typeof r === "object") take(r as Record<string, unknown>);
    if (Array.isArray(obj.facts)) for (const f of obj.facts) if (typeof f === "string") out.claims.push({ text: clip(f) });
  }
  return out;
}

export function parseImportFile(path: string, raw: string): ParsedImport {
  const ext = extname(path).toLowerCase();
  if (ext === ".json") return parseJsonImport(raw);
  if (basename(path) === "SKILL.md") {
    const { meta } = parseFrontmatter(raw);
    const name = typeof meta.name === "string" ? meta.name : basename(path.replace(/\/SKILL\.md$/, ""));
    return { claims: [], tasks: [], skills: [{ name, content: raw }] };
  }
  return parseMarkdownRules(raw, path);
}

export type ImportReport = {
  scope: string;
  workspace: string;
  dryRun: boolean;
  claims: { added: number; skipped: number };
  tasks: { added: number; skipped: number };
  skills: { added: number; skipped: number };
  errors: string[];
};

/**
 * Write parsed items into `repo`, skipping anything already there: a claim whose id or
 * normalized text exists (in any status, so a retired fact is not resurrected), a task
 * with the same title, a skill with the same name.
 */
export function importIntoRepo(repo: RepoRow, parsed: ParsedImport, opts: { dryRun?: boolean } = {}): ImportReport {
  const report: ImportReport = {
    scope: scopeOf(repo),
    workspace: parseWorkspaceSlug(repo.remote_url) ?? repo.repo_name,
    dryRun: Boolean(opts.dryRun),
    claims: { added: 0, skipped: 0 },
    tasks: { added: 0, skipped: 0 },
    skills: { added: 0, skipped: 0 },
    errors: [],
  };
  const existing = listClaims(repo.id, { includeSuperseded: true });
  const seenText = new Set(existing.map((c) => normalizeText(c.text)));
  const fresh: Array<ImportClaim & { id: string }> = [];
  for (const c of parsed.claims) {
    const text = redactSecrets(c.text);
    const id = c.id && /^[\w.:-]+$/.test(c.id) ? c.id : importClaimId(text);
    const norm = normalizeText(text);
    if (!norm || seenText.has(norm) || getClaim(repo.id, id) || fresh.some((f) => f.id === id)) {
      report.claims.skipped += 1;
      continue;
    }
    seenText.add(norm);
    fresh.push({ ...c, id, text });
  }

  const toProposal = (c: ImportClaim & { id: string }): ProposalClaim => ({
    id: c.id,
    kind: c.kind || inferClaimKind(c.text),
    text: c.text,
    code_anchors: c.anchors?.length ? c.anchors.slice(0, 8) : ["import"],
    source_ref: "amem:import",
  });

  if (!opts.dryRun && fresh.length) {
    let written: Array<ImportClaim & { id: string }> = [];
    try {
      applyProposal(repo.id, { claims: fresh.map(toProposal) });
      written = fresh;
    } catch {
      // One bad item (an anchor outside the repo, say) fails the batch: retry one by one.
      for (const c of fresh) {
        try {
          applyProposal(repo.id, { claims: [toProposal(c)] });
          written.push(c);
        } catch (e) {
          try {
            applyProposal(repo.id, { claims: [{ ...toProposal(c), code_anchors: ["import"] }] });
            written.push(c);
          } catch {
            report.errors.push(`${c.id}: ${e instanceof Error ? e.message.split("\n").pop() : String(e)}`);
          }
        }
      }
    }
    // Keep lineage, TTL and pins from an amem export.
    writeTx(() => {
      const db = openDb();
      for (const c of written) {
        if (c.status && c.status !== "active") {
          db.prepare(`UPDATE claims SET status = ?, superseded_by = ? WHERE repo_id = ? AND id = ?`).run(
            c.status,
            c.superseded_by ?? null,
            repo.id,
            c.id,
          );
        }
        if (c.pinned) db.prepare(`UPDATE claims SET pinned = 1 WHERE repo_id = ? AND id = ?`).run(repo.id, c.id);
      }
    });
    for (const c of written) if (c.expires_at) setClaimExpiry(repo.id, c.id, c.expires_at);
    report.claims.added = written.length;
  } else {
    report.claims.added = fresh.length;
  }

  const titles = new Set(listTasks(repo.id, { includeDone: true, limit: 200 }).map((t) => normalizeText(t.title)));
  for (const t of parsed.tasks) {
    const norm = normalizeText(t.title);
    if (!norm || titles.has(norm)) {
      report.tasks.skipped += 1;
      continue;
    }
    titles.add(norm);
    if (!opts.dryRun) {
      insertTask({
        repoId: repo.id,
        title: t.title,
        body: t.body,
        status: normalizeTaskStatus(t.status) ?? "backlog",
        anchors: t.anchors,
        source: "import",
      });
    }
    report.tasks.added += 1;
  }

  for (const s of parsed.skills) {
    const slug = slugifySkillName(s.name);
    if (!isValidSkillName(slug) || findSkillOnDisk(slug)) {
      report.skills.skipped += 1;
      continue;
    }
    const scan = scanSkillContent(s.content);
    if (!scan.ok) {
      report.errors.push(`skill ${slug}: ${scan.reason}`);
      continue;
    }
    if (!opts.dryRun) writeSkill(slug, s.content);
    report.skills.added += 1;
  }
  if (!opts.dryRun && report.skills.added) syncSkillIndex();
  return report;
}

export type ExportBlock = {
  scope: string;
  workspace: string;
  claims: ClaimRow[];
  tasks: AgentTaskRow[];
};

export function exportBlock(repo: RepoRow): ExportBlock {
  return {
    scope: scopeOf(repo),
    workspace: parseWorkspaceSlug(repo.remote_url) ?? repo.repo_name,
    claims: listClaims(repo.id, { includeSuperseded: true }),
    tasks: listTasks(repo.id, { includeDone: true, limit: 200 }),
  };
}

export function exportSkills(): ImportSkill[] {
  try {
    return listIndexedSkills()
      .filter((s) => s.source !== "bundled")
      .map((s) => ({ name: s.name, content: readSkillBody(s.name) ?? "" }))
      .filter((s) => s.content);
  } catch {
    return [];
  }
}

function anchorsOf(raw: string): string[] {
  return asStringArray(raw);
}

/** Human-readable Markdown export. Re-importable: facts are bullets, tasks checkboxes. */
export function renderExportMarkdown(blocks: ExportBlock[], skills: ImportSkill[] = []): string {
  const out: string[] = ["# amem export", "", `_Exported ${new Date().toISOString()}_`];
  for (const b of blocks) {
    out.push("", `## ${b.workspace} (${b.scope})`);
    const active = b.claims.filter((c) => (c.status ?? "active") === "active");
    const history = b.claims.filter((c) => (c.status ?? "active") !== "active");
    if (active.length) {
      out.push("", "### Facts", "");
      for (const c of active) {
        const extras = [c.kind, Number(c.pinned || 0) > 0 ? "pinned" : "", c.expires_at ? `expires ${c.expires_at.slice(0, 10)}` : ""]
          .filter(Boolean)
          .join(", ");
        const anchors = anchorsOf(c.code_anchors);
        out.push(`- ${c.text.replace(/\s*\n\s*/g, " ")} _(${extras}${anchors.length ? `; ${anchors.join(", ")}` : ""})_`);
      }
    }
    if (b.tasks.length) {
      out.push("", "### Tasks", "");
      for (const t of b.tasks) out.push(`- [${t.status === "done" ? "x" : " "}] ${t.title}${t.status !== "done" && t.status !== "backlog" ? ` _(${t.status})_` : ""}`);
    }
    if (history.length) {
      out.push("", "### History (superseded / expired)", "");
      for (const c of history) {
        out.push(`> ${c.status}${c.superseded_by ? ` → ${c.superseded_by}` : ""}: ${c.text.replace(/\s*\n\s*/g, " ")}`);
      }
    }
  }
  if (skills.length) {
    out.push("", "## Skills", "");
    for (const s of skills) {
      const { meta } = parseFrontmatter(s.content);
      out.push(`- **${s.name}** — ${typeof meta.description === "string" ? meta.description : ""}`);
    }
  }
  return `${out.join("\n")}\n`;
}
