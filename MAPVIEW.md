# Map View — design

Plot the events of a GEDCOM file on a map: where people were born, married,
lived, died, and are buried; how individuals and families moved over time. This
document is the agreed design for the feature; implementation happens in phases
(each independently shippable) tracked at the bottom.

Related ideas in [IDEAS.md](IDEAS.md): *Map view*, *Place gazetteer
standardization*, *Living persons privacy*. The 2026-07-13 MacFamilyTree audit
note — place coordinates (`MAP`/`LATI`/`LONG`, `_GEO`) "feed the Map-view idea"
— is the starting point.

## Goals

- A **map chart kind** in the Charts hub showing event locations for the whole
  file, a branch, or a single person, with low-clutter cartography.
- **Migration paths**: a person's life path (birth → residences → death) and,
  later, family dispersal lines.
- **A time dimension**: filter by year range and (later) overlay historical
  maps appropriate to the period being viewed.
- **Geocoding as curation**: a Tools-tab flow that resolves place strings to
  coordinates with user review, and **writes results back into the GEDCOM** as
  standard `PLAC.MAP.LATI/LONG` — the file stays the source of truth.
- Preserve the app's model: browser-only, no backend, nothing leaves the
  device unless the user opts in.

## Non-goals

- No bundled global gazetteer (users import the country extracts they need).
- No automatic (unreviewed) batch geocoding — wrong pins are worse than none.
- No editing of places *on* the map (the Edit view and the Tools place tree
  already own that).
- SVG export of the map (raster tiles don't fit the existing SVG pipeline —
  see Export below).

## Constraints that shape the design

1. **Privacy.** Tile requests reveal the viewed region to the tile provider;
   online geocoding sends ancestral place names to a third party. Both are
   **opt-in**, mirroring the link-fetch relay precedent. The offline gazetteer
   path is the privacy-clean default. The map honors living-persons hiding.
2. **Scale.** Index-scale files (≈500k people) mean hundreds of thousands of
   events. Marker clustering and coarse filtering are phase-1 requirements,
   not polish.
3. **Licensing.** `tile.openstreetmap.org` disallows app embedding; CARTO
   basemaps are free for non-commercial use with attribution; GeoNames is
   CC-BY; Nominatim's policy caps at 1 req/s. Attribution is rendered on the
   map; exact terms re-verified at implementation time (see Appendix).
4. **Bundle size.** The map library and all map UI load as a lazy chunk; users
   who never open the map pay nothing.

## Architecture

New modules, following the existing pure-data / React split:

| Path | Responsibility |
|------|----------------|
| `src/geo/` | Pure geo data: coordinate extraction from the dataset, event→point projection, clustering input prep, gazetteer lookup, geocode candidate scoring. No React, no Leaflet. |
| `src/ui/map/` | React components: `MapPage` (hub kind), layer/filter controls, geocode review dialog. Owns the Leaflet dependency. |
| `src/tools/geocode.ts` | Tools-tab batch geocode pass (pure planning + patch emission, like other tools). |

The Leaflet instance is encapsulated in one component; everything above it
works on plain `{ lat, lon }` data so `src/geo/` is unit-testable like
`src/chart/`.

### Data model

`GedPlace` (in `src/gedcom/types.ts`) gains optional coordinates:

```ts
interface GedPlace {
  raw: string;
  parts: string[];
  detail?: string;
  coord?: { lat: number; lon: number };   // from PLAC.MAP.LATI/LONG
}
```

