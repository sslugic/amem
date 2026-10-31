#!/usr/bin/env node
/**
 * Anonymous install ping for @iamem/amem (package version, Node, OS/arch only).
 * Opt-in, like the daily usage ping: sent only when `telemetry = true` in
 * ~/.amem/policy.toml (`amem telemetry on`), so a fresh install sends nothing.
 * Also skipped with AMEM_TELEMETRY_DISABLED / DO_NOT_TRACK, in CI / NODE_ENV=test, and
 * under a managed policy. Never throws; always exits 0 so install is never blocked.
 */
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_URL = "https://getamem.com/api/beacon/npm-install";

function done() {
  process.exit(0);
}

const truthy = (v) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

async function main() {
  if (
    truthy(process.env.AMEM_TELEMETRY_DISABLED) ||
    truthy(process.env.DO_NOT_TRACK) ||
    truthy(process.env.CI) ||
    process.env.NODE_ENV === "test"
  ) {
    return done();
  }

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  // The same switch as the daily ping. No built policy module means no opt-in to read: stay quiet.
  const policyModule = join(root, "dist", "policy.js");
  if (!existsSync(policyModule)) return done();
  const { telemetryEnabled } = await import(pathToFileURL(policyModule).href);
  if (!telemetryEnabled()) return done();

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

  const url = new URL(process.env.AMEM_INSTALL_PING_URL || DEFAULT_URL);
  const req = (url.protocol === "http:" ? http : https).request(
    url,
    {
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
}

main().catch(() => done());
