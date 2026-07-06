# GED Merge

A complete, browser-only **GEDCOM editor**. Edit your family tree, compare and merge a second
GEDCOM (or a [indeks.rodoslovje.si](https://indeks.rodoslovje.si) matches CSV) into it, and run
whole-file maintenance tools — health check, duplicate finder, normalizer, source and place
browsers. Everything runs locally in the browser; nothing is uploaded.

- **Live app:** <https://gedmerge.com>
- **User's Guide:** <https://gedmerge.com/guide/> · Slovenščina: <https://gedmerge.com/navodila/>

> This README is for **developers**. For how to *use* the app — Edit / Merge / Tools, photos,
> sources, keyboard shortcuts — see the User's Guide linked above.

## Tech stack

- **React 19 + TypeScript + Vite** — no backend; all parsing, matching, merging and editing
  happen in the browser, with the heavy work offloaded to a Web Worker.
- **i18next** — fully internationalized (English `en`, Slovenian `sl`).
- **Vitest** (unit) + **Playwright** (e2e).

## Getting started

Prerequisites: a recent **Node.js** (ships with npm).

```bash
npm install      # install dependencies
npm run dev      # start the Vite dev server, then open the printed localhost URL
```

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Start the Vite dev server. |
| `npm run build` | Type-check (`tsc -b`) **and** produce the production bundle in `dist/`. |
| `npm run preview` | Serve the built `dist/` locally. |
| `npm run typecheck` | `tsc -b --noEmit`. Note: incremental build caching can make this a no-op — prefer `npm run build` (or `tsc -b --force`) for a guaranteed full type-check. |
| `npm run lint` | ESLint with `--max-warnings 0`. |
| `npm run test` | Run the Vitest unit tests once. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:e2e` | Run the Playwright end-to-end tests. |

Run a single unit test file:

```bash
npx vitest run src/gedcom/date.test.ts
```

## Architecture

A browser-only React app. All data stays local.

- **Data model** (`src/gedcom/types.ts`) — two layers: a lossless raw line tree (`GedNode`,
  level/tag/value/children, so nothing is dropped on save) and a typed domain model
  (`Individual`, `Family`, `Dataset`) projected on top for matching and the UI.
- **Web Worker** (`src/worker/`) — owns the parse → normalize → match pipeline off the main
  thread, communicating via typed messages.
- **Normalize** (`src/normalize/`) — reshapes an incoming file to the main file's date/place/link
  "house style" before comparison.
- **Match** (`src/match/`) — scores candidate pairs 0–100 over weighted fields, and ranks them by
  kinship distance from a chosen home person.
- **Merge** (`src/merge/`) — applies per-field decisions to produce a merged `GedNode[]` plus a
  change report.
- **Tools** (`src/tools/`) — whole-file maintenance (validation, duplicate finder, bulk normalize,
  sources, places) as pure functions.
- **UI** (`src/ui/`) — React components. App state lives in `src/App.tsx`.

The build is **multi-page**: the app (`index.html`) plus the static, crawlable guide pages
(`guide/`, `navodila/`). See `CLAUDE.md` for the full module map and the styling/token conventions.

## Build & deploy

```bash
npm run build    # → dist/ : a static bundle
```

`dist/` is a self-contained static site and can be hosted on any static file server (GitHub Pages,
Netlify, Vercel, etc.).

## License

See [LICENSE.md](LICENSE.md).
