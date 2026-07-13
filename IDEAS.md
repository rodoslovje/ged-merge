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
Build a system for custom/proprietary GEDCOM tags supported by GED Merge — allow them to be edited and merged, with simple reshaping rules to convert between different supported custom types (e.g. MacFamilyTree extensions). Goal: support all major software, including **Brother's Keeper**, **Family Historian**, **RootsMagic**, and **MacFamilyTree**. *The concrete, corpus-driven plan lives in [Custom-tag support plan](#custom-tag-support-plan-2026-07-13-corpus-analysis) below.*

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

## Custom-tag support plan (2026-07-13 corpus analysis)

Prioritized plan for premium support of the major genealogy programs' GEDCOM output, derived from scanning all 271 files (586 MB, ~2.46 M individuals) in `~/rodoslovje/srd-data/index/input`.

### Corpus facts that shape the plan
- **Producers by share of individuals:** Brother's Keeper 211 files / 1.96 M INDI (**80%**); Family Historian 13 / 180k; MyHeritage FTB 17 / 135k; Gramps 3 / 43k; GeneWeb 6 / 38k; Family Tree Maker 5 / 36k; Legacy 5 / 23k; the rest (RootsMagic, PAF, MacFamilyTree, webtrees, Ancestry, Geni, …) ≤ 10k each.
- **The 175 BK 5.2 files contain no custom tags at all.** Their needs are encoding (ANSI→windows-1250 — already handled in `decode.ts`) and *standard* tags the app ignores, above all **`REFN` (163,662 instances in 107 files)**, `INDI.DSCR` (3.8k), `INDI.TITL` (1.3k), `FAM.RESI` (1k).
- Custom-tag volume is concentrated in **BK 6/7, Family Historian, MyHeritage** (~95% of instances).
- Already covered: lossless round-trip of any unknown tag; charset sniffing (ANSI→1250/1252, ANSEL); name variants `_MARNM`/`_AKA`/`_AKAN`/`_BIRN` (72k `_MARNM` + 25k `_AKAN`); `_URL`/`_LINK`/`_WEBTAG`; `_DSCR`; GEDCOM 7 `CROP`; health-check custom-tag inventory; SaveDialog drop-custom-tags option.

