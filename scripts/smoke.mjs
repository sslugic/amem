#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const cli = join(root, "dist", "cli.js");
const amemHome = mkdtempSync(join(tmpdir(), "amem-smoke-home-"));
const repoDir = mkdtempSync(join(tmpdir(), "amem-smoke-repo-"));

function run(args, cwd = repoDir) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      AMEM_HOME: amemHome,
      CURSOR_HOME: join(amemHome, "cursor-home"),
      CLAUDE_HOME: join(amemHome, "claude-home"),
    },
  });
}

try {
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  writeFileSync(join(repoDir, "README.md"), "# smoke\n");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "api.ts"), "export const api = true;\n");

  console.log(run(["init", "--platform", "cursor"]));
  console.log(run(["status"]));

  const proposal = {
    components: [{ id: "component.api", name: "API", code_anchor: "src/api.ts" }],
    flows: [{ id: "flow.boot", name: "Boot" }],
    claims: [
      {
        id: "claim.api_entry",
        kind: "structure",
        text: "API entrypoint lives in src/api.ts",
        code_anchors: ["src/api.ts"],
      },
      {
        id: "claim.boot_order",
        kind: "constraint",
        text: "Boot flow initializes API before serving requests",
        code_anchors: ["src/api.ts"],
      },
    ],
    edges: [
      {
        from_id: "claim.api_entry",
        from_type: "claim",
        to_id: "flow.boot",
        to_type: "flow",
        kind: "about",
      },
      {
        from_id: "flow.boot",
        from_type: "flow",
        to_id: "component.api",
        to_type: "component",
        kind: "uses",
      },
    ],
  };
  const proposalPath = join(amemHome, "proposal.json");
  writeFileSync(proposalPath, JSON.stringify(proposal, null, 2));

  console.log(run(["propose", "validate", proposalPath]));
  console.log(run(["propose", "apply", proposalPath]));
  const context = run(["context", "api boot", "--platform", "cursor"]);
  console.log(context);

  if (!context.includes("claim.api_entry") || !context.includes("flow.boot")) {
    throw new Error("context packet missing expected claims/flows");
  }
  if (!context.includes("Usage logged")) {
    throw new Error("context did not log usage event");
  }

  console.log(run(["doctor"]));

  // Exercise API layer used by UI
  const { handleApi } = await import(join(root, "dist", "api", "routes.js"));
  process.chdir(repoDir);
  process.env.AMEM_HOME = amemHome;

  const graph = handleApi({
    method: "GET",
    pathname: "/api/graph",
    searchParams: new URLSearchParams("days=30"),
    body: null,
    cwd: repoDir,
  });
  if (graph.status !== 200 || !graph.body.claims?.length) {
    throw new Error("api/graph failed");
  }

  const usage = handleApi({
    method: "GET",
    pathname: "/api/usage",
    searchParams: new URLSearchParams("repo=current&days=30"),
    body: null,
    cwd: repoDir,
  });
  if (usage.status !== 200 || !usage.body.events?.length) {
    throw new Error("api/usage missing events");
  }
  if (!(usage.body.aggregate.totals.estimatedTokensSaved > 0)) {
    throw new Error("expected estimated token savings");
  }

  const status = handleApi({
    method: "GET",
    pathname: "/api/status",
    searchParams: new URLSearchParams(),
    body: null,
    cwd: repoDir,
  });
  if (status.status !== 200 || !status.body.repo) {
    throw new Error("api/status failed");
  }

  // Static UI present
  const { existsSync } = await import("node:fs");
  if (!existsSync(join(root, "ui-static", "index.html"))) {
    throw new Error("ui-static missing");
  }

  console.log("SMOKE OK");
} finally {
  rmSync(amemHome, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
}
