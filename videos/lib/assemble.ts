/**
 * Turns a recording into a YouTube-ready MP4: screencast frames → 30 fps
 * H.264 at 1920×1080, narration clips laid onto one track at the moment each
 * step began, and an SRT file built from the same timings.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Frame } from "./director.ts";

export interface Cue {
  /** Seconds since recording started. */
  start: number;
  duration: number;
  text: string;
  audio: string;
}

function srtTime(s: number): string {
  const ms = Math.max(0, Math.round(s * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/**
 * A step's narration split into readable subtitle lines: one sentence each
 * (long sentences split again at a comma), each shown for a share of the
 * narration proportional to its length.
 */
function lines(text: string): string[] {
  const out: string[] = [];
  // A sentence ends at . ! or ? followed by a space — not at the dot in "gedmerge.com".
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    let rest = sentence.trim();
    while (rest.length > 90) {
      const cut = rest.lastIndexOf(", ", 90);
      if (cut < 30) break;
      out.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 2);
    }
    if (rest) out.push(rest);
  }
  return out;
}

export function buildSrt(cues: Cue[]): string {
  const entries: string[] = [];
  for (const cue of cues) {
    const parts = lines(cue.text);
    const total = parts.reduce((n, p) => n + p.length, 0);
    let t = cue.start;
    for (const part of parts) {
      const d = (cue.duration * part.length) / total;
      entries.push(`${entries.length + 1}\n${srtTime(t)} --> ${srtTime(t + d)}\n${part}\n`);
      t += d;
    }
  }
  return entries.join("\n");
}

/** Share of a skippable wait that stays in the video, and the least it shrinks to. */
const SKIP_KEEP = 1 / 3;
const SKIP_MIN_SECONDS = 0.8;

/**
 * The recording's clock mapped onto the video's: every skippable wait
 * (`Director.skippable`) is played faster, down to a third of its length,
 * except where narration runs over it — speech is never sped up, so audio,
 * subtitles and chapters stay in step with the picture.
 */
export function timeWarp(skips: [number, number][], cues: Cue[]): (t: number) => number {
  const spoken = cues.map((c) => [c.start, c.start + c.duration] as const);
  const silent: [number, number][] = [];
  for (const skip of skips) {
    let parts: [number, number][] = [skip];
    for (const [s, e] of spoken) {
      parts = parts.flatMap(([x, y]): [number, number][] =>
        e <= x || s >= y ? [[x, y]] : ([[x, Math.min(y, s)], [Math.max(x, e), y]] as [number, number][]).filter(([p, q]) => q - p > 0.05),
      );
    }
    silent.push(...parts);
  }
  const cuts = silent
    .map(([x, y]) => {
      const len = y - x;
      const keep = Math.max(Math.min(len, SKIP_MIN_SECONDS), len * SKIP_KEEP);
      return { x, y, ratio: keep / len };
    })
    .filter((c) => c.ratio < 1);
  return (t) => {
    let removed = 0;
    for (const c of cuts) if (t > c.x) removed += (Math.min(t, c.y) - c.x) * (1 - c.ratio);
    return t - removed;
  };
}

/** Builds the MP4 and SRT; returns recording time → time in the video (for chapter marks). */
export function assemble(opts: {
  frames: Frame[];
  end: number;
  cues: Cue[];
  skips?: [number, number][];
  workDir: string;
  output: string;
  burnSubtitles: boolean;
}): (t: number) => number {
  const { workDir, output } = opts;
  if (opts.frames.length === 0) throw new Error("No frames were recorded.");
  const warp = timeWarp(opts.skips ?? [], opts.cues);
  const frames = opts.frames.map((f) => ({ ...f, t: warp(f.t) }));
  const cues = opts.cues.map((c) => ({ ...c, start: warp(c.start) }));
  const end = warp(opts.end);

  // Concat list: every frame stays up until the next one arrives.
  const list = path.join(workDir, "frames.txt");
  const rows: string[] = [];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : end;
    rows.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
  });
  rows.push(`file '${frames[frames.length - 1].file}'`);
  writeFileSync(list, rows.join("\n") + "\n");

  // The first frame arrives a moment after recording starts; the video's
  // zero is that frame, so audio and subtitles shift to match.
  const offset = frames[0].t;
  const srt = output.replace(/\.mp4$/, ".srt");
  writeFileSync(srt, buildSrt(cues.map((c) => ({ ...c, start: c.start - offset }))));

  const inputs = cues.flatMap((c) => ["-i", c.audio]);
  const delays = cues.map((c, i) => {
    const ms = Math.max(0, Math.round((c.start - offset) * 1000));
    return `[${i + 1}:a]adelay=${ms}:all=1[a${i}]`;
  });
  const mix = `${cues.map((_, i) => `[a${i}]`).join("")}amix=inputs=${cues.length}:normalize=0:dropout_transition=0,apad[aout]`;

  let vf = "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p";
  if (opts.burnSubtitles) {
    const esc = srt.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
    vf += `,subtitles='${esc}':force_style='FontName=IBM Plex Sans,FontSize=11,PrimaryColour=&H00FFFFFF,BackColour=&H99000000,BorderStyle=4,Outline=6,Shadow=0,MarginV=16'`;
  }

  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", list,
    ...inputs,
    "-filter_complex", [...delays, mix].join(";"),
    "-map", "0:v", "-map", "[aout]",
    "-vf", vf,
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-tune", "stillimage",
    "-c:a", "aac", "-b:a", "192k",
    "-t", (end - offset).toFixed(3),
    "-movflags", "+faststart",
    output,
  ], { stdio: "inherit" });
  return (t) => warp(t) - offset;
}
