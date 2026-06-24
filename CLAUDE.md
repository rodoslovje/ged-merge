# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # start Vite dev server
npm run build        # typecheck + production build (dist/)
npm run typecheck    # tsc -b --noEmit  ← use this, not plain tsc --noEmit -p .
npm run lint         # ESLint with --max-warnings 0
npm run test         # vitest unit tests (run once)
npm run test:watch   # vitest watch mode
npm run test:e2e     # Playwright end-to-end tests
```

To run a single test file: `npx vitest run src/gedcom/date.test.ts`

## Architecture

**Browser-only React + TypeScript + Vite app.** No backend; all data stays local.

### Data model (two layers)

`src/gedcom/types.ts` defines both:
- **`GedNode`** — lossless raw line tree (level/tag/value/children). Everything serializes from this; no information is lost.
- **Typed domain model** (`Individual`, `Family`, `Dataset`) — a projection built on top for matching and UI. Each domain object keeps a `.raw` back-reference to its `GedNode`.

### Web Worker

All heavy work runs off the main thread in `src/worker/gedcom.worker.ts`. The worker owns the parse → normalize → match pipeline and communicates via typed messages (`src/worker/messages.ts`):

- `parse` → emits `parsed` (with `Dataset`) and then `matching`/`matched`
- `parseCsv` → loads genealogical-index matches CSV (indeks.rodoslovje.si) into the compare slot
- `setHome` → re-ranks the last match result by kinship distance; emits `matching`/`matched`

The worker keeps its own copies of `masterDataset`, `compareNormalized`, and `lastResult` so any side can be (re)loaded in any order and the results stay consistent.

### Normalization

When the compare file loads, `src/normalize/` reshapes it to match the master's "house style" — date format (e.g. `DD.MM.YYYY` vs `JAN 1900`), place layout (`structured-addr` / `packed-plac` / …), and link languages (Matricula, Geneanet). The `NormalizationReport` summarizes what changed. Downstream matching compares like-for-like.

### Matching

`src/match/engine.ts` scores each master/compare individual pair 0–100 over weighted field components (surname, given name, birth date/place, parents, partners, children, marriage). Hard gates on surname/given/year-gap prune implausible pairs before scoring. `src/match/distance.ts` re-ranks results by kinship hops from the home person.

### App state (App.tsx)

Both **Edit** and **Merge** mode views stay mounted simultaneously and are toggled with CSS `display`, not conditional rendering — avoids remounting large unvirtualized lists on mode switches.

Key state:
- `master` / `compare` — `SlotState` (empty → loading → loaded | error)
- `lastMasterFile` — the last successfully loaded master, preserved while a reload is in progress so the views don't flash back to the landing page
- `decisions` — `Map<string, CandidateDecision>` keyed by `decisionKey("individual", masterId, compareId)`
- **Unified undo/redo** stack covers both edit patches (`RecordPatch[]`) and merge decisions in one history

### Save flow

`handleSave` → `mergeDecisions` (merge) or `buildEditReport` (edit) → `SaveDialog` preview → `handleConfirmSave` → downloads `{base}.gedmerge.ged` + `{base}.gedmerge.report.txt`. After confirming, the live `masterDataset` is rebuilt in-place from the saved records so the app reflects the new baseline without a reload.

### Module map

| Path | Responsibility |
|------|----------------|
| `src/gedcom/` | Parser, builder, types, serialize, edit (rebuild/remove), date, place, name, citation, lifespan |
| `src/normalize/` | Reshape compare to master's date/place/link conventions |
| `src/match/` | Scoring engine, similarity functions, kinship distance ranking |
| `src/merge/` | Apply decisions → produce merged `GedNode[]` + change report |
| `src/review/` | Field-comparison rows (`FieldRow`), diff counts for the results table |
| `src/tree/` | Compare-tree and edit-tree logic |
| `src/csv/` | Genealogical index CSV import |
| `src/ui/` | React components |
| `src/locales/` | i18n strings (English `en`, Slovenian `sl`) via i18next |
| `src/worker/` | Web Worker entry point + message types |
