#!/usr/bin/env node
// Retrieval benchmark: a fixed memory set and labeled questions (bench/retrieval.json).
// Measures what the agent actually receives: the prompt hook (strict) and amem_context
// (loose). Runs in a throwaway AMEM_HOME, so it never touches real memory.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Windows needs file:// URLs for import(); a bare D:\ path is read as a URL scheme.
const dist = (name) => pathToFileURL(join(root, "dist", name)).href;

export async function runBench(file = join(root, "bench", "retrieval.json")) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const home = mkdtempSync(join(tmpdir(), "amem-bench-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "amem-bench-repo-"));
  const prevHome = process.env.AMEM_HOME;
  process.env.AMEM_HOME = home;
  try {
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    for (const m of data.memories) {
      for (const a of m.anchors) {
        const full = join(repoDir, a);
        if (a.endsWith("/")) mkdirSync(full, { recursive: true });
        else {
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, "// fixture\n");
        }
      }
    }
    const { closeDb, upsertRepo } = await import(dist("db.js"));
    closeDb();
    const { detectRepoIdentity } = await import(dist("repo-identity.js"));
    const { applyProposal } = await import(dist("proposal.js"));
    const { buildContext } = await import(dist("context.js"));
    const repo = upsertRepo(detectRepoIdentity(repoDir), "claude");
    applyProposal(repo.id, {
      claims: data.memories.map((m) => ({ id: m.id, kind: m.kind, text: m.text, code_anchors: m.anchors })),
    });

    const score = (strict) => {
      const specific = data.queries.filter((q) => q.expect.length > 0);
      const vague = data.queries.filter((q) => q.expect.length === 0);
      let hit1 = 0;
      let hit3 = 0;
      let empty = 0;
      const misses = [];
      for (const q of specific) {
        const ids = buildContext(repo.id, q.q, { rootPath: repoDir, strict, includeSkills: false }).claims.map((c) => c.id);
        if (ids.length === 0) empty += 1;
        if (q.expect.includes(ids[0])) hit1 += 1;
        if (ids.slice(0, 3).some((id) => q.expect.includes(id))) hit3 += 1;
        else misses.push({ q: q.q, got: ids.slice(0, 3) });
      }
      const falseInjections = vague.filter(
        (q) => buildContext(repo.id, q.q, { rootPath: repoDir, strict, includeSkills: false }).claims.length > 0,
      ).length;
      return {
        specific: specific.length,
        vague: vague.length,
        hitAt1: hit1 / specific.length,
        recallAt3: hit3 / specific.length,
        emptyOnSpecific: empty / specific.length,
        falseInjectionRate: vague.length ? falseInjections / vague.length : 0,
        misses,
      };
    };
    const result = { memories: data.memories.length, prompt: score(true), context: score(false) };
    closeDb();
    return result;
  } finally {
    if (prevHome === undefined) delete process.env.AMEM_HOME;
    else process.env.AMEM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
}

const pct = (n) => `${Math.round(n * 100)}%`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await runBench();
  console.log(`Retrieval benchmark: ${r.memories} memories, ${r.prompt.specific} topic questions, ${r.prompt.vague} vague prompts\n`);
  console.log("| Path | Right memory first | Right memory in top 3 | Vague prompts given memory |");
  console.log("|---|---|---|---|");
  console.log(`| Prompt hook (automatic) | ${pct(r.prompt.hitAt1)} | ${pct(r.prompt.recallAt3)} | ${pct(r.prompt.falseInjectionRate)} |`);
  console.log(`| amem_context (agent asks) | ${pct(r.context.hitAt1)} | ${pct(r.context.recallAt3)} | n/a (always answers) |`);
  if (process.argv.includes("--misses")) {
    for (const [name, s] of [["prompt", r.prompt], ["context", r.context]]) {
      for (const m of s.misses) console.log(`miss (${name}): ${m.q} -> ${m.got.join(", ") || "(nothing)"}`);
    }
  }
}
