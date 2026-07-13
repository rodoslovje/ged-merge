# Project Ideas & TODO

A running list of ideas, features, and todos for ged-merge. Done items are removed
on each cleanup (last: 2026-07-13) — history lives in the changelog and git log.

## Priority queue

The items most worth doing next, in rough order of payoff for real usage
(index-scale files, everyday editing).

1. **Cluster-grouped duplicate review** — for index-scale files the duplicate
   finder produces pair counts no flat list can serve (Hawlina: 493k people →
   136k pairs, which union-find collapses to ~19.6k connected clusters, ~11k of
   them clean two-person pairs). Present duplicates grouped by cluster: review a
   pair normally; dismiss or bulk-handle a giant same-name blob wholesale. Also
   expose the existing `minScore` knob in the Tools UI (default 0.70;
   index-scale files want 0.85+). *(The worker offload half of the original item
   shipped 2026-07-13: scans run in `tools.worker.ts` with progress + cancel,
   and the results list is virtualized with no top-200 cap.)*
2. **Frequency-aware name evidence** — the last big scoring lever. A "Svitoslav
   Peruzzi" full-name match is near-conclusive; a "Janez Novak" one is barely
   evidence, yet the scorer weighs them identically — ubiquitous full names
   anchor tens of thousands of `Janez Novak (~1900)` × `Janez Novak (~1905)`
   pairs in big files. Compute per-file name frequencies at match time (one
   cheap pass) and require corroboration (dates/parents) before a ubiquitous
   full name counts as an anchor, and/or scale the name components by rarity.
   Needs the same corpus benchmarking discipline as the 2026-07 changes
   (Renko↔Renko-Rakar must lose nothing; see MATCHING.md "Verifying changes").
3. **Living persons privacy (global setting)** — one Settings toggle that hides
   data of living persons throughout the app and in matching. *(The building
   blocks exist: a Tools-tab privacy action that strips living persons
   (`tools/privacy.ts`) and a per-chart/report "hide living people" display
   toggle; this folds them into one global setting that also reaches matching.)*
4. **Merge mode: media/photo field** — the deferred Phase C of the media
   feature: compare and merge each person's media links (OBJE) like other
   fields. `review/fields.ts` currently produces no media rows at all, so
   compare-file photos can only arrive via whole-person import.

## Features

### Tools tab
- **Source reshape** — when the main file uses a source+link format, reshape all
  links into the sources format. Create a source entry from a URL's metadata, or
  attach the link to an already-existing source. Biggest payoff for **Matricula
  Online** links, but also **Geneanet Cemeteries**. *(A base exists:
  `normalize/urlMetadata.ts` already fetches a page title through the CORS relay
  for the Add Source dialog.)*
- **Matricula Online metadata** — beyond the existing link normalization
  (language code) and page-title lookup, extract metadata from the URL and by
  querying the link (e.g. book name and similar details).
- **Geneanet Cemeteries metadata** — same idea as the Matricula Online metadata
  feature, for Geneanet Cemeteries links.
- **Source coverage report** — which facts / persons have no citation at all
  (extends the existing health check).
- **Place gazetteer standardization** — validate & fix place spelling and
  hierarchy against GeoNames / GOV, beyond the current reshape.

### Reports & charts
- **Report generation depth** — a max-generations setting for the Ahnentafel /
  descendant register (both currently walk the whole tree).
- **Research to-do / log** — per-person open questions, flags, research notes.
- **Map view** — plot birth/death/marriage places (geocoded) and migration paths.

### Settings
- **Local media photos in SVG** — choose how to save people's local media photos
  when exporting SVG: embedded in the SVG (current behavior), or as links to a
  configurable URL prefix.

### Import / export
- **GEDCOM 7 + GEDZIP** — read/write GEDCOM 7 and import/export GEDZIP media
  bundles. *(Crop regions already use the GEDCOM 7 vocabulary.)*
- **CSV / JSON export** — export the main file (or a filtered subset) as CSV or
  JSON for spreadsheets and external tools.
