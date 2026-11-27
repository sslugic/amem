#!/usr/bin/env node
/**
 * Render index.html to the landing-page video: frame by frame at 30 fps in headless Chromium
 * (render(t) sets each frame exactly, so nothing depends on timing), piped into ffmpeg, then
 * scored with the original track from make-music.py.
 *
 *   cd marketing/video && npm i --no-save playwright@1.65.1 && node render.mjs
 *
 * Writes amem-explainer.mp4 (H.264 + AAC), amem-explainer.webm (VP9 + Opus) and
 * amem-explainer.jpg (poster) into shop/public, where getamem.com serves them.
 * Options: --from 12 --to 20 renders part of it, --out <dir> writes elsewhere,
 * --mux-only keeps the existing picture and only (re)does the music (needs python3 + numpy/scipy),
 * --no-music skips the score.
 */
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const FPS = 30;
const from = Number(arg("from", 0));
const out = resolve(arg("out", join(here, "..", "..", "shop", "public")));
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "amem-video-"));
const mp4 = join(out, "amem-explainer.mp4");
const webm = join(out, "amem-explainer.webm");
const silent = join(work, "silent.mp4");

function run(cmd, args) {
  return new Promise((ok, fail) =>
    spawn(cmd, args, { stdio: "inherit" }).on("close", (code) => (code === 0 ? ok() : fail(new Error(`${cmd} exited ${code}`)))),
  );
}

async function renderFrames() {
  const { chromium } = await import("playwright");
  // AMEM_CHROMIUM points at an existing Chromium/Chrome when the Playwright browser isn't installed.
  const browser = await chromium.launch(process.env.AMEM_CHROMIUM ? { executablePath: process.env.AMEM_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(`${pathToFileURL(join(here, "index.html")).href}?capture=1`);
  await page.evaluate(() => document.fonts.ready);
  const duration = Number(arg("to", await page.evaluate(() => window.DURATION)));
  const stage = page.locator("#stage");

  const ffmpeg = spawn(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
      "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-pix_fmt", "yuv420p", silent],
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
}

if (flag("mux-only")) copyFileSync(mp4, silent);
else await renderFrames();

// Music: synthesized by make-music.py, then a little EQ (less low-mid, more air) and
// normalised to -16 LUFS so it sits as background on any speaker.
let audio = null;
if (!flag("no-music")) {
  const raw = join(work, "music.wav");
  await run("python3", [join(here, "make-music.py"), raw]);
  audio = join(work, "music-master.wav");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-af",
    "equalizer=f=300:t=q:w=1:g=-3,treble=g=7:f=3000,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", audio]);
}

const audioIn = audio ? ["-i", audio] : [];
const map = audio ? ["-map", "0:v:0", "-map", "1:a:0", "-shortest"] : ["-map", "0:v:0"];
await run("ffmpeg", ["-y", "-loglevel", "error", "-i", silent, ...audioIn, ...map, "-c:v", "copy",
  ...(audio ? ["-c:a", "aac", "-b:a", "160k"] : []), "-movflags", "+faststart", mp4]);
await run("ffmpeg", ["-y", "-loglevel", "error", "-i", silent, ...audioIn, ...map, "-c:v", "libvpx-vp9", "-b:v", "0",
  "-crf", "36", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", ...(audio ? ["-c:a", "libopus", "-b:a", "128k"] : []), webm]);
rmSync(work, { recursive: true, force: true });
console.log(`Wrote ${mp4}, ${webm}${flag("mux-only") ? "" : " and the poster"}${audio ? ", with music" : ""}.`);
