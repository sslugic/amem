#!/usr/bin/env node
/**
 * Smoke-test an unpacked desktop build: run amem with the app's own runtime, the way the
 * ~/.amem/bin/amem launcher does, and make it write and read memory. Proves the bundled
 * CLI, its dependencies and the SQLite build for this platform all load.
 *
 *   node scripts/smoke.mjs        (after: node scripts/dist.mjs <target> --dir)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const release = join(dirname(fileURLToPath(import.meta.url)), "..", "release");
const candidates = [];
for (const dir of existsSync(release) ? readdirSync(release) : []) {
  const base = join(release, dir);
  candidates.push(
    { exe: join(base, "amem.app", "Contents", "MacOS", "amem"), res: join(base, "amem.app", "Contents", "Resources") },
    { exe: join(base, "amem.exe"), res: join(base, "resources") },
    { exe: join(base, "amem-app"), res: join(base, "resources") },
  );
}
const app = candidates.find((c) => existsSync(c.exe));
if (!app) {
  console.error(`No unpacked app under ${release}. Build one with: node scripts/dist.mjs <target> --dir`);
  process.exit(1);
}
const cli = join(app.res, "amem", "dist", "cli.js");
const home = mkdtempSync(join(tmpdir(), "amem-smoke-"));
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", AMEM_HOME: home, AMEM_TELEMETRY_DISABLED: "1" };
const amem = (...args) => execFileSync(app.exe, [cli, ...args], { env, encoding: "utf8", cwd: home });

amem("init", "--workspace", "smoke");
amem("remember", "The packaged app runs amem with its own runtime and SQLite works", "--workspace", "smoke", "--kind", "constraint");
const out = amem("context", "packaged runtime SQLite", "--workspace", "smoke");
if (!/packaged app runs amem/.test(out)) {
  console.error(out);
  throw new Error("The packaged app could not read back what it stored.");
}
console.log(`Smoke test passed: ${app.exe}`);
