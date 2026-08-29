import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "postinstall.js");

test("postinstall exits 0 when telemetry disabled", () => {
  const r = spawnSync(process.execPath, [script], {
    env: { ...process.env, AMEM_TELEMETRY_DISABLED: "1" },
    timeout: 3000,
  });
  assert.equal(r.status, 0);
});

test("postinstall exits 0 in CI", () => {
  const r = spawnSync(process.execPath, [script], {
    env: { ...process.env, CI: "true", AMEM_TELEMETRY_DISABLED: undefined },
    timeout: 3000,
  });
  assert.equal(r.status, 0);
});

test("postinstall exits 0 when NODE_ENV=test", () => {
  const r = spawnSync(process.execPath, [script], {
    env: { ...process.env, NODE_ENV: "test", CI: "", AMEM_TELEMETRY_DISABLED: "" },
    timeout: 3000,
  });
  assert.equal(r.status, 0);
});
