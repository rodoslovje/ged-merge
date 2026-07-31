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

## Bugs

### "One sheet" prints cut off on Android (reported 2026-07-31)

On Android (reported in Brave), choosing the **One sheet** print size does not
shrink the chart onto the page — it crops it. The system print *preview* shows
the whole diagram on one page correctly; the PDF that gets saved is cut.

Suspected cause: `printSheetSet` in `src/ui/exportSvg.ts` lays each sheet out at
an exact pixel size and pins the paper with `@page { size: <w>px <h>px;
margin: 0 }`, with `.gm-sheet { overflow: hidden }` and no shrink-to-fit. Chromium
on Android takes its page size from the Android print framework's paper picker
and does not honour a custom `@page size`, so the sheet div is laid out for a
page of one size and rasterized onto a page of another — and because the excess
is clipped rather than scaled, the difference shows up as a crop. That the
preview looks right while the saved PDF does not suggests the preview and the
final rasterization resolve the page box differently.

Worth checking before fixing: whether the same happens in Chrome for Android
(i.e. whether it is Chromium-wide or Brave-specific), and on iOS Safari.

Possible fixes: express the sheet in physical units (`mm`/`in`) instead of `px`
so it scales with whatever page the platform hands us; or drop `@page size`
entirely on mobile and let the sheet fill `100%` of the page box; or build the
PDF ourselves rather than going through the browser print pipeline.

## Features

### Shared-notes sharing UX (Phase C)

Pointer identity of shared notes now survives edits (2026-07-16); what's
missing is the UI that makes *sharing itself* visible and creatable:

- **"×N shared" badge** on a note chip whose record has more than one
  referrer, with a tooltip listing who else uses it and an "edits apply to
  all" hint on the first edit.
- **Detach action** — replace this person's pointer with an independent copy,
  for "change just my copy".
- **"Attach existing note" picker** in the + Add note flow (same pattern as
  Add Source / Add Media) — without it sharing can be preserved but never
  created in-app.
- Related small gaps: only the first NOTE on an event is surfaced/editable;
  merge's `copyNotes` with "incoming" replaces NOTE children wholesale and can
  orphan a main-side shared record; GEDCOM 7 `SNOTE` rename in the 5.5.1⇄7.0
  version migration.

### FamilySearch API integration (major feature)

FamilySearch is the one enrichment site that can never work through the public
relays: it sits behind a login and its pages are client-rendered. The official
platform API with OAuth2 solves both, and unlocks person-level linking.

- **Prerequisite (process, not code):** register GED Merge as a FamilySearch
  developer app (developer account + approval; the registered redirect URL is
  the hosted app origin) to obtain a client key.
- **Sign in with FamilySearch** in Settings — OAuth2 authorization-code + PKCE
  entirely in the browser; the token stays on the device and calls go directly
  browser → `api.familysearch.org` (CORS-enabled), no relay involved, so the
  no-backend / nothing-leaves-your-device model holds.
- **Source enrichment** — resolve ark record links (source descriptions,
  collection titles, citations) and catalog/film metadata through the API,
  feeding the same `ReshapeMeta` pipeline as Matricula/dLib (Organize sources
  "Fetch details" + Add Source).
- **FSID person linking** — individuals already carry FS Tree ids (`_FID`
  MacFamilyTree, `_FSFTID` RootsMagic), used today as an identity pre-match.
  With the API: resolve each FSID to the live Tree person, show a FamilySearch
  chip in Edit view (open on FS; current Tree name/vitals), detect stale ids
  (FS persons get merged/deleted), optionally pull the Tree person into the
  compare slot for a field-by-field merge like a compare file, and write the
  FSID back onto matched persons that lack one.

### Sources
- **Show source images in the Add/edit source dialog** — some sources carry a
  photo/image (OBJE); display it (at least a thumbnail) when adding/editing a
  source so the record page is visible while filling in the fields.

### Tools tab
- **Source coverage report** — which facts / persons have no citation at all
  (extends the existing health check).
- **Place gazetteer standardization** — validate & fix place spelling and
  hierarchy against GeoNames / GOV, beyond the current reshape.

### Reports & charts
- **Report generation depth** — a max-generations setting for the Ahnentafel /
  descendant register (both currently walk the whole tree).
