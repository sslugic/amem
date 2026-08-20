import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeGitRepo, root } from "./helpers.mjs";

const cli = join(root, "dist", "cli.js");

function runAmem(args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  delete env.AMEM_PASSPHRASE;
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: opts.cwd || process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    input: opts.input,
  });
}

describe("CLI end-to-end", () => {
  it("setup, status, remember, context, backup, lock/unlock", () => {
    const home = mkdtempSync(join(tmpdir(), "amem-cli-home-"));
    const repoDir = makeGitRepo();
    try {
      const env = { AMEM_HOME: home, HOME: home };
      const setup = runAmem(["setup", "--personal"], { env, cwd: repoDir });
      assert.match(setup, /Personal prefs|Memory DB/i);

      const status = runAmem(["status"], { env, cwd: repoDir });
      assert.match(status, /amem home/i);
      assert.match(status, /encrypted:\s*no/);

      // bind repo
      runAmem(["init", "--platform", "cursor"], { env, cwd: repoDir });

      const remembered = runAmem(
        ["remember", "API boot must initialize auth first", "--kind", "constraint", "--anchor", "src/api.ts"],
        { env, cwd: repoDir },
      );
      assert.match(remembered, /Remembered/);

      const ctx = runAmem(["context", "API boot auth"], { env, cwd: repoDir });
      assert.match(ctx, /Agent Memory Context|API boot/i);
      assert.match(ctx, /Why:/);

      const backup = runAmem(["backup", "--out", join(home, "bk"), "--passphrase", "cli-secret"], {
        env,
        cwd: repoDir,
      });
      assert.match(backup, /Backup written/);
      assert.match(backup, /Encrypted: yes/);

      runAmem(["lock", "--passphrase", "cli-secret"], { env, cwd: repoDir });
      let lockedStatus;
      try {
        lockedStatus = runAmem(["status"], { env, cwd: repoDir });
      } catch (err) {
        lockedStatus = String(err.stderr || err.stdout || err);
      }
      assert.match(lockedStatus, /encrypted|Passphrase|unlock/i);

      runAmem(["unlock", "--passphrase", "cli-secret"], { env, cwd: repoDir });
      const after = runAmem(["status"], { env, cwd: repoDir });
      assert.match(after, /encrypted:\s*(no|unlocked)/i);

      const doctor = runAmem(["doctor"], { env, cwd: repoDir });
      assert.match(doctor, /amem doctor/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("propose validate/diff/apply and wipe", () => {
    const home = mkdtempSync(join(tmpdir(), "amem-cli-home-"));
    const repoDir = makeGitRepo();
    try {
      const env = { AMEM_HOME: home };
      runAmem(["init", "--platform", "cursor"], { env, cwd: repoDir });
      const proposalPath = join(home, "p.json");
      writeFileSync(
        proposalPath,
        JSON.stringify({
          claims: [
            {
              id: "claim.cli_entry",
              kind: "structure",
              text: "CLI entrypoint documentation lives near src/api.ts",
              code_anchors: ["src/api.ts"],
            },
          ],
          components: [{ id: "component.api", name: "API", code_anchor: "src/api.ts" }],
          flows: [{ id: "flow.cli", name: "CLI" }],
          edges: [
            {
              from_id: "claim.cli_entry",
              from_type: "claim",
              to_id: "flow.cli",
              to_type: "flow",
              kind: "mentions",
            },
          ],
        }),
        "utf8",
      );

      const validated = runAmem(["propose", "validate", proposalPath], { env, cwd: repoDir });
      assert.match(validated, /valid|Diff/i);

      const diff = runAmem(["propose", "diff", proposalPath], { env, cwd: repoDir });
      assert.match(diff, /add claims|Diff/i);

      const applied = runAmem(["propose", "apply", proposalPath], { env, cwd: repoDir });
      assert.match(applied, /Applied:/);

      const wiped = runAmem(["wipe", "--yes"], { env, cwd: repoDir });
      assert.match(wiped, /Wiped/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("zero-arg prints quick start", () => {
    const home = mkdtempSync(join(tmpdir(), "amem-cli-home-"));
    try {
      const out = runAmem([], { env: { AMEM_HOME: home } });
      assert.match(out, /amem setup|Quick start/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
