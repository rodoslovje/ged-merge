# Project Ideas & TODO

A running list of ideas, features, and todos for ged-merge.

## Features

### Settings
The general Settings panel exists (language, theme, name display, kinship, link-fetch, workspace persistence). Remaining candidate settings:
- **Living persons privacy** — option to hide data of living persons throughout the app and in matching. *(A Tools-tab privacy action that strips living persons already exists; this would make it a global display/matching toggle.)*
- **Local media photos in SVG** — choose how to save people's local media photos when exporting SVG: embedded in the SVG, or as links to a URL prefix.

### New Tools (Tools tab)
- **Source reshape** — when the master uses a source+link format, reshape all links into the sources format. Create a source entry from a URL's metadata, or attach the link to an already-existing source. Biggest payoff for **Matricula Online** links, but also **Geneanet Cemeteries**.
- **Matricula Online metadata** — beyond the existing link normalization (language code), extract metadata from the URL and by querying the link (e.g. book name and similar details).
- **Geneanet Cemeteries metadata** — same idea as the Matricula Online metadata feature, for Geneanet Cemeteries links.

### Photos
- **Drag & drop** — improve adding new photos by supporting drag-and-drop.

### Matching quality
- **Reduce false positives in dense name clusters** — in regions with many people sharing the same/similar names, pairs with the same name and a similar birth date but **different parents** still score too high. Give conflicting parents (and other distinguishing evidence) more weight — ideally a stronger penalty or a soft gate — so same-name/near-date pairs with mismatched families are pushed down.

### GEDCOM custom tags support
Build a system for custom/proprietary GEDCOM tags supported by GED Merge — allow them to be edited and merged, with simple reshaping rules to convert between different supported custom types (e.g. MacFamilyTree extensions). Goal: support all major software, including **Brother's Keeper**, **Family Historian**, **RootsMagic**, and **MacFamilyTree**.

## Suggested (from feature-set analysis)

Ideas surfaced by reviewing the current app. Not yet committed — cull as needed.

### Data quality / health (extends the existing Tools)
- **Source coverage report** — which facts / persons have no citation at all.
- **Place gazetteer standardization** — validate & fix place spelling and hierarchy against GeoNames / GOV, beyond the current reshape.

### Reports & analysis
- **Ahnentafel / narrative (register) report** — exportable ancestor/descendant report. Include a **register report in NGSQ (National Genealogical Society Quarterly) format** for a person's ascendants/descendants, exported as text / RTF (or similar).
- **Research to-do / log** — per-person open questions, flags, research notes.

### Visualization
- **Map view** — plot birth/death/marriage places (geocoded) and migration paths.
- **Descendant & classic pedigree charts** — complement the existing fan, circle, grid and relationship charts.
- ~~**Timeline view** — per-person or per-family chronological timeline.~~ *Done: the Charts hub's Timeline kind (family lifespan bars + event/marriage markers).*

### Editing / UX
- **Global search & filter** — find individuals across the whole file.

### Import / export
- **GEDCOM 7 + GEDZIP** — read/write GEDCOM 7 and import/export GEDZIP media bundles.
- **Subset / format export** — export part of the master as its own GEDCOM (e.g. all ancestors or all descendants of a chosen person) to share with a friend; also export a selected branch, or export to CSV / JSON.

