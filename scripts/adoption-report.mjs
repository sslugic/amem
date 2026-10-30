#!/usr/bin/env node
// Weekly adoption snapshot. npm counts every mirror and scanner that fetches a
// fresh version, so days with a publish are reported separately and the
// "organic" average uses only the days without one.
const PKG = "@iamem/amem";
const REPO = process.env.GITHUB_REPOSITORY || "sslugic/amem";
const DAYS = 28;

async function json(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

export function summarize(daily, releaseDays, today = new Date()) {
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() - 1);
  const start7 = new Date(end);
  start7.setUTCDate(start7.getUTCDate() - 6);
  const week = daily.filter((d) => d.day >= isoDay(start7) && d.day <= isoDay(end));
  const quiet = (rows) => rows.filter((d) => !releaseDays.has(d.day));
  const sum = (rows) => rows.reduce((n, d) => n + d.downloads, 0);
  const avg = (rows) => (rows.length ? Math.round(sum(rows) / rows.length) : 0);
  return {
    weekTotal: sum(week),
    weekQuietAvg: avg(quiet(week)),
    weekReleaseDays: week.filter((d) => releaseDays.has(d.day)).length,
    periodQuietAvg: avg(quiet(daily)),
  };
}

async function main() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (DAYS - 1));
  const range = await json(
    `https://api.npmjs.org/downloads/range/${isoDay(start)}:${isoDay(end)}/${PKG}`,
  );
  const meta = await json(`https://registry.npmjs.org/${encodeURIComponent(PKG)}`);
  const releaseDays = new Set(
    Object.entries(meta.time || {})
      .filter(([k]) => k !== "created" && k !== "modified")
      .map(([, t]) => String(t).slice(0, 10)),
  );
  const gh = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const repo = await json(`https://api.github.com/repos/${REPO}`, gh);
  const s = summarize(range.downloads, releaseDays);

  const lines = [
    `**Adoption, week ending ${isoDay(end)}**`,
    "",
    `- npm downloads (7 days): ${s.weekTotal}${s.weekReleaseDays ? ` (${s.weekReleaseDays} release day${s.weekReleaseDays > 1 ? "s" : ""} included)` : ""}`,
    `- Typical day without a release: ${s.weekQuietAvg} this week, ${s.periodQuietAvg} over ${DAYS} days`,
    `- GitHub: ${repo.stargazers_count} stars, ${repo.forks_count} forks, ${repo.open_issues_count} open issues/PRs`,
    `- Latest version: ${meta["dist-tags"]?.latest}`,
    "",
    "_Release days are inflated by registry mirrors and scanners; the no-release average is the better signal._",
  ];
  console.log(lines.join("\n"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
