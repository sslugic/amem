import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("backup schedule hour", () => {
  it("reads the hour back from launchd and systemd schedules", async () => {
    const { parseScheduleHour } = await import("../dist/backup-schedule.js");
    assert.equal(parseScheduleHour("<key>Hour</key>\n    <integer>3</integer>\n    <key>Minute</key>"), 3);
    assert.equal(parseScheduleHour("[Timer]\nOnCalendar=*-*-* 22:15:00\nPersistent=true"), 22);
    assert.equal(parseScheduleHour("no schedule here"), null);
    assert.equal(parseScheduleHour("<key>Hour</key><integer>99</integer>"), null);
  });

  it("vault status reports the scheduled hour field", async () => {
    const { vaultStatus } = await import("../dist/vault.js");
    const status = vaultStatus();
    assert.ok("scheduledHour" in status.backup);
  });
});

describe("backup panel markup", () => {
  it("has the three cards and no alert-only actions", () => {
    const html = readFileSync(new URL("../ui-static/index.html", import.meta.url), "utf8");
    for (const id of ["vaultBackupBtn", "vaultScheduleBtn", "vaultUnscheduleBtn", "vaultLockBtn", "vaultUnlockBtn", "vaultRestorePick", "vaultRestoreConfirm", "vaultStatusMsg"]) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    const js = readFileSync(new URL("../ui-static/app.js", import.meta.url), "utf8");
    const vaultBlock = js.slice(js.indexOf("async function vaultAction("), js.indexOf("function emptyGraph("));
    assert.doesNotMatch(vaultBlock, /alert\(/, "vault actions report inline, not via alert()");
  });
});