- **Research to-do / log** — per-person open questions, flags, research notes.
- **Map view** — plot birth/death/marriage places (geocoded) and migration
  paths. Designed — see [MAPVIEW.md](MAPVIEW.md) for the agreed phased plan.

### Settings
- **Local media photos in SVG** — choose how to save people's local media photos
  when exporting SVG: embedded in the SVG (current behavior), or as links to a
  configurable URL prefix.

### Import / export
- **GEDCOM 7 + GEDZIP** — read/write GEDCOM 7 and import/export GEDZIP media
  bundles. *(Crop regions already use the GEDCOM 7 vocabulary.)*
- **CSV / JSON export** — export the main file (or a filtered subset) as CSV or
  JSON for spreadsheets and external tools.
- **GEDCOM custom tags support** — phases 1–4 (registry + health-check
  classification, attribute/vendor-event lift, family-status & pedigree
  normalization, `_UID`/`_FID` identity matching) shipped 2026-07-13; phase 5
  (media metadata + noise suppression) remains. See
  [Custom-tag support plan](#custom-tag-support-plan-2026-07-13-corpus-analysis).

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
1. ~~**Vendor-tag dictionary + health-check classification**~~ *Done 2026-07-13: `src/gedcom/vendorTags.ts` (~140 tags, en+sl meanings, prefix families); health check shows classified labels for `_` and bare vendor tags (MacFamilyTree RACE/SECG/…); privacy scrub drops `_PUBLISH` records and `_USERNAME`/`_USER`/`_ENCR`/`_WT_USER`; external-id strip covers `_FSFTID`/`_APID`/`_AMTID`/`_FGRAVE`.*
2. ~~**Standard-attribute lift + BK events**~~ *Done 2026-07-13: REFN/TITL/DSCR/RELI/NATI/RACE/GRAD/NCHI/FACT/NOBI/LATR + `_INTE`/`_FNRL`/`_MILT`/`_MEDC` are first-class events (display/edit/merge, zone-ordered, en+sl); EVEN/FACT headers show their TYPE; vendor-tag-synonym normalization (`_MILI`/`MISE`→`_MILT`); MacFamilyTree SECG folded into the given name when extra.*
3. ~~**Family status & pedigree normalization**~~ *Done 2026-07-13: `normalize/familyStatus.ts` consolidates MyHeritage REL_* events, FTM `_STAT`, lone BK `_NMR` into canonical `_MSTAT` (drops the redundant BK trio companions); `_SEPR`→`SEPA`; agreeing `_FREL`/`_MREL`→FAMC `PEDI` (default birth pairs dropped as noise, mismatches preserved); `_MSTAT` is an editable/mergeable family "Status" event.*
4. ~~**`_UID` identity matching**~~ *Done 2026-07-13: identity pre-match stage (score 100, 🔑, bypasses gates, never displaced) for `_UID`/GEDCOM 7 `UID` **and FamilySearch ids** (`_FID` MacFamilyTree / `_FSFTID` RootsMagic, cross-program); merge carries incoming ids onto the merged record; verified per MATCHING.md (Renko↔Renko-Rakar 5,161 identity pre-matches, strong 8,905→8,932, canary quiet).*
5. ~~**Media metadata + noise suppression**~~ *Done 2026-07-13: `_PRIM`/`_THUM` primary photo leads the tray and picks the person thumbnail; `_SEQ` orders media; `_KEYS` keywords join the description; `_POSITION` reads as a GEDCOM 7-style crop (CROP stays authoritative); `_UPD`→`CHAN` in the vendor-tags pass; opt-in "remove internal software tags" pass in bulk normalize (`normalize/vendorInternal.ts`, never at load time); SaveDialog explains each custom tag and pre-deselects `internal`-category ones.*

*(Also open, noted during the 2026-07-13 MacFamilyTree audit: citation-quality display (`QUAY`/`_QUAL`) on citation chips; place coordinates (`MAP`/`LATI`/`LONG`, `_GEO`) feed the Map-view idea; `_FARN`/`TYPE family` vulgo names as a first-class name-variant kind; `_MARN` full married names left verbatim.)*

*(Scan tooling: `scan_gedcom.py` / `aggregate.py` / `per_software.py` from the 2026-07-13 session scratchpad; rerun against the index input dir for updated counts.)*

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
