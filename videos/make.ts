/**
 * Builds one tutorial video per language from a scenario.
 *
 *   node videos/make.ts <scenario> [sl|en ...] [--subs]
 *
 * Output in videos/out/<NN>-<scenario>/, one folder per episode with only what
 * goes to YouTube: <scenario>.<lang>.mp4, .thumb.jpg (thumbnail), .srt
 * (captions) and .txt (title, description and chapter timestamps).
 *
 * `--subs` burns the subtitles into the picture; it is on by default while no
 * TTS key is set, since the draft then has no voice. Set VIDEO_BASE_URL to use
 * a dev server that is already running; otherwise one is started on port 5199
 * and stopped again at the end.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { assemble, timeWarp, type Cue } from "./lib/assemble.ts";
import { Director, Recorder, sleep } from "./lib/director.ts";
import { installOverlay } from "./lib/overlay.ts";
import { renderThumbnail } from "./lib/thumbnail.ts";
import { listVoices, narrate, ttsAvailable } from "./lib/tts.ts";
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

/**
 * The text to paste into YouTube's upload form: title, description (with
 * chapters, links and hashtags) and tags, each under a heading naming the field.
 */
function youtubeText(scenario: Scenario, lang: Lang, chapters: string[]): string {
  const sl = lang === "sl";
  // YouTube needs the first chapter at 0:00, which is the title card.
  const toc = [`0:00 ${sl ? "Uvod" : "Introduction"}`, ...chapters.filter((c) => !c.startsWith("0:00"))];
  const description = [
    scenario.description[lang],
    "",
    sl ? "Poglavja:" : "Chapters:",
    ...toc,
    "",
    sl
      ? "GED Merge je brezplačen rodoslovni program v brskalniku: urejanje drevesa, združevanje datotek GEDCOM, diagrami, zemljevidi in orodja za čiščenje podatkov. Brez računa in brez nalaganja — vaša datoteka ostane na vašem računalniku."
      : "GED Merge is a free genealogy program in your browser: edit your tree, merge GEDCOM files, draw charts and maps, and clean up your data. No account and no upload — your file stays on your computer.",
    "",
    `▶ GED Merge: https://gedmerge.com`,
    sl ? "▶ Navodila za uporabo: https://gedmerge.com/navodila/" : "▶ User's Guide: https://gedmerge.com/guide/",
    "",
    sl ? "#rodoslovje #GEDCOM #družinskodrevo #GEDMerge" : "#genealogy #GEDCOM #familytree #GEDMerge",
  ].join("\n");
  const tags = sl
    ? "GED Merge, rodoslovje, GEDCOM, družinsko drevo, rodovnik, genealogija, slovensko rodoslovje"
    : "GED Merge, genealogy, GEDCOM, family tree, family history, pedigree, genealogy software";
  const title = scenario.title[lang];
  return [
    `=== ${sl ? "NASLOV" : "TITLE"} (${title.length}/100) ===`,
    title,
    "",
    `=== ${sl ? "OPIS" : "DESCRIPTION"} ===`,
    description,
    "",
    `=== ${sl ? "OZNAKE" : "TAGS"} ===`,
    tags,
    "",
  ].join("\n");
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
  const preset = scenario.settings?.(lang);
  if (preset) {
    // Once per tab: a reload later in the video must keep what the video changed.
    await context.addInitScript((json) => {
      try {
        if (sessionStorage.getItem("gmv-preset")) return;
        localStorage.setItem("gedmerge.settings", json);
        sessionStorage.setItem("gmv-preset", "1");
      } catch { /* private mode */ }
    }, JSON.stringify(preset));
  }
  await context.addInitScript(installOverlay);
  const page = await context.newPage();
  await page.goto(baseUrl);
  await page.locator("input.file-input").first().waitFor({ state: "attached" });
  await page.evaluate(() => document.fonts.ready);

  const d = new Director(page, lang);
  if (scenario.prepare) {
    await scenario.prepare(d);
    // The recording opens on a fresh page, as every other episode's does.
    await page.reload();
    await page.locator("input.file-input").first().waitFor({ state: "attached" });
    await page.evaluate(() => document.fonts.ready);
  }
  const rec = await Recorder.start(page, path.join(CACHE, "frames", `${scenario.id}.${lang}`));
  d.clock = () => rec.now();
  const cues: Cue[] = [];
  const marks: { t: number; label: string }[] = [];
  let n = 0;
  for (const [i, step] of scenario.steps.entries()) {
    if (step.callout !== undefined) {
      if (step.callout) n++;
      await d.overlay("callout", step.callout ? String(n) : null, step.callout ? step.callout[lang] : null);
      if (step.callout) marks.push({ t: rec.now(), label: step.callout[lang] });
    }
    const clip = clips[i];
    cues.push({ start: rec.now(), duration: clip.duration, text: step.say[lang], audio: clip.file });
    d.saidAt = rec.now() + clip.duration;
    // The next step's callout, for a step that walks to the next screen at its
    // end (Director.calloutAhead).
    const next = scenario.steps[i + 1]?.callout;
    d.upcoming = next ? { n: String(n + 1), text: next[lang] } : undefined;
    await Promise.all([step.run?.(d), sleep(clip.duration * 1000)]);
    await sleep(GAP_MS);
  }
  const end = await rec.stop();
  // One folder per episode, holding only what goes to YouTube.
  const dir = path.join(OUT, `${String(scenario.episode).padStart(2, "0")}-${scenario.id}`);
  mkdirSync(dir, { recursive: true });
  const output = path.join(dir, `${scenario.id}.${lang}.mp4`);

  if (!d.shot) console.warn(`  no d.snapshot() in ${scenario.id}: the thumbnail is skipped`);
  else {
    await renderThumbnail({
      browser, baseUrl, shot: d.shot, lang,
      tag: scenario.thumbnail.tag[lang],
      title: scenario.thumbnail.title[lang],
      minutes: Math.max(1, Math.round((timeWarp(d.skips, cues)(end) - timeWarp(d.skips, cues)(rec.frames[0]?.t ?? 0)) / 60)),
      output: output.replace(/\.mp4$/, ".thumb.jpg"),
    });
  }
  await browser.close();

  const videoTime = assemble({ frames: rec.frames, end, cues, skips: d.skips, workDir: rec.directory, output, burnSubtitles });
  const chapters = marks.map((c) => `${clock(videoTime(c.t))} ${c.label}`);

  writeFileSync(output.replace(/\.mp4$/, ".txt"), youtubeText(scenario, lang, chapters));
  return output;
}

