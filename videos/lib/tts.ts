/**
 * Narration audio, one clip per step.
 *
 * The voice comes from the first provider with a key (read from the
 * environment or from videos/.env — see make.ts):
 *
 * - Soniox: `SONIOX_API_KEY`; voices `SONIOX_VOICE_SL` / `SONIOX_VOICE_EN`
 *   (default `Adrian`; every voice speaks every language — `node
 *   videos/make.ts --voices` lists them), model `SONIOX_MODEL` (default
 *   `tts-rt-v2`).
 * - ElevenLabs: `ELEVENLABS_API_KEY`; voices `ELEVENLABS_VOICE_SL` /
 *   `ELEVENLABS_VOICE_EN` (`node videos/make.ts --voices` lists yours), model
 *   `ELEVENLABS_MODEL` (default `eleven_v3`, which speaks Slovenian;
 *   `eleven_multilingual_v2` does not).
 * - Azure: `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION`; voices `VIDEO_VOICE_SL` /
 *   `VIDEO_VOICE_EN` (default `sl-SI-PetraNeural`, `en-US-AvaNeural`).
 * - Neither: every clip is silence as long as the line takes to read aloud, so
 *   a draft can be timed before a key exists (make.ts then burns in subtitles).
 *
 * Clips are cached by a hash of provider + voice + text, so a rebuild after an
 * unrelated edit synthesises nothing new.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Lang } from "./types.ts";

/**
 * How the voice should say words it would otherwise read letter by letter or in
 * the wrong language. Applied to the spoken text only; subtitles keep the
 * original spelling.
 */
const PRONOUNCE: Record<Lang, [RegExp, string][]> = {
  sl: [
    // English pronunciation, spelled the way a Slovenian voice reads it.
    [/gedmerge\.com/g, "Džed Merdž pika kom"],
    [/GED Merge/g, "Džed Merdž"],
    [/GEDCOM/g, "gedkom"],
    [/\.ged\b/g, " pika ged"],
    // Stresses the voice gets wrong (episode 7): GURS is one word, "Gúrs",
    // and "sloji" is "slóji", not "slojí".
    [/\bGURS\b/g, "Gúrs"],
    [/\b([Ss])loj(i|e|ih|ev)\b/g, "$1lój$2"],
    [/\b([Pp])ribližajmo\b/g, "$1ribližájmo"],
  ],
  en: [
    [/gedmerge\.com/g, "GED Merge dot com"],
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

interface Provider {
  /** Identifies the voice in the cache key. */
  id: string;
  synthesize(text: string): Promise<Buffer>;
}

function soniox(lang: Lang): Provider | null {
  const key = process.env.SONIOX_API_KEY;
  if (!key) return null;
  const voice = (lang === "sl" ? process.env.SONIOX_VOICE_SL : process.env.SONIOX_VOICE_EN) ?? "Adrian";
  const model = process.env.SONIOX_MODEL ?? "tts-rt-v2";
  return {
    id: `soniox:${model}:${voice}`,
    async synthesize(text) {
      const res = await fetch("https://tts-rt.soniox.com/tts", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, language: lang, voice, audio_format: "mp3", sample_rate: 44100, bitrate: 192000, text }),
      });
      if (!res.ok) throw new Error(`Soniox ${res.status}: ${await res.text()}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

function elevenLabs(lang: Lang): Provider | null {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return null;
  const voice = lang === "sl" ? process.env.ELEVENLABS_VOICE_SL : process.env.ELEVENLABS_VOICE_EN;
  if (!voice) throw new Error(`Set ELEVENLABS_VOICE_${lang.toUpperCase()} (node videos/make.ts --voices lists your voices).`);
  const model = process.env.ELEVENLABS_MODEL ?? "eleven_v3";
  return {
    id: `elevenlabs:${model}:${voice}`,
    async synthesize(text) {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: model,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      });
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

function azure(lang: Lang): Provider | null {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) return null;
  const voice = lang === "sl" ? (process.env.VIDEO_VOICE_SL ?? "sl-SI-PetraNeural") : (process.env.VIDEO_VOICE_EN ?? "en-US-AvaNeural");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    id: `azure:${voice}`,
    async synthesize(text) {
      const ssml = `<speak version="1.0" xml:lang="${voice.slice(0, 5)}"><voice name="${voice}"><prosody rate="-4%">${esc(text)}</prosody></voice></speak>`;
      const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-48khz-192kbitrate-mono-mp3",
          "User-Agent": "ged-merge-videos",
        },
        body: ssml,
      });
      if (!res.ok) throw new Error(`Azure TTS ${res.status}: ${await res.text()}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

function provider(lang: Lang): Provider | null {
  return soniox(lang) ?? elevenLabs(lang) ?? azure(lang);
}

export function ttsAvailable(): boolean {
  return Boolean(process.env.SONIOX_API_KEY || process.env.ELEVENLABS_API_KEY || (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION));
}

/** Print the voices of the configured provider (for SONIOX_VOICE_* / ELEVENLABS_VOICE_*). */
export async function listVoices(): Promise<void> {
  const sonioxKey = process.env.SONIOX_API_KEY;
  if (sonioxKey) {
    const res = await fetch("https://api.soniox.com/v1/tts-models", { headers: { Authorization: `Bearer ${sonioxKey}` } });
    if (!res.ok) throw new Error(`Soniox ${res.status}: ${await res.text()}`);
    const { models } = (await res.json()) as { models: { id: string; voices: { id: string; gender: string; description: string }[] }[] };
    for (const m of models) {
      console.log(`model ${m.id}`);
      for (const v of m.voices) console.log(`  ${v.id}  ${v.gender}  ${v.description}`);
    }
    return;
  }
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("Neither SONIOX_API_KEY nor ELEVENLABS_API_KEY is set.");
  const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  const { voices } = (await res.json()) as { voices: { voice_id: string; name: string; labels?: Record<string, string> }[] };
  for (const v of voices) console.log(`${v.voice_id}  ${v.name}  ${Object.values(v.labels ?? {}).join(", ")}`);
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
  const p = provider(lang);
  let spoken = text;
  for (const [re, to] of PRONOUNCE[lang]) spoken = spoken.replace(re, to);
  const key = createHash("sha1").update(`${p?.id ?? "silence"}\n${spoken}`).digest("hex").slice(0, 16);
  const file = path.join(cacheDir, `${lang}-${key}.mp3`);

  if (!existsSync(file)) {
    if (p) writeFileSync(file, await p.synthesize(spoken));
    else {
      execFileSync("ffmpeg", [
        "-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
        "-t", estimateSeconds(text).toFixed(2), "-c:a", "libmp3lame", "-b:a", "64k", file,
      ]);
    }
  }
  return { file, duration: probeDuration(file), placeholder: !p };
}
