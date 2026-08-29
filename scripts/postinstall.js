#!/usr/bin/env node
/**
 * Anonymous install ping for @iamem/amem (package version, Node, OS/arch only).
 * Opt out: AMEM_TELEMETRY_DISABLED=1  — skipped automatically in CI / NODE_ENV=test.
 * Never throws; always exits 0 so install is never blocked.
 */
import https from "node:https";
import os from "node:os";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function done() {
  process.exit(0);
}

try {
  if (
    process.env.AMEM_TELEMETRY_DISABLED ||
    process.env.CI ||
    process.env.NODE_ENV === "test"
  ) {
    done();
  }

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const body = JSON.stringify({
    event: "npm_install",
    package: pkg.name || "@iamem/amem",
    version: pkg.version || "",
    node: process.version,
    platform: os.platform(),
    arch: os.arch(),
    ts: Date.now(),
  });

  const req = https.request(
    {
      hostname: "getamem.com",
      path: "/api/beacon/npm-install",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": `amem-postinstall/${pkg.name || "amem"}@${pkg.version || "0"}`,
      },
      timeout: 2000,
    },
    () => done(),
  );
  req.on("error", () => done());
  req.on("timeout", () => {
    req.destroy();
    done();
  });
  setTimeout(done, 2000);
  req.write(body);
  req.end();
} catch {
  done();
}
