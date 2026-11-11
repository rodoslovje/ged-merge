/**
 * Narration audio, one clip per step.
 *
 * With `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` set, each line is spoken by
 * an Azure neural voice. Without them every clip is silence of the length the
 * line would take to read aloud, so a draft video can be built and timed before
 * a key exists (`make.ts` then burns the narration in as subtitles).
 *
 * Clips are cached by a hash of voice + text, so a rebuild after an unrelated
 * edit costs no new synthesis.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Lang } from "./types.ts";

const VOICES: Record<Lang, string> = {
  sl: process.env.VIDEO_VOICE_SL ?? "sl-SI-PetraNeural",
  en: process.env.VIDEO_VOICE_EN ?? "en-US-AvaNeural",
};

/**
 * How the voice should say words it would otherwise read letter by letter or in
 * the wrong language. Applied to the spoken text only; subtitles keep the
 * original spelling.
 */
const PRONOUNCE: Record<Lang, [RegExp, string][]> = {
  sl: [
    [/GED Merge/g, "Ged Merdž"],
    [/GEDCOM/g, "ged-kom"],
    [/\.ged\b/g, " pika ged"],
  ],
  en: [
    [/GED Merge/g, "Ged Merge"],
    [/GEDCOM/g, "ged-com"],
    [/\.ged\b/g, " dot ged"],
  ],
};

export interface Clip {
  file: string;
  /** Seconds. */
  duration: number;
  /** True when this is silence standing in for speech. */
  placeholder: boolean;
}

export function ttsAvailable(): boolean {
  return Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function probeDuration(file: string): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(out.toString().trim());
}

/** Reading time of a line at a calm tutorial pace. */
function estimateSeconds(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return Math.max(1.5, words / 2.3 + 0.3);
}

export async function narrate(text: string, lang: Lang, cacheDir: string): Promise<Clip> {
  mkdirSync(cacheDir, { recursive: true });
  const live = ttsAvailable();
  const voice = VOICES[lang];
  let spoken = text;
  for (const [re, to] of PRONOUNCE[lang]) spoken = spoken.replace(re, to);
  const key = createHash("sha1").update(`${live ? voice : "silence"}\n${spoken}`).digest("hex").slice(0, 16);
  const file = path.join(cacheDir, `${lang}-${key}.mp3`);

  if (!existsSync(file)) {
    if (live) {
      const ssml =
        `<speak version="1.0" xml:lang="${voice.slice(0, 5)}"><voice name="${voice}">` +
        `<prosody rate="-4%">${escapeXml(spoken)}</prosody></voice></speak>`;
      const res = await fetch(`https://${process.env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY!,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-48khz-192kbitrate-mono-mp3",
          "User-Agent": "ged-merge-videos",
        },
        body: ssml,
      });
      if (!res.ok) throw new Error(`Azure TTS ${res.status}: ${await res.text()}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    } else {
      execFileSync("ffmpeg", [
        "-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
        "-t", estimateSeconds(text).toFixed(2), "-c:a", "libmp3lame", "-b:a", "64k", file,
      ]);
    }
  }
  return { file, duration: probeDuration(file), placeholder: !live };
}
