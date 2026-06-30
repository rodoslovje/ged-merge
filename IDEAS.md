# Project Ideas & TODO

A running list of ideas, features, and todos for ged-merge.

## Features

### General Settings panel
Add a general settings area (e.g. in a hamburger menu). Move the existing **language picker** and **theme selector** there, and add further user-configurable settings.

Candidate settings:
- **Name display** — option to append married surname in parentheses `( )` to all displays of a person across the app.
- **Living persons privacy** — option to hide data of living persons throughout the app and in matching.
- **Local media photos in SVG** — choose how to save people's local media photos when exporting SVG: embedded in the SVG, or as links to a URL prefix.

### New Tools (Tools tab)
- **Source reshape** — when the master uses a source+link format, reshape all links into the sources format. Create a source entry from a URL's metadata, or attach the link to an already-existing source. Biggest payoff for **Matricula Online** links, but also **Geneanet Cemeteries**.
- **Matricula Online metadata** — beyond the existing link normalization (language code), extract metadata from the URL and by querying the link (e.g. book name and similar details).
- **Geneanet Cemeteries metadata** — same idea as the Matricula Online metadata feature, for Geneanet Cemeteries links.

### Photos
- **Drag & drop** — improve adding new photos by supporting drag-and-drop.
- **Mark person on a group photo** — UI for marking/cropping a person within a group photo (GEDCOM crop feature).

### GEDCOM custom tags support
Build a system for custom/proprietary GEDCOM tags supported by GED Merge — allow them to be edited and merged, with simple reshaping rules to convert between different supported custom types (e.g. MacFamilyTree extensions). Goal: support all major software, including **Brother's Keeper**, **Family Historian**, **RootsMagic**, and **MacFamilyTree**.

## Suggested (from feature-set analysis)

Ideas surfaced by reviewing the current app. Not yet committed — cull as needed.

### Data quality / health (extends the existing Tools)
- **Chronology sanity checks** — child born before a parent or after a parent's death, marriage after death, implausible parent age at birth, lifespan > ~120 years.
- **Source coverage report** — which facts / persons have no citation at all.
- **Place gazetteer standardization** — validate & fix place spelling and hierarchy against GeoNames / GOV, beyond the current reshape.

### Reports & analysis
- **Ahnentafel / narrative (register) report** — exportable ancestor/descendant report.
- **Statistics dashboard** — surname & place frequency, average lifespan, ancestor completeness by generation.
- **Research to-do / log** — per-person open questions, flags, research notes.

### Visualization
- **Map view** — plot birth/death/marriage places (geocoded) and migration paths.
- **Descendant & classic pedigree charts** — complement the existing fan and relationship charts.
- **Timeline view** — per-person or per-family chronological timeline.
- ~~**Maternal / paternal line color coding**~~ — *Done.* Kinship labels are colour-coded by blood lineage everywhere they appear (person headers, relative cards, tree nodes/titles, relationship chart): royal-blue `--lineage-paternal` for the father's side, purple-magenta `--lineage-maternal` for the mother's side; "both lines" (full siblings), descendants, and the Start Person keep the neutral green accent. Tooltips append the lineage line. When no specific kinship can be named but a blood line still connects the two, a generic "Blood relative" chip carries the lineage. See `bloodLineage()` in [src/match/relationshipPath.ts](src/match/relationshipPath.ts) and `kinshipInfo()` in [src/match/kinship.ts](src/match/kinship.ts).

### Editing / UX
- **Global search & filter** — find individuals across the whole file.
- **Local autosave** — persist work to IndexedDB so a refresh doesn't lose changes; recent-files list.
- **PWA / offline install** — installable, works offline.

### Import / export
- **GEDCOM 7 + GEDZIP** — read/write GEDCOM 7 and import/export GEDZIP media bundles.
- **Subset / format export** — export a selected branch, or export to CSV / JSON.