### Gap themes (with corpus counts)
- **Identity:** `_UID` — 625,382 instances in 42 files (MyHeritage, FH, Legacy, Gramps, RootsMagic, PAF; GEDCOM 7 `UID`). Same UID ⇒ same person: a free near-perfect match signal, currently only privacy-scrubbed.
- **Family status / pedigree:** `_FREL`/`_MREL` (28k each; FTM, Ancestry, BK — per-parent adopted/foster ≈ standard `PEDI`); BK's `_NMR` + `_MSTAT Partners` + `_MARRIED N` trio (~4k FAMs = unmarried partners, GEDCOM 7 `NO MARR`); `_SEPR`→`SEPA`; MyHeritage `EVEN TYPE MYHERITAGE:REL_PARTNERS`.
- **Events/attributes with real data:** BK `_INTE` (interment), `_FNRL` (funeral), `_MILT`/`_MILI` (military), `_MEDC` (medical) — all with DATE/PLAC children; ignored standard attributes `REFN`, `DSCR`, `TITL`, `RELI` (817), `NATI`, `GRAD` (3.5k FH), `FAM.NCHI`/`FAM.RESI`, Gramps `FACT`+`TYPE` (8k); `EVEN`'s `TYPE` mislabeled in review rows.
- **Media metadata:** MyHeritage `_PRIM` (primary photo, 6.5k), `_POSITION`/`_CUTOUT` (3.4k — crop rect, mappable onto existing `CROP` support), `_PHOTO_RIN`/`_FILESIZE` (23k of diff noise), `ALBUM` records; FH `_SEQ` (order), `_KEYS` (keywords), `_ASID`/`_AREA` (face regions); Legacy/RootsMagic `_TYPE`/`_PRIM`/`_SCBK`; Ancestry `_CROP`/`_WDTH`/`_HGHT`.
- **Name-variant long tail:** `_FORMERNAME` (619), `_OTHN`, `_FARN` (farm/vulgo name — BK, meaningful in Slovenian genealogy), `_SHON`, `_MARN`, `_CURN`, `_RNAME`, `_INDG`, `_ADPN`, `_RUFNAME`/`_CALL` — one-line additions to `nameVariants`.
- **Software-internal noise:** `_UPD` (160k last-updated stamps ≈ `CHAN`), `_PROJECT_GUID`, `_RINS`, `_RTLSAVE`, `_COLOR*`, `_FLGS`/`__FLAG_n`, `_WT_USER`, MacFamilyTree template machinery (`_STE`/`_PTE`/`_FOM`/…). **Privacy leaks the scrubber misses:** MyHeritage `_PUBLISH._USERNAME` (e-mail addresses), Ancestry `_USER`/`_ENCR` (auth tokens).
- **Preserve-only (don't build):** RootsMagic/MacFamilyTree source templates, PAF `_EVENT_DEFN`, FH root `_PLAC` place dictionaries (46.5k), `_SHAN`/`_SHAR` witnesses — already round-trip losslessly; ~1–2 files each.

### Phases (priority order)
1. **Vendor-tag dictionary + health-check classification** *(small; foundation)* — a registry (`src/gedcom/vendorTags.ts`): tag → software, meaning, category (`identity | family-status | event | attribute | name | media | citation | internal | privacy-sensitive`). Health check shows classified labels ("MyHeritage internal", "Brother's Keeper: funeral event") instead of a bare inventory; privacy scrub gains `_USERNAME`, `_USER`/`_ENCR`, `_WT_USER`.
2. **Standard-attribute lift + BK events** *(serves 80% of the corpus)* — surface `REFN` as a compare/edit field; generic attribute rows for `TITL`/`DSCR`/`RELI`/`NATI`/`GRAD`/`NCHI`/`FACT`+`TYPE`; correct `EVEN`+`TYPE` labeling; add `_INTE`/`_FNRL`/`_MILT`/`_MEDC` to the event registry as displayable, mergeable events (en+sl labels).
3. **Family status & pedigree normalization** — normalize `_FREL`/`_MREL`→`PEDI`, `_SEPR`→`SEPA`, and the BK/MyHeritage/FTM unmarried-partner encodings into one internal family-status field; report in `NormalizationReport`, show on the family panel, compare in review rows.
4. **`_UID` identity matching** — parse `_UID`/`UID` at INDI level; equal UIDs auto-suggest a certain match (pre-gate, before scoring); preserve/unify UIDs on merge. Verify per MATCHING.md protocol.
5. **Media metadata + noise suppression** — `_PRIM`→primary-photo ordering; `_POSITION`/`_CUTOUT`→crop model; `_SEQ`→order; `_KEYS`→keywords; suppress `internal`-category tags from review diffs; "strip software-internal tags" option in bulk normalize; `_UPD`→`CHAN` mapping.

*(Scan tooling: `scan_gedcom.py` / `aggregate.py` / `per_software.py` from the 2026-07-13 session scratchpad; rerun against the index input dir for updated counts.)*

## Refactoring backlog (from the 2026-07-12 whole-project review)

Prioritized technical-debt items from the full code review. None changes behavior on its own; pay down opportunistically as features touch the same files.

### Correctness edges (small, do first when nearby)
*All five fixed 2026-07-12: shadowed duplicate-xref records dropped from `records[]`; leading-`@` values escaped as `@@` on output (folded back on parse); `/` in name parts replaced with a space, and the trailing token after the surname kept (suffix — or given for surname-first `/Novak/ Janez` values); `onerror`/`onmessageerror` on both workers fail the waiting slots/scans instead of spinning; level-jump lines clamp to the deepest open node instead of reparenting to top level.*

### Duplication that will drift (low effort, medium payoff)
*All four resolved 2026-07-12: `src/gedcom/eventTags.ts` is now the single source of event-tag sets and life-cycle ordering (builder/chanCrea/editReport/edit child orders, review `EVENT_ORDER` and editConstants `EXTRA_EVENT_ORDER`/`FAMILY_EVENT_TAGS` all derive from it); `SAME_PERSON_GIVEN`, `differentGiven` and the parent-verdict predicates (`fatherGivenVerdict`/`motherGivenVerdict`/`parentsVerdict`) live once in `match/similarity.ts`, shared by the engine, the within-file duplicate finder and the pair scorer; `eventUpdateHasContent` extracted in `edit.ts`. The event-ordering item turned out to be already shared — `merge/applyFields.ts` imports `lifespanAnchors`/`zoneSortKey` from `review/fields.ts`; only intentionally-different tie-break glue remains at the two call sites. Noted while at it: an INDI-level `MARR` is shown by the Edit view (`INDI_EVENT_TAGS` includes MARR) but not diffed by `editReport.ts` — pre-existing, unchanged.*

### God-file decomposition (mechanical, high maintainability payoff)
- ~~**`src/ui/ToolsView.tsx` (~2.5k lines)** → per-panel files under `src/ui/tools/`; panels are already self-contained, near-pure code motion.~~ *(done 2026-07-12 — seven panel files + `tools/shared.tsx`; ToolsView.tsx keeps the tab shell + scans cache)*
- ~~**`src/gedcom/edit.ts` (~1.2k lines)** → split along its existing banner sections into `edit/{events,names,family,media,sources,cache}.ts`.~~ *(done 2026-07-12 — `src/gedcom/edit/` package: `shared` (child orders + node plumbing), `events`, `names`, `family`, `records` (notes/links), `media`, `sources`, `cache`, with an `index.ts` barrel preserving the exact public API so no importer changed)*
- ~~**`src/App.tsx` (~2.4k lines)**: collapse the six near-identical tool-fix callbacks into one `applyToolPatches` helper; extract a `useWorkspacePersistence` hook (hydration + debounced writer + persist toggle, ~300 cohesive lines) and a `useAppHistory` hook (overlay/history state machine). Also finish the started workspace-reducer migration rather than restructuring around it.~~ *(done 2026-07-12 — App.tsx 2364→1871 lines: `applyToolPatches`, `src/ui/useAppHistory.ts` (overlays + popstate + leave guards), `src/persist/useWorkspacePersistence.ts` (hydration + debounced writer + toggle + verify). The reducer migration turned out to be already finished — UI-local state stays in useState by the store's own charter; the stale App comment saying otherwise is fixed.)*
- ~~**`review/fields.ts` (~1.2k lines)**: split `individualFieldRows` (~190 lines) into `buildEventRows` / `buildParentRows` / `buildFamilyRows`; consider typing the stringly `row.key.split(".")` dispatch in `merge/applyFields.ts`.~~ *(done 2026-07-12 — the three builders extracted (the byte-identical MARR block folded into the ENGA/SEPA/DIV family-event loop while at it), and `applyFields.ts` now parses row keys once via `parseEventRowKey` into a typed `{ tag, sub: EventSubField, eventKey }`)*

### Scale / performance (as large-file usage grows)
- **Virtualize the long lists** — match results, health-check issues, place/source trees all render every row (the duplicates list now caps at the top 200 as a stopgap, 2026-07-12).
- **Memoize EditView subsections** (event rows, family grids) so a `tick` bump doesn't rebuild the whole subtree — do *not* rewrite its in-place-mutation model; the undo-patch machinery depends on it.
- **O(N²) patterns in `edit.ts`**: `pruneUnreferencedMedia`/`pruneUnreferencedSource` DFS the whole dataset per removal; `nextXref` rescans all records per allocation. Reference-count / cache a max-xref counter.
- **Explicitly not worth it**: SharedArrayBuffer for the dataset (needs a columnar rewrite + COOP/COEP headers that break subpath hosting); wholesale EditView immutability rewrite; touching `src/chart/` (cleanest layer in the app).

### Test / CI hardening
- ~~**Four e2e specs depend on gitignored `test-data/Senen.ged`** (`edit`, `export-pdf`, `global-search`, `add-relative` specs) — broken in any fresh checkout/CI; commit an anonymized e2e fixture (the corpus anonymizer already exists) or add skip guards.~~ *(done 2026-07-12 — the four specs load the already-committed anonymized Senen slice `src/__fixtures__/corpus/reunion-5.5.1-utf8.ged` (377 people, pseudonymized names, dates intact); global-search assertions retargeted to the pseudonyms ("Marta3 Karel2 Moharič" b. 1934). Full e2e passes with no `test-data/` present.)*
- **e2e tests the dev server, not the build**: point Playwright's `webServer` at `npm run preview` in CI and add a PWA/service-worker smoke spec (currently zero automated coverage of the offline/update flow).
- Dedicated unit tests for the highest-value untested modules: `tools/validate.ts`, `match/scoreIndividual.ts`, `merge/applyRelations.ts`, `normalize/date.ts`/`place.ts`; property-based round-trip fuzzing of the parser (fast-check); a `vitest bench` perf floor for `matchDatasets`.

