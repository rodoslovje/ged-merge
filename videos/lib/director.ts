/**
 * Drives the app for a video: moves the visible pointer, rings controls, shows
 * the step callout, and records the screen.
 *
 * Recording uses Chrome's own screencast (CDP `Page.startScreencast`) rather
 * than Playwright's `recordVideo`, whose fixed low bitrate blurs UI text. The
 * screencast delivers a frame only when the page repaints; each frame is kept
 * on disk with its arrival time and `assemble.ts` holds it on screen until the
 * next one.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CDPSession, Locator, Page } from "@playwright/test";
import type { OverlayApi } from "./overlay.ts";
import type { Lang, Text } from "./types.ts";

export interface Frame {
  file: string;
  /** Seconds since recording started. */
  t: number;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Recorder {
  private cdp?: CDPSession;
  private t0 = 0;
  readonly frames: Frame[] = [];
  private readonly dir: string;
  private constructor(dir: string) {
    this.dir = dir;
  }

  static async start(page: Page, dir: string): Promise<Recorder> {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const rec = new Recorder(dir);
    rec.cdp = await page.context().newCDPSession(page);
    rec.t0 = performance.now();
    rec.cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
      const file = path.join(dir, `f${String(rec.frames.length).padStart(6, "0")}.jpg`);
      writeFileSync(file, Buffer.from(data, "base64"));
      rec.frames.push({ file, t: rec.now() });
      void rec.cdp?.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    await rec.cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    return rec;
  }

  /** Seconds since recording started. */
  now(): number {
    return (performance.now() - this.t0) / 1000;
  }

  async stop(): Promise<number> {
    await this.cdp?.send("Page.stopScreencast");
    return this.now();
  }

  get directory(): string {
    return this.dir;
  }
}

export class Director {
  readonly page: Page;
  readonly lang: Lang;
  /** The screen grabbed for the YouTube thumbnail (see `snapshot`). */
  shot?: Buffer;
  /** Recording time (seconds), set by make.ts once recording starts. */
  clock: () => number = () => 0;
  /** Recording time (seconds) at which the current step's narration ends, set by make.ts. */
  saidAt = 0;
  /** Stretches of dead waiting (see `skippable`) to shorten in the final cut. */
  /** [start, end, share kept] — the share defaults to assemble.ts's. */
  readonly skips: [number, number, number?][] = [];
  /** Stretches whose frames are left out (see `frozen`). */
  readonly freezes: [number, number][] = [];
  constructor(page: Page, lang: Lang) {
    this.page = page;
    this.lang = lang;
  }

  /**
   * Run a wait that shows nothing worth watching — an online lookup, a slow
   * scan — and mark it, so assemble.ts shortens the part of it no narration
   * plays over. `keep` is the share of it left in the video (default: a third).
   */
  async skippable<T>(wait: () => Promise<T>, keep?: number): Promise<T> {
    const start = this.clock();
    try {
      return await wait();
    } finally {
      this.skips.push(keep === undefined ? [start, this.clock()] : [start, this.clock(), keep]);
    }
  }

  /**
   * Run something whose painting must not be seen — a page navigation, which
   * shows the new page for a frame or two before anything can cover it. The
   * picture holds on the last frame before it until the first frame after.
   */
  async frozen<T>(work: () => Promise<T>): Promise<T> {
    const start = this.clock();
    try {
      return await work();
    } finally {
      this.freezes.push([start, this.clock()]);
    }
  }

  t(text: Text): string {
    return text[this.lang];
  }

  /** Call one overlay method in the page. */
  async overlay<K extends keyof OverlayApi>(name: K, ...args: Parameters<OverlayApi[K]>): Promise<void> {
    await this.page.evaluate(
      ([n, a]) => {
        const api = (window as unknown as { __gmv: Record<string, (...x: unknown[]) => void> }).__gmv;
        api[n as string](...(a as unknown[]));
      },
      [name, args] as const,
    );
  }

  private async centre(target: Locator): Promise<{ x: number; y: number }> {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`Not visible: ${target}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /** Glide the visible pointer onto a control. */
  async point(target: Locator, ms = 800): Promise<void> {
    const { x, y } = await this.centre(target);
    await this.overlay("cursor", x, y, ms);
    await sleep(ms + 100);
  }

  /** Point at a control, show the click, then click it. */
  async click(target: Locator): Promise<void> {
    await this.point(target);
    const { x, y } = await this.centre(target);
    await this.overlay("click", x, y);
    await target.click();
    await sleep(400);
  }

  /** "Drop" a file on a drop zone: point at it, then hand the file to its input. */
  async upload(dropzone: Locator, file: string): Promise<void> {
    await this.point(dropzone);
    const { x, y } = await this.centre(dropzone);
    await this.overlay("click", x, y);
    await dropzone.locator("input[type=file]").setInputFiles(file);
  }

  /** Ring a control (dimming the rest of the screen); `null` removes the ring. */
  async highlight(target: Locator | null, pad = 6): Promise<void> {
    if (!target) return this.overlay("ring", null, 0);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (box) await this.overlay("ring", box, pad);
  }

  /** Scroll something into the middle of its scroll container, smoothly. */
  async scrollTo(target: Locator): Promise<void> {
    await target.evaluate((e) => e.scrollIntoView({ behavior: "smooth", block: "center" }));
    await sleep(800);
  }

  async card(kicker: Text | null, title: Text | null, line: Text | null = null): Promise<void> {
    await this.overlay("card", kicker && this.t(kicker), title && this.t(title), line && this.t(line));
  }

  /**
   * Keep a title card on screen through a page navigation: the next page
   * shows it from its first paint, so its loading (an unstyled flash, the
   * page behind) is never seen. `null` lets go; follow with `card(null, null)`
   * to fade it out.
   */
  async holdCard(kicker: Text | null, title: Text | null, line: Text | null = null): Promise<void> {
    const value = title ? JSON.stringify([kicker && this.t(kicker), this.t(title), line && this.t(line)]) : null;
    await this.page.evaluate((v) => {
      if (v) sessionStorage.setItem("gmv-card", v);
      else sessionStorage.removeItem("gmv-card");
    }, value);
  }

  /**
   * Grab the current screen for the thumbnail, without the pointer and the
   * step callout (a ring, if one is shown, stays: it marks the feature).
   */
  async snapshot(): Promise<void> {
    await this.overlay("chrome", false);
    await sleep(100);
    this.shot = await this.page.screenshot({ type: "png" });
    await this.overlay("chrome", true);
  }

  /** Wait until the current step's narration has been spoken — for an action
   *  that should follow what the narrator says about it. */
  untilSaid(): Promise<void> {
    return sleep(Math.max(0, (this.saidAt - this.clock()) * 1000));
  }

  wait(ms: number): Promise<void> {
    return sleep(ms);
  }
}
