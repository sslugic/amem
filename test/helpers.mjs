import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Fresh AMEM_HOME + close any prior DB cache. Call before importing/using db. */
export async function withAmemHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "amem-test-home-"));
  const prev = process.env.AMEM_HOME;
  const prevPub = process.env.AMEM_LICENSE_PUBKEY;
  process.env.AMEM_HOME = home;
  const { closeDb } = await import("../dist/db.js");
  closeDb();
  try {
    return await fn(home);
  } finally {
    closeDb();
    if (prev === undefined) delete process.env.AMEM_HOME;
    else process.env.AMEM_HOME = prev;
    if (prevPub === undefined) delete process.env.AMEM_LICENSE_PUBKEY;
    else process.env.AMEM_LICENSE_PUBKEY = prevPub;
    rmSync(home, { recursive: true, force: true });
  }
}

/** Install a vendor-style signed Pro/IT license for tests (ephemeral keypair). */
export async function installTestLicense(tier = "pro") {
  const { generateLicenseKeys, signLicense, applyLicenseJson } = await import("../dist/license.js");
  const keys = generateLicenseKeys();
  process.env.AMEM_LICENSE_PUBKEY = keys.publicKeyHex;
  const file = signLicense(keys.privateKeyHex, {
    tier,
    subject: "test",
    issued_at: new Date().toISOString(),
  });
  const status = applyLicenseJson(file);
  return { status, keys, file };
}

export function makeGitRepo(prefix = "amem-test-repo-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "api.ts"), "export const api = true;\n");
  writeFileSync(join(dir, "src", "auth.ts"), "export const auth = true;\n");
  return dir;
}

export function touchFuture(path, msAhead = 120_000) {
  const t = new Date(Date.now() + msAhead);
  utimesSync(path, t, t);
}

export function claimFixture(overrides = {}) {
  return {
    repo_id: "repo_x",
    id: "claim.demo",
    kind: "constraint",
    text: "Demo claim text about API boot",
    code_anchors: JSON.stringify(["src/api.ts"]),
    source_ref: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "active",
    superseded_by: null,
    pinned: 0,
    ...overrides,
  };
}

export { root, join };
