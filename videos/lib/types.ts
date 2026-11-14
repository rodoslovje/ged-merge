import type { Director } from "./director.ts";

export type Lang = "sl" | "en";
export type Text = Record<Lang, string>;

/**
 * One beat of a video: what the narrator says, the callout shown meanwhile,
 * and what happens on screen. `run` starts together with the narration; the
 * step ends when both the narration and `run` are done.
 */
export interface Step {
  /** Short label in the corner callout; omit to keep the previous one. `null` hides it. */
  callout?: Text | null;
  say: Text;
  run?: (d: Director) => Promise<void>;
}

export interface Scenario {
  /** File name stem of the output. */
  id: string;
  /** Episode number in the series (SCENARIJI.md); names the output folder. */
  episode: number;
  /** YouTube title and title card. */
  title: Text;
  /** YouTube description (first lines). */
  description: Text;
  /**
   * The YouTube thumbnail: a short category tag and a title of a few words.
   * Wrap words in *asterisks* to set them in the accent colour. The picture is
   * whatever a step grabbed with `d.snapshot()`.
   */
  thumbnail: { tag: Text; title: Text };
  /**
   * App settings (the `gedmerge.settings` object) in place before the page
   * loads — usually `seriesSettings` from lib/series.ts. Omit to start from the
   * app's defaults, as episodes 1–3 do.
   */
  settings?: (lang: Lang) => Record<string, unknown>;
  /**
   * Off-camera setup, run once the page has loaded and before recording
   * starts — what an earlier episode already did on camera, such as a place
   * directory a viewer has downloaded by now.
   */
  prepare?: (d: Director) => Promise<void>;
  steps: Step[];
}