- `parsePlace` stays string-only; coordinate lifting happens where the `PLAC`
  *node* is available (the event builders in `src/gedcom/builder.ts`), reading
  the standard `MAP` → `LATI`/`LONG` children (GEDCOM `N48.2325`/`E14.1234`
  format, plain decimal, and webtrees' `N46::3::19"` DMS form). MacFamilyTree's
  `_GEO` turned out to be a GeoNames place *id*, not a coordinate — useful for
  the phase-2/4 gazetteer work, not for direct plotting.
- **Precision** is tracked per point, derived from how the coordinate was
  obtained: `exact` (house/address), `locality`, `region`. Geocode write-backs
  record the level; coordinates read from the file default to `exact`.
  Rendering differs (sharp pin vs. soft/haloed marker).
- An **event→point projection** (`src/geo/points.ts`) walks the dataset once
  and yields `{ personId, eventTag, year?, place, coord?, precision }` rows —
  the single input for the map, the coverage stats, and the geocode work list.

### Write-back, not a side database

Geocoding results are applied through the existing edit pipeline
(`RecordPatch` + `rebuildIndividual`/`rebuildFamily`), inserting standard

```
2 PLAC Zgornje Bitnje, Kranj, Slovenija
3 MAP
4 LATI N46.2247
4 LONG E14.3400
```

so they persist in the saved file, survive round-trips, benefit other
software, and participate in undo/redo. Identical place strings share one
lookup, but each `PLAC` node gets its own `MAP` (GEDCOM has no shared place
records in 5.5.1). An IndexedDB **lookup cache** (place string → accepted
coordinate) avoids re-resolving the same string across files and sessions —
it is a cache, never the store of record.

## Base map

- **Library: Leaflet** (lazy chunk, ~42 KB gzipped). MapLibre GL was
  considered and rejected for now: ~10× the size, and its advantages (vector
  styling, smooth raster reprojection) only matter for the historical-overlay
  polish in phase 4. Revisit then if needed.
- **Default tiles: CARTO Positron** (light) / **Dark Matter** (dark theme) —
  the low-clutter style requested; both match the app's theme toggle.
- **Custom tile URL** in Settings (Display tab): any XYZ template, for users
  who self-host or prefer another provider. Same philosophy as the
  configurable link-fetch relay.
- **Attribution control** always visible (OSM data credit + provider credit).
- **Offline fallback:** a bundled, simplified Natural Earth country-outline
  GeoJSON (public domain, ~100–200 KB in the lazy chunk) renders as the base
  layer when tiles are unavailable (offline PWA use, or tiles not yet
  opted-in). Pins are never floating in a void.
- **Tile opt-in:** the first visit to the map shows the outline fallback plus
  a one-time notice ("Load map tiles from CARTO? Requests reveal the viewed
  area to the provider") with a remembered yes/no; changeable in Settings.

## Filters, time, and paths

Map-page controls (persisted like other chart settings):

- **Scope**: the root person's branch via the *shared hub
  Ancestors/Descendants toggle* (the same control and state as the pedigree
  charts and the report — decided 2026-07-17). No whole-file scope in the
  hub chart: a per-person chart plots that person's branch; if a whole-file
  places view is wanted later, it belongs in the Tools tab ("Places"),
  alongside the other whole-file tooling.
- **Event kinds**: birth/baptism, marriage, death/burial, residence, other —
  toggleable chips, color-coded by event kind (tokens: new `--map-*` family,
  defined in both themes).
- **Year range**: a two-ended slider (bounds from the file's lifespan data).
  Events without dates are shown/hidden via an "undated" toggle.
- **Person paths**: selecting a person draws their life path — chronological
  polyline birth → …residences… → death, arrowheads showing direction. In the
  hub's single-person scope, paths can be shown for the whole displayed set
  (e.g. all descendants), which is the "family dispersal" picture.
- **Clustering**: point clustering at low zoom with count badges; clicking a
  cluster zooms in; at high zoom, markers open a small person/event popover
  with `PersonLink`s into the Edit view.

## Geocoding

Sources, in lookup order:

1. **Coordinates already in the file** (`MAP`/`LATI`/`LONG`) — free,
   no lookup, plotted immediately. This alone makes phase 1 useful.
2. **IndexedDB cache** of previously accepted resolutions.
3. **Offline gazetteer: GeoNames country extracts** (CC-BY). The user
   downloads e.g. `SI.txt`, `AT.txt`, `HR.txt` from geonames.org and imports
   them via the Tools tab; parsed rows (name, alt names, admin hierarchy,
   lat/lon, feature class, population) land in IndexedDB. Matching uses the
   existing place machinery: `PlaceComponents.locality` + jurisdiction parts +
   the diacritic-tolerant name similarity from `src/match/`. Slovenia-focused
   note: GeoNames' alternate-names table carries German/Italian exonyms
   (Laibach/Ljubljana), which these datasets need.
4. **GOV — Genealogisches Ortsverzeichnis** (genealogy.net), opt-in, online:
   the genealogy-specific gazetteer with *time-valid* jurisdictions and
   multilingual historical names. Used for lookups the offline set can't
   resolve and for enriching accepted matches with a GOV id (stored as the
   place `NOTE`/`_GOV` — exact tag decided at implementation against corpus
   conventions).
5. **Nominatim** (opt-in, online, ODbL, throttled to its 1 req/s policy) for
   street-address-level strings the gazetteers don't cover.

### Review flow (Tools tab: "Geocode places")

Same UX family as Organize sources:

- A scan lists distinct place strings (grouped via the existing
  place-hierarchy pass in `src/tools/places.ts`) with event counts, current
  coordinate status, and a proposed candidate per string with a confidence
  score (name similarity × jurisdiction agreement × feature class).
- Per row: **accept** / pick an alternative candidate / mark "no match" /
  skip. High-confidence rows can be bulk-accepted, but acceptance is always an
  explicit user action.
- Accepting emits patches (write-back above); the summary reports how many
  `PLAC` nodes were updated. Undo/redo covers the whole batch.
- A **coverage line** ("1,204 of 1,850 place strings resolved; 231 events
  undated") doubles as the source-coverage-style health signal.

## Historical maps ("person time map")

No freely-embeddable tile source covers the key layers for Slovenian research
(Arcanum/Mapire's Habsburg surveys are subscription-licensed), so the design
is **bring-your-own layers plus curated presets**:

- Settings holds a list of **overlay layers**: display name, XYZ/WMTS URL
  template, valid-year range, attribution, max zoom. Users with an Arcanum (or
  other) subscription paste their tile URL; archives increasingly publish WMTS.
- A small **curated preset list** ships with layers whose licenses permit
  embedding (candidates: David Rumsey georeferencer exports, Wikimedia Map
  Warper maps; verified individually before inclusion).
- On the map, an **overlay picker** shows the configured layers with an
  opacity slider; layers whose year range intersects the current time-slider
  range are suggested (subtle highlight), which is the "show the map of the
  person's time" behavior — driven by data, hardcoding no provider.

## Privacy

- Tiles and online geocoding (GOV, Nominatim) are **off until opted in**, each
  with a one-line explanation of what leaves the device. Offline gazetteer and
  in-file coordinates work with no network at all.
- The map respects the **living-persons** display setting: hidden persons
  contribute no markers, no popovers, no paths. (IDEAS priority #3 — the
  global toggle — should land first or together with phase 1; the map simply
  consumes it.)
- Exported PNGs contain whatever the user chose to display; no extra handling.

## Export

Phase 1 ships **PNG snapshot** export (canvas composition of tiles + markers;
tile-provider terms permit personal export with attribution burned in) via the
existing `ChartExportMenu`, plus the standard **GEDCOM branch export** which
needs no map-specific work. SVG export is explicitly out (raster tiles), and
the outline-fallback SVG case isn't worth a separate pipeline.

## i18n

All UI strings in `en` + `sl` from the start, as usual. Event-kind names reuse
the existing event vocabulary; new keys under `map.*`.

## Performance notes

- The event→point projection is one dataset walk, memoized per
  `mainLoadGen`/edit tick like other derived views; per-record state keys on
  `mainLoadGen` (stale-reload rule).
- Clustering runs on the projected points (a supercluster-style grid index in
  `src/geo/`, no worker needed initially — 500k points cluster in tens of ms;
  move to `tools.worker.ts` only if profiling says so).
- Marker rendering is canvas-based (Leaflet canvas renderer), not DOM markers.
- Gazetteer import parses in the worker (files are tens of MB); lookups are
  indexed queries against IndexedDB.

## Phases

1. **Map page + in-file coordinates.** Lift `MAP`/`LATI`/`LONG` into
   the model; hub kind `map` (digit 8) with Leaflet, CARTO/custom tiles,
   opt-in + offline fallback, clustering, scope/event/year filters, popovers,
   PNG export, en+sl. Useful immediately for files that carry coordinates.
2. **Geocoding.** GeoNames import (worker) + IndexedDB store/cache; Tools-tab
   "Geocode places" review flow; write-back patches; coverage line. Optional:
   Nominatim opt-in for addresses.
3. **Time + paths.** Year-range slider; person life paths and displayed-set
   dispersal lines; path styling and direction.
4. **Historical overlays + GOV.** Overlay-layer settings + curated presets +
   year-range suggestion; GOV lookup/enrichment. Revisit MapLibre if overlay
   blending demands it.

Each phase: typecheck + lint + vitest for the pure `src/geo/` logic, changelog
entries on merge, dev-server validation per the standard workflow.

## Open questions

- ~~Marker color semantics~~ **Decided 2026-07-17: by event kind**, with the
  existing `--sex-*` tokens used inside popovers only.
- ~~"No match" persistence~~ **Decided 2026-07-17: IndexedDB cache only** —
  never written into the file.
- GOV id storage tag (`_GOV` is used by some German programs — check the
  corpus scan before inventing anything).
- Does the Compare Tree ever need a map (compare-file places on the same
  map)? Out of scope until asked for.

## Appendix: licensing summary (re-verify before each phase ships)

| Component | License / terms | Notes |
|-----------|-----------------|-------|
| Leaflet | BSD-2 | bundled, lazy chunk |
| CARTO basemaps | free for non-commercial, attribution required | default tiles, opt-in |
| OSM data | ODbL | attribution via tile credit |
| `tile.openstreetmap.org` | **not usable** — policy disallows app embedding | hence CARTO default |
| Natural Earth | public domain | bundled offline outline |
| GeoNames extracts | CC-BY 4.0 | user-downloaded, imported locally |
| GOV (genealogy.net) | API, terms to confirm | opt-in online |
| Nominatim (osm.org) | ODbL data; usage policy: 1 req/s, no bulk | opt-in online, throttled |
| Arcanum / Mapire | subscription | never bundled; user-supplied URL only |
| David Rumsey / Map Warper | per-map (often CC-BY-NC) | curated presets, verified per layer |