// API keys and voice choices live in videos/.env (git-ignored), so they need
// not be exported in every shell. Variables already set in the environment win.
const ENV_FILE = path.join(HERE, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const args = process.argv.slice(2);
// `--silent`: a draft without narration (timed silence, burned-in subtitles),
// for checking content before paying for speech.
if (args.includes("--silent")) {
  for (const k of ["SONIOX_API_KEY", "ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY"]) delete process.env[k];
}
if (args.includes("--voices")) {
  await listVoices();
  process.exit(0);
}
// `--sample <voice>`: speak a test passage (names, dates, house numbers) in both
// languages with one voice, to choose a voice before building a whole video.
if (args.includes("--sample")) {
  const voice = args[args.indexOf("--sample") + 1];
  if (voice) process.env.SONIOX_VOICE_SL = process.env.SONIOX_VOICE_EN = voice;
  const SAMPLE: Record<Lang, string> = {
    sl: "Dva raziskovalca sta raziskovala isto rodbino. Pokažimo, kako njune podatke združite v eno drevo. Najprej odprite svojo datoteko GEDCOM. Drugo drevo pozna Prešernov krst v Breznici in pokop v Kranju, desetega februarja 1849. Kraj rojstva je natančnejši: Vrba 2, stara hišna številka 1. Pri očetu se drevesi razlikujeta v imenu: Šimen in Simon. Ana Jelovšek ima v drugem drevesu starša, ki ju pri vas ni. Kliknite gumb »Potrdi«. GED Merge je vaš rodoslovni program v brskalniku.",
    en: "Two researchers studied the same family. Let's combine their work into one tree. First, open your own GEDCOM file. The other tree knows Prešeren's baptism in Breznica and his burial in Kranj on the tenth of February 1849. For the father, the trees differ in the name: Šimen and Simon. Click Confirm. GED Merge is your genealogy program in the browser.",
  };
  mkdirSync(path.join(OUT, "samples"), { recursive: true });
  for (const lang of ["sl", "en"] as Lang[]) {
    const clip = await narrate(SAMPLE[lang], lang, path.join(CACHE, "tts"));
    const out = path.join(OUT, "samples", `${voice ?? "default"}.${lang}.mp3`);
    copyFileSync(clip.file, out);
    console.log(`${out}  (${clip.duration.toFixed(1)} s)`);
  }
  process.exit(0);
}
const id = args.find((a) => !a.startsWith("--") && a !== "sl" && a !== "en");
if (!id) {
  console.error("Usage: node videos/make.ts <scenario> [sl|en ...] [--subs] [--silent]   |   node videos/make.ts --voices");
  process.exit(1);
}
const langs = args.filter((a): a is Lang => a === "sl" || a === "en");
const scenario = ((await import(`./scripts/${id}.ts`)) as { default: Scenario }).default;
if (!ttsAvailable()) console.warn("No TTS key (SONIOX_API_KEY, ELEVENLABS_API_KEY or AZURE_SPEECH_KEY): narration is silent, subtitles are burned in.");
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
