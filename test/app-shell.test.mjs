import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  desktopDir,
  electronInstallHint,
  resolveElectronBinary,
} from "../dist/app-shell.js";

test("desktopDir points at package desktop/", () => {
  const dir = desktopDir();
  assert.match(dir, /desktop$/);
});

test("resolveElectronBinary returns null when electron is not installed", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-desktop-"));
  const desktop = join(root, "desktop");
  mkdirSync(desktop);
  writeFileSync(
    join(desktop, "package.json"),
    JSON.stringify({ name: "amem-desktop-test", private: true, type: "module" }),
  );
  assert.equal(resolveElectronBinary(desktop), null);
  assert.match(electronInstallHint(desktop), /npm install --prefix/);
});
