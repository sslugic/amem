import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAmemHome } from "./helpers.mjs";

/** A git repo whose folder (and so its amem name) is exactly `name`. */
function namedGitRepo(parent, name) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  return dir;
}

async function setup(parent) {
  const { upsertRepo } = await import("../dist/db.js");
  const { detectRepoIdentity } = await import("../dist/repo-identity.js");
  const { applyProposal } = await import("../dist/proposal.js");
  const { ensurePersonalWorkspace } = await import("../dist/personal.js");
  const { buildContext } = await import("../dist/context.js");

  const shop = upsertRepo(detectRepoIdentity(namedGitRepo(parent, "shopfront")), "claude");
  const widgetry = upsertRepo(detectRepoIdentity(namedGitRepo(parent, "widgetry")), "claude");
  const docs = upsertRepo(detectRepoIdentity(namedGitRepo(parent, "docs")), "claude");
  const personal = ensurePersonalWorkspace("app");

  applyProposal(shop.id, {
    claims: [
      { id: "claim.shop_checkout", kind: "fact", text: "Checkout totals are computed server-side in the cart service, never in the browser.", code_anchors: ["shopfront"] },
      { id: "claim.shop_ci", kind: "fact", text: "The nightly CI job runs the payment smoke tests against the staging cart service.", code_anchors: ["shopfront"] },
    ],
  });
  applyProposal(widgetry.id, {
    claims: [
      { id: "claim.widgetry_release", kind: "worklog", text: "2026-10-30 worklog (done): released version 2.1 with the new layout engine and retry queue.", code_anchors: ["release"] },
      { id: "claim.widgetry_queue", kind: "fact", text: "The retry queue is persisted in SQLite so a crash never drops pending jobs.", code_anchors: ["queue"] },
    ],
  });
  applyProposal(docs.id, {
    claims: [{ id: "claim.docs_style", kind: "fact", text: "Guides use sentence case headings and second person throughout.", code_anchors: ["style"] }],
  });
  applyProposal(personal.id, {
    claims: [{ id: "claim.personal_widgetry", kind: "fact", text: "Widgetry release steps: open a version PR, wait for green CI, then push the tag yourself.", code_anchors: ["widgetry"] }],
  });

  const ask = (query) =>
    buildContext(shop.id, query, { limit: 8, strict: true, rootPath: shop.root_path, includeSkills: false }).claims;
  return { ask };
}

describe("context for a repo the question names", () => {
  it("answers 'how would you rate widgetry' from another repo with widgetry's own memories", async () => {
    const parent = mkdtempSync(join(tmpdir(), "amem-named-"));
    try {
      await withAmemHome(async () => {
        const { ask } = await setup(parent);
        const claims = ask("how would you rate widgetry now");
        const ids = claims.map((c) => c.id);
        assert.ok(ids.includes("claim.widgetry_release"), `got ${ids.join(", ")}`);
        assert.ok(ids.includes("claim.widgetry_queue"), `got ${ids.join(", ")}`);
        assert.ok(claims.find((c) => c.id === "claim.widgetry_release").reasons.includes("repo:widgetry"));
        // The personal note names widgetry; this repo never says the word, which used to drop it.
        assert.ok(ids.includes("claim.personal_widgetry"), `got ${ids.join(", ")}`);
        assert.ok(!ids.includes("claim.shop_checkout"));
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("ranks the named repo's memories by the rest of the question", async () => {
    const parent = mkdtempSync(join(tmpdir(), "amem-named-"));
    try {
      await withAmemHome(async () => {
        const { ask } = await setup(parent);
        const ids = ask("does widgetry persist the retry queue").map((c) => c.id);
        assert.equal(ids[0], "claim.widgetry_queue", `got ${ids.join(", ")}`);
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("leaves questions that name no other repo, or a generic name, unchanged", async () => {
    const parent = mkdtempSync(join(tmpdir(), "amem-named-"));
    try {
      await withAmemHome(async () => {
        const { ask } = await setup(parent);
        const own = ask("where are checkout totals computed").map((c) => c.id);
        assert.deepEqual(own, ["claim.shop_checkout"]);
        const generic = ask("update the docs for the cart service").map((c) => c.id);
        assert.ok(!generic.includes("claim.docs_style"), `got ${generic.join(", ")}`);
        assert.deepEqual(ask("ok lets do that"), []);
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
