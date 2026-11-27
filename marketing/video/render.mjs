#!/usr/bin/env node
/**
 * Render index.html to the landing-page video: frame by frame at 30 fps in headless Chromium
 * (render(t) sets each frame exactly, so nothing depends on timing), piped into ffmpeg.
 *
 *   cd marketing/video && npm i --no-save playwright@1.65.1 && node render.mjs
 *
 * Writes amem-explainer.mp4 (H.264), amem-explainer.webm (VP9) and amem-explainer.jpg
 * (poster) into shop/public, where getamem.com serves them.
 * Options: --from 12 --to 20 renders part of it, --out <dir> writes elsewhere.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const FPS = 30;
const from = Number(arg("from", 0));
const out = resolve(arg("out", join(here, "..", "..", "shop", "public")));
mkdirSync(out, { recursive: true });

// AMEM_CHROMIUM points at an existing Chromium/Chrome when the Playwright browser isn't installed.
const browser = await chromium.launch(process.env.AMEM_CHROMIUM ? { executablePath: process.env.AMEM_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(`${pathToFileURL(join(here, "index.html")).href}?capture=1`);
await page.evaluate(() => document.fonts.ready);
const duration = Number(arg("to", await page.evaluate(() => window.DURATION)));
const stage = page.locator("#stage");

const mp4 = join(out, "amem-explainer.mp4");
const ffmpeg = spawn(
  "ffmpeg",
  ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4],
  { stdio: ["pipe", "inherit", "inherit"] },
);
const done = new Promise((ok, fail) => ffmpeg.on("close", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg ${code}`)))));

const frames = Math.round((duration - from) * FPS);
for (let i = 0; i < frames; i++) {
  const t = from + i / FPS;
  await page.evaluate((tt) => window.render(tt), t);
  const jpg = await stage.screenshot({ type: "jpeg", quality: 92 });
  if (!ffmpeg.stdin.write(jpg)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
  if (i % 150 === 0) process.stdout.write(`frame ${i}/${frames} (${t.toFixed(1)}s)\n`);
}
ffmpeg.stdin.end();
await done;

// Poster: the call-to-action frame, shown before the video plays.
await page.evaluate(() => window.render(57));
await stage.screenshot({ path: join(out, "amem-explainer.jpg"), type: "jpeg", quality: 85 });
await browser.close();

const webm = join(out, "amem-explainer.webm");
await new Promise((ok, fail) =>
  spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "36", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", webm], { stdio: "inherit" })
    .on("close", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg webm ${code}`)))),
);
console.log(`Wrote ${mp4}, ${webm} and the poster.`);
