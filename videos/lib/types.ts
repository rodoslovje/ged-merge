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
  /** YouTube title and title card. */
  title: Text;
  /** YouTube description (first lines). */
  description: Text;
  steps: Step[];
}
