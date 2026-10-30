import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "../scripts/adoption-report.mjs";

test("adoption summary keeps release days out of the typical-day average", () => {
  const daily = [
    { day: "2026-10-23", downloads: 1241 },
    { day: "2026-10-24", downloads: 82 },
    { day: "2026-10-25", downloads: 32 },
    { day: "2026-10-26", downloads: 357 },
    { day: "2026-10-27", downloads: 87 },
    { day: "2026-10-28", downloads: 23 },
    { day: "2026-10-29", downloads: 52 },
  ];
  const s = summarize(daily, new Set(["2026-10-23", "2026-10-26"]), new Date("2026-10-30T12:00:00Z"));
  assert.equal(s.weekTotal, 1874);
  assert.equal(s.weekReleaseDays, 2);
  assert.equal(s.weekQuietAvg, 55);
  assert.equal(s.periodQuietAvg, 55);
});
