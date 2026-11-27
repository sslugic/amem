#!/usr/bin/env node
/** The app's version is amem's version: the app ships that exact CLI, and updates follow npm releases. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(desktop, "..", "package.json"), "utf8")).version;
const path = join(desktop, "package.json");
const pkg = JSON.parse(readFileSync(path, "utf8"));
if (pkg.version !== version) {
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}
console.log(`amem desktop ${version}`);
