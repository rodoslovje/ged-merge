# Tutorial videos

Screencast tutorials for YouTube, in Slovenian and English, built from code:
each video is a scenario in `scripts/` that drives the real app with Playwright,
draws a pointer, rings and step callouts over it, and lays TTS narration and
subtitles on top. When the UI changes, rebuild instead of re-recording.

```bash
node videos/make.ts merge          # both languages
node videos/make.ts merge sl       # one language
node videos/make.ts merge --subs   # burn subtitles into the picture too
```

Output in `videos/out/` (git-ignored), per language:

| File | Use |
|------|-----|
| `merge.sl.mp4` | 1920×1080, 30 fps, H.264 + AAC — upload as is |
| `merge.sl.srt` | YouTube → Subtitles → Upload file (with timing) |
| `merge.sl.txt` | title, description and chapter timestamps to paste into YouTube |

A dev server is started on port 5199 and stopped at the end; set
`VIDEO_BASE_URL=http://localhost:5173/` to use one that is already running.
Needs `ffmpeg` and Playwright's Chromium (`npx playwright install chromium`).

## Narration (Azure TTS)

```bash
export AZURE_SPEECH_KEY=…  AZURE_SPEECH_REGION=westeurope
```

Without them the narration is silence of the right length and the subtitles are
burned in, so a draft can be timed and reviewed before a key exists. To get a
key: Azure portal → *Create a resource* → *Speech service*, pricing tier
**Free F0**; the key and region are under *Keys and Endpoint*. Voices default to
`sl-SI-PetraNeural` and `en-US-AvaNeural`; override with `VIDEO_VOICE_SL` /
`VIDEO_VOICE_EN`. Clips are cached in `videos/.cache/`, so only changed lines
are synthesised again. Words the voice mispronounces go into `PRONOUNCE` in
`lib/tts.ts` (spoken text only; subtitles keep the spelling).

## Writing a scenario

A scenario (`scripts/<id>.ts`) is a list of steps. Each step has the narration
in both languages (`say`), an optional corner callout that also becomes a
YouTube chapter (`callout`), and the on-screen actions (`run`), which start
together with the narration. The step lasts until both are done.

The `Director` passed to `run` offers `click`, `point`, `upload`,
`highlight`, `scrollTo`, `card` and `wait`. Select elements by CSS class
rather than by label, so one scenario works in both languages.

Demo data lives in `demo/`. It is fictional — never record a real person's
data for a public video.

## Files

| Path | Role |
|------|------|
| `make.ts` | entry point: TTS → record → assemble, per language |
| `lib/director.ts` | pointer, clicks, rings; CDP screencast recorder |
| `lib/overlay.ts` | the in-page overlay (pointer, ring, callout, title card) |
| `lib/tts.ts` | Azure TTS with cache and silent fallback |
| `lib/assemble.ts` | ffmpeg: frames + narration → MP4; SRT |
| `scripts/` | one scenario per video |
| `demo/` | fictional GEDCOM files used by the scenarios |
