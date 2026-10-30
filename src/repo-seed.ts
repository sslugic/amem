import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listClaims, type RepoRow } from "./db.js";
import { applyProposal, type ProposalClaim } from "./proposal.js";

/**
 * Day-one memory. A freshly bound repo has nothing stored, so the first "how do I run
 * the tests?" gets no help. These facts come straight from the repo's own manifests
 * (no model, no guessing) and carry those files as anchors, so freshness marks them
 * stale when the manifest changes. The agent replaces them with better ones over time.
 */
const SOURCE = "amem:repo-seed";

function read(root: string, file: string): string | null {
  const path = join(root, file);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function nodeRunner(root: string): string {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  return "npm";
}

const SCRIPT_ORDER = ["test", "build", "dev", "start", "lint", "typecheck", "format"];

function nodeFacts(root: string): ProposalClaim[] {
  const raw = read(root, "package.json");
  if (!raw) return [];
  let pkg: { name?: string; scripts?: Record<string, string>; workspaces?: unknown };
  try {
    pkg = JSON.parse(raw);
  } catch {
    return [];
  }
  const runner = nodeRunner(root);
  const run = (name: string) => (runner === "npm" && name !== "test" && name !== "start" ? `npm run ${name}` : `${runner} ${name}`);
  const scripts = pkg.scripts ?? {};
  const names = Object.keys(scripts)
    .sort((a, b) => {
      const ia = SCRIPT_ORDER.indexOf(a);
      const ib = SCRIPT_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .slice(0, 8);
  const facts: ProposalClaim[] = [];
  if (names.length > 0) {
    const lines = names.map((n) => `${run(n)} (${scripts[n]!.slice(0, 80)})`);
    facts.push({
      id: "claim.seed_node_scripts",
      kind: "howto",
      text: `How to build and test ${pkg.name ?? "this repo"} (from package.json, uses ${runner}): ${lines.join("; ")}.`,
      code_anchors: ["package.json"],
    });
  }
  if (pkg.workspaces) {
    facts.push({
      id: "claim.seed_node_workspaces",
      kind: "structure",
      text: `This is a monorepo: package.json declares workspaces ${JSON.stringify(pkg.workspaces).slice(0, 160)}.`,
      code_anchors: ["package.json"],
    });
  }
  return facts;
}

function makeFacts(root: string): ProposalClaim[] {
  const raw = read(root, "Makefile");
  if (!raw) return [];
  const targets = [...raw.matchAll(/^([A-Za-z0-9][\w.-]*):(?!=)/gm)].map((m) => m[1]!).filter((t) => t !== "PHONY");
  const unique = [...new Set(targets)].slice(0, 10);
  if (unique.length === 0) return [];
  return [
    {
      id: "claim.seed_make_targets",
      kind: "howto",
      text: `Makefile targets: ${unique.map((t) => `make ${t}`).join(", ")}.`,
      code_anchors: ["Makefile"],
    },
  ];
}

function otherToolchains(root: string): ProposalClaim[] {
  const facts: ProposalClaim[] = [];
  const py = read(root, "pyproject.toml");
  if (py) {
    const tool = /\[tool\.poetry\]/.test(py) ? "poetry run " : /\[tool\.uv\]|uv\.lock/.test(py) || existsSync(join(root, "uv.lock")) ? "uv run " : "";
    const tests = /pytest/.test(py) || existsSync(join(root, "pytest.ini")) ? `${tool}pytest` : null;
    facts.push({
      id: "claim.seed_python",
      kind: "howto",
      text: `Python project (pyproject.toml${tool ? `, ${tool.trim().split(" ")[0]}` : ""}).${tests ? ` Run tests with: ${tests}.` : ""}`,
      code_anchors: ["pyproject.toml"],
    });
  }
  if (read(root, "Cargo.toml") !== null) {
    facts.push({
      id: "claim.seed_rust",
      kind: "howto",
      text: "Rust project: build with cargo build, test with cargo test, lint with cargo clippy.",
      code_anchors: ["Cargo.toml"],
    });
  }
  if (read(root, "go.mod") !== null) {
    facts.push({
      id: "claim.seed_go",
      kind: "howto",
      text: "Go module: build with go build ./..., test with go test ./..., vet with go vet ./....",
      code_anchors: ["go.mod"],
    });
  }
  return facts;
}

function ciFacts(root: string): ProposalClaim[] {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch {
    return [];
  }
  if (files.length === 0) return [];
  const described = files.slice(0, 8).map((f) => {
    const name = /^name:\s*["']?(.+?)["']?\s*$/m.exec(read(root, join(".github", "workflows", f)) ?? "")?.[1];
    return name ? `${f} ("${name}")` : f;
  });
  return [
    {
      id: "claim.seed_ci",
      kind: "structure",
      text: `CI runs on GitHub Actions: ${described.join(", ")} in .github/workflows.`,
      code_anchors: files.slice(0, 8).map((f) => `.github/workflows/${f}`),
    },
  ];
}

export function repoSeedFacts(root: string): ProposalClaim[] {
  return [...nodeFacts(root), ...makeFacts(root), ...otherToolchains(root), ...ciFacts(root)].map((c) => ({
    ...c,
    source_ref: SOURCE,
  }));
}

/** Seed a repo that has no memories yet. Returns how many facts were stored. */
export function seedRepoIfEmpty(repo: Pick<RepoRow, "id" | "root_path">): number {
  if (!repo.root_path || !existsSync(repo.root_path)) return 0;
  if (listClaims(repo.id, { includeSuperseded: true }).length > 0) return 0;
  const claims = repoSeedFacts(repo.root_path);
  if (claims.length === 0) return 0;
  try {
    return applyProposal(repo.id, { claims }).claims;
  } catch {
    return 0;
  }
}
