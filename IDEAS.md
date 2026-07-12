# Project Ideas & TODO

A running list of ideas, features, and todos for ged-merge.

## Features

### Settings
The general Settings panel exists (language, theme, name display, kinship, link-fetch, workspace persistence). Remaining candidate settings:
- **Living persons privacy** — option to hide data of living persons throughout the app and in matching. *(A Tools-tab privacy action that strips living persons, and a per-chart/report "hide living people" display toggle, already exist; this would fold them into one global setting that also reaches matching.)*
- **Local media photos in SVG** — choose how to save people's local media photos when exporting SVG: embedded in the SVG, or as links to a URL prefix.

### New Tools (Tools tab)
- **Source reshape** — when the main file uses a source+link format, reshape all links into the sources format. Create a source entry from a URL's metadata, or attach the link to an already-existing source. Biggest payoff for **Matricula Online** links, but also **Geneanet Cemeteries**.
- **Matricula Online metadata** — beyond the existing link normalization (language code), extract metadata from the URL and by querying the link (e.g. book name and similar details).
- **Geneanet Cemeteries metadata** — same idea as the Matricula Online metadata feature, for Geneanet Cemeteries links.

### Photos
- ~~**Drag & drop** — improve adding new photos by supporting drag-and-drop.~~ *Done: dropping a file from outside the media folder (or "Import from disk…" in the Add-media picker) copies it into the folder — Chrome/Edge, readwrite upgrade with a per-session browser prompt; collisions get a `-1` suffix.*

### Matching quality
*(The 2026-07 overhaul is documented in [MATCHING.md](MATCHING.md); the dense-name-cluster false positives item shipped as part of it — parent-conflict penalties, placeholder-name handling, evidence ceiling.)*

- **Cluster-grouped duplicate review + worker offload** — for index-scale files the duplicate finder produces pair counts no flat list can serve (Hawlina: 493k people → 136k pairs, which union-find collapses to ~19.6k connected clusters, ~11k of them clean two-person pairs). Present duplicates grouped by cluster (review a pair normally; dismiss or bulk-handle a giant same-name blob wholesale), move the scan off the main thread into the worker with a progress message (~3 min compute on a 500k-person file currently blocks the tab), and expose the existing `minScore` knob in the Tools UI (default 0.70; index-scale files want 0.85+).
- **Frequency-aware name evidence** — the last big scoring lever. A "Svitoslav Peruzzi" full-name match is near-conclusive; a "Janez Novak" one is barely evidence, yet the scorer weighs them identically — ubiquitous full names anchor tens of thousands of `Janez Novak (~1900)` × `Janez Novak (~1905)` pairs in big files. Compute per-file name frequencies at match time (one cheap pass) and require corroboration (dates/parents) before a ubiquitous full name counts as an anchor, and/or scale the name components by rarity. Needs the same corpus benchmarking discipline as the 2026-07 changes (Renko↔Renko-Rakar must lose nothing; see MATCHING.md "Verifying changes").

### GEDCOM custom tags support
Build a system for custom/proprietary GEDCOM tags supported by GED Merge — allow them to be edited and merged, with simple reshaping rules to convert between different supported custom types (e.g. MacFamilyTree extensions). Goal: support all major software, including **Brother's Keeper**, **Family Historian**, **RootsMagic**, and **MacFamilyTree**.

## Suggested (from feature-set analysis)

Ideas surfaced by reviewing the current app. Not yet committed — cull as needed.

### Data quality / health (extends the existing Tools)
- **Source coverage report** — which facts / persons have no citation at all.
- **Place gazetteer standardization** — validate & fix place spelling and hierarchy against GeoNames / GOV, beyond the current reshape.

### Reports & analysis
- ~~**Ahnentafel / narrative (register) report** — exportable ancestor/descendant report. Include a **register report in NGSQ (National Genealogical Society Quarterly) format** for a person's ascendants/descendants, exported as text / RTF (or similar).~~ *Done: the Report chart kind covers Ahnentafel + an NGSQ-format descendant register behind an A/D toggle, plus a List ↔ Pripoved narrative-text view (English + Slovenian). Exports as text; RTF export is still open.*
- **Research to-do / log** — per-person open questions, flags, research notes.

### Visualization
- **Map view** — plot birth/death/marriage places (geocoded) and migration paths.
- ~~**Descendant & classic pedigree charts** — complement the existing fan, circle, grid and relationship charts.~~ *Done: the Tree and Grid chart kinds have an Ancestors ↔ Descendants direction toggle (keyboard A/D) with LR/TB alignment, covering both classic pedigree and descendant layouts.*
- ~~**Timeline view** — per-person or per-family chronological timeline.~~ *Done: the Charts hub's Timeline kind (family lifespan bars + event/marriage markers).*

### Editing / UX
- ~~**Global search & filter** — find individuals across the whole file.~~ *Done: the header search (`GlobalSearchModal`/`globalSearch.ts`) matches every name form + lifespan text, with facets for sex, birth year, place and attachments (links/notes/sources).*

