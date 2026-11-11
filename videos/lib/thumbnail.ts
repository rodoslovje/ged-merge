/**
 * The YouTube thumbnail (1280×720 JPEG): one shared layout for the whole
 * series — logo, an accent tag, a large title and a "video tutorial · N min"
 * badge on the left, the feature's own screenshot on the right — so each video
 * is told apart by its picture and title while the channel reads as one set.
 *
 * Rendered by the browser over the running app, so the app's own self-hosted
 * IBM Plex Sans is available without a network font request.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "@playwright/test";
import type { Lang } from "./types.ts";

const LOGO = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../public/favicon.svg"), "utf-8");

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `*word*` → accent-coloured word. */
function accent(s: string): string {
  return escapeHtml(s).replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

export async function renderThumbnail(opts: {
  browser: Browser;
  baseUrl: string;
  shot: Buffer;
  tag: string;
  title: string;
  minutes: number;
  lang: Lang;
  output: string;
}): Promise<void> {
  const { browser, shot, lang } = opts;
  const badge = lang === "sl" ? `Video navodila · ${opts.minutes} min` : `Video tutorial · ${opts.minutes} min`;
  const html = `
<style>
  * { box-sizing: border-box; margin: 0; }
  .t { position: fixed; inset: 0; width: 1280px; height: 720px; overflow: hidden; font-family: "IBM Plex Sans", sans-serif;
    background: linear-gradient(135deg, #16332a 0%, #1f4637 55%, #2c5a47 100%); color: #fff; }
  .t::before { content: ""; position: absolute; inset: 0;
    background: repeating-linear-gradient(135deg, rgba(255,255,255,.035) 0 2px, transparent 2px 28px); }
  .shot { position: absolute; left: 640px; top: 104px; width: 820px; border-radius: 18px; border: 6px solid #fff;
    box-shadow: 0 30px 70px rgba(0,0,0,.55); transform: rotate(-2.5deg); transform-origin: left top; }
  .left { position: absolute; left: 56px; top: 48px; bottom: 48px; width: 560px; z-index: 1; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 16px; font-size: 34px; font-weight: 700; letter-spacing: .01em; }
  .brand svg { width: 58px; height: 58px; border-radius: 14px; box-shadow: 0 0 0 3px rgba(255,255,255,.85); }
  .tag { align-self: flex-start; margin-top: 44px; background: #e8a33d; color: #1d2b25; font-size: 27px; font-weight: 700;
    letter-spacing: .06em; text-transform: uppercase; padding: 8px 18px; border-radius: 10px; transform: rotate(-2deg);
    box-shadow: 0 6px 18px rgba(0,0,0,.35); }
  h1 { margin-top: 26px; font-size: 66px; line-height: 1.04; font-weight: 700; text-shadow: 0 4px 18px rgba(0,0,0,.4); }
  h1 em { font-style: normal; color: #f2b85a; }
  .badge { margin-top: auto; align-self: flex-start; display: flex; align-items: center; gap: 12px; font-size: 25px; font-weight: 600;
    background: rgba(255,255,255,.14); border: 2px solid rgba(255,255,255,.35); padding: 9px 20px 9px 12px; border-radius: 999px; }
  .badge i { width: 34px; height: 34px; border-radius: 50%; background: #e8a33d; display: grid; place-items: center; }
  .badge i::after { content: ""; border-left: 13px solid #1d2b25; border-top: 8px solid transparent; border-bottom: 8px solid transparent; margin-left: 4px; }
  .lang { position: absolute; right: 28px; top: 26px; font-size: 22px; font-weight: 700; letter-spacing: .1em; color: #1d2b25;
    background: #fff; padding: 6px 14px; border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
</style>
<div class="t">
  <img class="shot" src="data:image/png;base64,${shot.toString("base64")}">
  <div class="left">
    <div class="brand">${LOGO}<span>GED Merge</span></div>
    <div class="tag">${escapeHtml(opts.tag)}</div>
    <h1>${accent(opts.title)}</h1>
    <div class="badge"><i></i>${escapeHtml(badge)}</div>
  </div>
  <div class="lang">${lang === "sl" ? "SLO" : "ENG"}</div>
</div>`;

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(opts.baseUrl);
  await page.evaluate((markup) => {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
    host.attachShadow({ mode: "open" }).innerHTML = markup;
    document.documentElement.appendChild(host);
  }, html);
  await page.evaluate(async () => {
    const host = document.documentElement.lastElementChild as HTMLElement;
    await host.shadowRoot?.querySelector("img")?.decode();
    await document.fonts.load('700 66px "IBM Plex Sans"');
    await document.fonts.load('600 25px "IBM Plex Sans"');
    await document.fonts.ready;
  });
  await page.screenshot({ path: opts.output, type: "jpeg", quality: 92 });
  await context.close();
}
