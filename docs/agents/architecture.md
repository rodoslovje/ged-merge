# Architecture

Moved from AGENTS.md, which keeps a short summary and the module map.


**Browser-only React + TypeScript + Vite app.** No backend; all data stays local.

### Data model (two layers)

`src/gedcom/types.ts` defines both:
- **`GedNode`** — lossless raw line tree (level/tag/value/children). Everything serializes from this; no information is lost.
- **Typed domain model** (`Individual`, `Family`, `Dataset`) — a projection built on top for matching and UI. Each domain object keeps a `.raw` back-reference to its `GedNode`.

### Web Worker

All heavy work runs off the main thread in `src/worker/gedcom.worker.ts`. The worker owns the parse → normalize → match pipeline and communicates via typed messages (`src/worker/messages.ts`):

- `parse` → emits `parsed` (detections and, for the main, the inferred profile — **never the `Dataset`**: the main thread builds its own copy from the same bytes in `src/state/localLoad.ts`, because cloning a typed dataset across the boundary cost ~18 s on a 500k-person file; only a table-built compare travels) and then `matching`/`matched`. The compare's consolidation of incoming duplicates is announced as clusters the main thread replays.
- `parseCsv` → loads a CSV or spreadsheet into the compare slot: a genealogical-index matches export (indeks.rodoslovje.si), matched pair by pair, or a Slovenian parish-register index (Matricula P/K sheets), matched by the ordinary engine. **Answers asynchronously** (a workbook must be inflated), guarded by a compare generation so a superseded file cannot land
- `setStart` → re-ranks the last match result by kinship distance; emits `matching`/`matched` carrying only the new order (a `KinshipRanking` of positions into the list the main thread already holds)
- `scoreDetail` → one pair's score breakdown for the score tooltip; the match list itself travels without breakdowns

The worker keeps its own copies of `mainDataset`, `compareNormalized`, and `lastResult` so any side can be (re)loaded in any order and the results stay consistent.

### Normalization

When the compare file loads, `src/normalize/` reshapes it to match the main file's "house style" — date format (e.g. `DD.MM.YYYY` vs `JAN 1900`), place layout (`structured-addr` / `packed-plac` / …), and link languages (Matricula, Geneanet). The `NormalizationReport` summarizes what changed. Downstream matching compares like-for-like.

### Matching

`src/match/engine.ts` scores each main/compare individual pair 0–100 over weighted field components (surname, given name, birth date/place, parents, partners, children, marriage). Hard gates on surname/given/year-gap prune implausible pairs before scoring. `src/match/distance.ts` re-ranks results by kinship hops from the home person. The full algorithm — pipeline stages, penalties, calibrated thresholds, and how to verify changes — is documented in [MATCHING.md](MATCHING.md).

### App state (App.tsx)

Both **Edit** and **Merge** mode views stay mounted simultaneously and are toggled with CSS `display`, not conditional rendering — avoids remounting large unvirtualized lists on mode switches.

Key state:
- `main` / `compare` — `SlotState` (empty → loading → loaded | error)
- `lastMainFile` — the last successfully loaded main file, preserved while a reload is in progress so the views don't flash back to the landing page
- `decisions` — `Map<string, CandidateDecision>` keyed by `decisionKey("individual", mainId, compareId)`
- **Unified undo/redo** stack covers both edit patches (`RecordPatch[]`) and merge decisions in one history

### Save flow

`handleSave` → `mergeDecisions` (merge) or `buildEditReport` (edit) → `SaveDialog` preview → `handleConfirmSave` → downloads `{base}.gedmerge.ged` + `{base}.gedmerge.report.txt`. After confirming, the live `mainDataset` is rebuilt in-place from the saved records so the app reflects the new baseline without a reload.

### Styling

Plain global CSS (no CSS Modules / CSS-in-JS). Files load in a deliberate order — keep it:

`theme/fonts.css` → `theme/heritage-pine.css` → `index.css` → `theme/components.css` (overrides win last). `src/guide.css` is the standalone guide page.

- **`theme/heritage-pine.css` is the single source of design tokens** (`--bg`, `--panel`, `--accent`, `--danger`, `--status-*`, `--sex-*`, `--state-*`, `--node-*`, `--radius*`, …). `index.css` is layout/components; `components.css` is targeted overrides that must win the cascade.
- **Use a token, don't hardcode.** No raw hex/`rgb()` for anything that maps to an existing token. Colors → the `--*` color tokens; corner radii → the `--radius-sm` / `--radius` / `--radius-lg` / `--radius-pill` scale; destructive UI → `--danger` (+ `--danger-soft` for tinted fills); male/female → `--sex-male` / `--sex-female`; field accents (new / changed / link / importable) → `--status-*`.
- **New semantic color ⇒ new token, defined in *both* themes.** Add it to the dark `:root` *and* the `[data-theme="light"]` block. A color used in only one place can stay literal, but anything reused or theme-sensitive becomes a token. Don't use `var(--x, #fallback)` to paper over a missing definition — define `--x` instead (a dangling token with a fallback hides the gap and drifts).
- **Don't tokenize a foreground color that sits on a hardcoded colored background** (e.g. the status chips `background:#14492f; color:#…`) unless you token-ize the background too — otherwise light theme breaks. Convert the pair together or leave both literal.
- **Avoid `!important`** — fix specificity instead (e.g. match the descendant-selector weight and rely on source order). The few existing uses are for genuine cases (drag cursor, responsive grid resets).
- **Breakpoints (max-width): `1100` / `880` / `720` / `560`** — reuse these, don't invent new ones. Most overrides are grouped in the responsive section at the bottom of `index.css`; some live next to their component.

Sanity check after CSS edits: every referenced var must resolve to a definition, and `npm run build` must pass (it compiles the CSS).

