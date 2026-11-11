/**
 * Builds one tutorial video per language from a scenario.
 *
 *   node videos/make.ts <scenario> [sl|en ...] [--subs]
 *
 * Output in videos/out/: <scenario>.<lang>.mp4, the matching .srt for
 * YouTube's captions, and <scenario>.<lang>.txt with the title, description
 * and chapter timestamps to paste into YouTube.
 *
 * `--subs` burns the subtitles into the picture; it is on by default while no
 * TTS key is set, since the draft then has no voice. Set VIDEO_BASE_URL to use
 * a dev server that is already running; otherwise one is started on port 5199
 * and stopped again at the end.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { assemble, type Cue } from "./lib/assemble.ts";
import { Director, Recorder, sleep } from "./lib/director.ts";
import { installOverlay } from "./lib/overlay.ts";
import { narrate, ttsAvailable } from "./lib/tts.ts";
import type { Lang, Scenario } from "./lib/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const OUT = path.join(HERE, "out");
const CACHE = path.join(HERE, ".cache");
/** Pause after each step's narration, so the picture can settle. */
const GAP_MS = 600;

async function devServer(): Promise<{ url: string; proc?: ChildProcess }> {
  if (process.env.VIDEO_BASE_URL) return { url: process.env.VIDEO_BASE_URL };
  const url = "http://localhost:5199/";
  const proc = spawn(path.join(ROOT, "node_modules/.bin/vite"), ["--port", "5199", "--strictPort"], { cwd: ROOT, stdio: "ignore" });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return { url, proc };
    } catch { /* not up yet */ }
    await sleep(500);
  }
  proc.kill();
  throw new Error("The dev server did not start.");
}

function clock(s: number): string {
  const t = Math.floor(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

async function record(scenario: Scenario, lang: Lang, baseUrl: string, burnSubtitles: boolean): Promise<string> {
  const clips = [];
  for (const step of scenario.steps) clips.push(await narrate(step.say[lang], lang, path.join(CACHE, "tts")));

  const browser = await chromium.launch();
  const context = await browser.newContext({
    // Laid out at 1440×810 and rendered at 4/3 scale: a 1920×1080 picture with
    // UI text large enough to read on a phone.
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 4 / 3,
    locale: lang === "sl" ? "sl-SI" : "en-GB",
    acceptDownloads: true,
  });
  await context.addInitScript((l) => {
    try { localStorage.setItem("gedmerge.lang", l); } catch { /* private mode */ }
  }, lang);
  await context.addInitScript(installOverlay);
  const page = await context.newPage();
  await page.goto(baseUrl);
  await page.locator("input.file-input").first().waitFor({ state: "attached" });
  await page.evaluate(() => document.fonts.ready);

  const d = new Director(page, lang);
  const rec = await Recorder.start(page, path.join(OUT, `${scenario.id}.${lang}.frames`));
  const cues: Cue[] = [];
  const chapters: string[] = [];
  let n = 0;
  for (const [i, step] of scenario.steps.entries()) {
    if (step.callout !== undefined) {
      if (step.callout) n++;
      await d.overlay("callout", step.callout ? String(n) : null, step.callout ? step.callout[lang] : null);
      if (step.callout) chapters.push(`${clock(rec.now())} ${step.callout[lang]}`);
    }
    const clip = clips[i];
    cues.push({ start: rec.now(), duration: clip.duration, text: step.say[lang], audio: clip.file });
    await Promise.all([step.run?.(d), sleep(clip.duration * 1000)]);
    await sleep(GAP_MS);
  }
  const end = await rec.stop();
  await browser.close();

  mkdirSync(OUT, { recursive: true });
  const output = path.join(OUT, `${scenario.id}.${lang}.mp4`);
  assemble({ frames: rec.frames, end, cues, workDir: rec.directory, output, burnSubtitles });

  // YouTube needs the first chapter at 0:00, which is the title card.
  const intro = lang === "sl" ? "Uvod" : "Introduction";
  const meta = [
    scenario.title[lang],
    "",
    scenario.description[lang],
    "",
    `0:00 ${intro}`,
    ...chapters.filter((c) => !c.startsWith("0:00")),
    "",
    "https://gedmerge.com",
  ].join("\n");
  writeFileSync(output.replace(/\.mp4$/, ".txt"), meta + "\n");
  return output;
}

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith("--") && a !== "sl" && a !== "en");
if (!id) {
  console.error("Usage: node videos/make.ts <scenario> [sl|en ...] [--subs]");
  process.exit(1);
}
const langs = args.filter((a): a is Lang => a === "sl" || a === "en");
const scenario = ((await import(`./scripts/${id}.ts`)) as { default: Scenario }).default;
if (!ttsAvailable()) console.warn("AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not set: narration is silent, subtitles are burned in.");
const burn = args.includes("--subs") || !ttsAvailable();

const server = await devServer();
try {
  for (const lang of langs.length ? langs : (["sl", "en"] as Lang[])) {
    console.log(`Recording ${id} (${lang})…`);
    console.log(`  → ${await record(scenario, lang, server.url, burn)}`);
  }
} finally {
  server.proc?.kill();
}