- **GEDCOM custom tags support** — a system for custom/proprietary GEDCOM tags:
  allow them to be edited and merged, with simple reshaping rules to convert
  between different supported custom types (e.g. MacFamilyTree extensions).
  Goal: support all major software, including **Brother's Keeper**, **Family
  Historian**, **RootsMagic**, and **MacFamilyTree**.

## Suggested (from the 2026-07-13 review)

Not yet committed — cull as needed.

- **Configurable link-fetch relay** — `urlMetadata.ts` hardcodes the public
  `api.allorigins.win` CORS relay; a single third-party point of failure for the
  opt-in link-fetch feature. Allow a user-supplied relay URL (or document
  self-hosting one).
- **Keyboard-shortcut cheat sheet** — a `?` overlay listing the chart/edit/merge
  shortcuts that already exist in `src/keyboard/`; today they're only
  discoverable from the guide.
- **File statistics panel** — a cheap Tools panel over data already computed:
  person/family/source counts, date coverage, surname frequency, lifespan
  distribution. (The name-frequency pass from priority #2 could feed it.)
- **Edit diff gap: INDI-level `MARR`** — the Edit view shows an INDI-level MARR
  (`INDI_EVENT_TAGS` includes it) but `editReport.ts` doesn't diff it, so such
  an edit saves without appearing in the report. Small pre-existing
  inconsistency, noted during the 2026-07-12 dedup pass.

## Performance backlog (as large-file usage grows)

- ~~**Memoize EditView subsections** (event rows, family grids) so a `tick` bump
  doesn't rebuild the whole subtree.~~ *(done 2026-07-13 — the in-place-mutation
  model is untouched; memo keys off the object identity `rebuildIndividual`/
  `rebuildFamily` already provide. `EventList` is memoized and the parent/family
  bands are extracted into memoized `ParentFamilyGroup`/`FamilySection`
  (`src/ui/edit/FamilySections.tsx`); EditView's handlers are identity-stable via
  `useStableHandler`; a `relationsGen` counter refreshes kinship badges on
  structural edits; media trays remount per owner rebuild + `mediaGen` instead of
  every tick. Verified with render counters: a person-field commit no longer
  re-renders family grids, and vice versa.)*
- ~~**O(N²) patterns in `gedcom/edit/`**~~ *(done 2026-07-13 — `nextXref` keeps a
  per-prefix max in a WeakMap (updated by `insertRecord` for bypassing
  allocators; removals just leave gaps); the prune cascade collects references
  in one pass via `referencedObjeXrefs` — which also fixed a latent bug where a
  source's page image still attached to a person could be deleted, leaving a
  dangling pointer. Full ref-counting was evaluated and rejected: undo restores
  records from snapshots wholesale, so a count cache can silently go stale, and
  a stale count risks deleting a still-referenced record.)*
- **Virtualize the place/source trees** — the Tools tree panels render every
  visible node; virtualizing them means flattening the recursive `tools-tree`
  markup first. Worth it only if index-scale files make those panels hurt. (The
  flat lists — match results, health check, duplicates — are already virtualized
  via `useVirtualList`.)
- **Explicitly not worth it**: SharedArrayBuffer for the dataset (needs a
  columnar rewrite + COOP/COEP headers that break subpath hosting); wholesale
  EditView immutability rewrite; touching `src/chart/` (cleanest layer in the
  app).

## Test / CI hardening

- **e2e tests the dev server, not the build** — point Playwright's `webServer`
  at `npm run preview` in CI and add a PWA/service-worker smoke spec (currently
  zero automated coverage of the offline/update flow).
- **Parser fuzzing** — property-based round-trip fuzzing of the parser
  (fast-check).
- **Perf floor** — a `vitest bench` benchmark for `matchDatasets` so scoring
  changes can't silently regress large-file match time.
- **Direct unit tests for `match/scoreIndividual.ts`** — currently exercised
  only through the engine-level `match.test.ts` / `similarity.test.ts`.
  *(The rest of the original "untested modules" list is covered now:
  `tools/validate.ts` via `tools.test.ts`, `merge/applyRelations.ts` via the
  merge golden tests, `normalize/date.ts`/`place.ts` via `normalize.test.ts`.)*