### Import / export
- **GEDCOM 7 + GEDZIP** — read/write GEDCOM 7 and import/export GEDZIP media bundles.
- **Subset / format export** — ~~export part of the main file as its own GEDCOM (e.g. all ancestors or all descendants of a chosen person) to share with a friend; also export a selected branch~~ *(done — every chart's Export menu offers a branch-GEDCOM export: main dataset + that chart's people, ≥2-member-family rule, no dangling xrefs)*, or export to CSV / JSON *(still open)*.

## Refactoring backlog (from the 2026-07-12 whole-project review)

Prioritized technical-debt items from the full code review. None changes behavior on its own; pay down opportunistically as features touch the same files.

### Correctness edges (small, do first when nearby)
*All five fixed 2026-07-12: shadowed duplicate-xref records dropped from `records[]`; leading-`@` values escaped as `@@` on output (folded back on parse); `/` in name parts replaced with a space, and the trailing token after the surname kept (suffix — or given for surname-first `/Novak/ Janez` values); `onerror`/`onmessageerror` on both workers fail the waiting slots/scans instead of spinning; level-jump lines clamp to the deepest open node instead of reparenting to top level.*

### Duplication that will drift (low effort, medium payoff)
- **Event-tag sets declared 4×**: `builder.ts`, `chanCrea.ts`, `editReport.ts`, `edit.ts` ordering arrays. Extract one `eventTags.ts`.
- **Match-veto constants declared per file**: `SAME_PERSON_GIVEN = 0.85` + `differentGiven` exist independently in `match/engine.ts` and `tools/duplicates.ts`; parent-conflict predicates in three files. Centralize next to `parentGivenVerdict` in `match/similarity.ts`.
- **Event ordering derived twice**: `review/fields.ts` (zone-sort machinery) and `merge/applyFields.ts` (`sortEventsByDate`) rebuild the same lifespan-anchor ordering — the saved order matches the reviewed order only because two implementations agree. Factor one canonical function.
- **`eventUpdateHasContent` copy-pasted** in `setRecordEventField` and `addEventField` (`src/gedcom/edit.ts` ~181/~260).

### God-file decomposition (mechanical, high maintainability payoff)
- **`src/ui/ToolsView.tsx` (~2.5k lines)** → per-panel files under `src/ui/tools/`; panels are already self-contained, near-pure code motion.
- **`src/gedcom/edit.ts` (~1.2k lines)** → split along its existing banner sections into `edit/{events,names,family,media,sources,cache}.ts`.
- **`src/App.tsx` (~2.4k lines)**: collapse the six near-identical tool-fix callbacks into one `applyToolPatches` helper; extract a `useWorkspacePersistence` hook (hydration + debounced writer + persist toggle, ~300 cohesive lines) and a `useAppHistory` hook (overlay/history state machine). Also finish the started workspace-reducer migration rather than restructuring around it.
- **`review/fields.ts` (~1.2k lines)**: split `individualFieldRows` (~190 lines) into `buildEventRows` / `buildParentRows` / `buildFamilyRows`; consider typing the stringly `row.key.split(".")` dispatch in `merge/applyFields.ts`.

### Scale / performance (as large-file usage grows)
- **Virtualize the long lists** — match results, health-check issues, place/source trees all render every row (the duplicates list now caps at the top 200 as a stopgap, 2026-07-12).
- **Memoize EditView subsections** (event rows, family grids) so a `tick` bump doesn't rebuild the whole subtree — do *not* rewrite its in-place-mutation model; the undo-patch machinery depends on it.
- **O(N²) patterns in `edit.ts`**: `pruneUnreferencedMedia`/`pruneUnreferencedSource` DFS the whole dataset per removal; `nextXref` rescans all records per allocation. Reference-count / cache a max-xref counter.
- **Explicitly not worth it**: SharedArrayBuffer for the dataset (needs a columnar rewrite + COOP/COEP headers that break subpath hosting); wholesale EditView immutability rewrite; touching `src/chart/` (cleanest layer in the app).

### Test / CI hardening
- **Four e2e specs depend on gitignored `test-data/Senen.ged`** (`edit`, `export-pdf`, `global-search`, `add-relative` specs) — broken in any fresh checkout/CI; commit an anonymized e2e fixture (the corpus anonymizer already exists) or add skip guards.
- **e2e tests the dev server, not the build**: point Playwright's `webServer` at `npm run preview` in CI and add a PWA/service-worker smoke spec (currently zero automated coverage of the offline/update flow).
- Dedicated unit tests for the highest-value untested modules: `tools/validate.ts`, `match/scoreIndividual.ts`, `merge/applyRelations.ts`, `normalize/date.ts`/`place.ts`; property-based round-trip fuzzing of the parser (fast-check); a `vitest bench` perf floor for `matchDatasets`.

