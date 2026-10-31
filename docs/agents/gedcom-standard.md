# GEDCOM standard compliance (target formats)

Moved from AGENTS.md. Read it before writing code that creates, rewrites, offers, checks or normalizes GEDCOM lines.


GED Merge reads anything. What it writes follows the main file's **target format**, chosen per main file. Every feature that creates, rewrites, offers, checks or normalizes GEDCOM lines takes the target format into account. The review of 2026-10-24 found most violations in code written before these rules existed. When you touch such code, bring it into line rather than copying its pattern.

**The three target formats.**
- **Master file:** respect the file's own format, even where it is not compliant. This mode is for files that another genealogy program keeps writing with its own habits (MacFamilyTree's bare `NOBI`/`LATR`/`DEED`, `PRIV`, numeric dates…), which GED Merge must not break.
- **GEDCOM 5.5.1:** strict 5.5.1, the last official 5.x. 5.5.5 is a community revision, not a target.
- **GEDCOM 7.0:** strict 7.0, the current FamilySearch release (patch releases 7.0.x clarify it; files declare `VERS 7.0`). 7.1 is unreleased and is not a target until FamilySearch publishes it.

**The target format is part of the main file's settings.**
- It is stored with the main file in IndexedDB, not in the global AppSettings, so two files can follow different targets.
- On first open the app proposes one. It proposes Master file when the file shows a recognised vendor dialect, or many deviations of the same kind; otherwise it proposes the strict mode for the file's declared version. It says which it chose in one line, and the choice can be changed in Settings.
- Switching from Master file to a strict mode offers to run Normalize, in one step.
- The format choices in Settings → formats belong to the same per-file settings. In a strict mode, only choices valid in that version are offered (no numeric date patterns, no `PRIV` marker, no vendor source fields).

**What each mode does.**

| | Master file | GEDCOM 5.5.1 / 7.0 |
|---|---|---|
| New lines are written in | the file's dialect, where the file shows one; otherwise the standard form | strict form of that version |
| Dates are written | in the file's date style | **always in the GEDCOM date grammar** (`D MON YYYY`, uppercase months, standard qualifiers, calendar escapes, 7.0 `PHRASE`) |
| Menus and pickers offer | standard items, plus the dialect's own tags, marked | that version's standard items, plus `_` extensions, marked |
| The health check | reports every deviation from the declared version; items belonging to the recognised dialect are grouped as the program's dialect | reports every deviation |
| Normalize fixes | real errors only, and keeps the dialect | everything, to that version |
| Save writes | the file's own version, dialect kept | that version, converting the file when it was in the other one |
| An incoming compare file is reshaped | into the master's dialect | into that version |

**What counts as a dialect.** A dialect is a consistent habit that a known program writes, recorded in `VENDOR_TAGS`/`vendorTags.ts` and the format detection: bare vendor tags, numeric dates, `PRIV`, vendor source fields, record-level `WWW`. Everything else is an **error** in every mode, and Normalize fixes it even in Master file mode: dangling pointers, one-way links, unparseable dates, out-of-range enumerations (`QUAY 4`), a missing required `FORM`, wrong case on a standard tag. Master file mode copies only habits the file actually has. Where the file shows no habit, it writes the standard form, so the mode never adds a *new* kind of non-compliance.

**The target is a parameter, not a habit.**
- Writers receive the target (mode + version + the file's dialect) explicitly.
- Never re-read HEAD in a helper (`isV7(records)`), and never let a count of the file's lines (`prefersMimeForm`, "the main's last tag, else the incoming's") decide anything in a strict mode.
- Inside the normalize/merge path the target is the **main** file's, never the compare file's.
- One helper next to the spec tables answers "may I write this here?" In a strict mode it answers from the standard alone; in Master file mode, from the standard plus the file's dialect.

**Strict modes: the output is valid in its version.**
- A line the app writes or rewrites must be valid for the target version: allowed under its parent, within cardinality, with the right payload kind (none / `Y` / text / pointer to the right record type) and enumeration spelling. This covers the editor, merge, Tools passes, health-check fixes, CSV import and version conversion.
- Enumerations follow the version's case and value set: RESN is lowercase in 5.5.1 and an uppercase list in 7.0; PEDI, FAMC.STAT, MEDI, ROLE, NAME.TYPE and QUAY likewise. A 7.0 value outside the set becomes `OTHER` + `PHRASE`.
- Prefer the version's standard form over an extension: in 7.0 that means `EXID` over `_FID`/`_FSFTID`, `UID` over `_UID`, and `NAME` + `TYPE MARRIED` over `_MARNM`.
- Every 7.0-only structure (`SNOTE`, `EXID`, `UID`, `CREA`, `NO`, `SDATE`, `TRAN`, `PHRASE`, `MIME`, `CROP`, `INIL`, `@VOID@`, `SEX X`, event `TIME`) needs a stated 5.5.1 form. The reverse holds for 5.5.1-only structures (`ROMN`/`FONE`, `RFN`/`RIN`/`AFN`, inline `OBJE`, text `SOUR` citations, `NOTE` records, `SUBN`, `CONC`).
- Converting between versions (`convertVersion` → `migrateVersion`) produces a file valid in the target version. A structure with no counterpart becomes a `_` extension, or a NOTE when its text is the point; it is never left in the source version's form. Every rewrite is listed in the conversion report.
- Invalid input the user never touched may stay as read until Normalize runs, for losslessness. The health check reports it, and the save preview says how much remains and offers the fix.

**Every download goes through one path.** Save, privacy export, branch export, Tools → Normalize, and any new export use `prepareDownload` in `src/save/outputFile.ts`, then `serializeGedcom` with `outputOptions`. Never serialize a download by hand: that skips the HEAD/GEDC/CHAR/SUBM/TRLR repair, the HEAD.SOUR stamp and HEAD.SCHMA. This holds in every mode; the file-level structure is always made valid.

**Extension tags.**
- In a strict mode an extension tag always starts with `_`. A bare vendor tag (`RACE`, `NOBI`, `LATR`, `DEED`, `ILL`, `PRIV`, `SEPA`, `PERI`, `FILN`, `EDTN`, `WWW` on a record…) is never written: use the `_` form, or the standard structure that carries the meaning. In Master file mode a bare vendor tag is written only when the file's dialect already uses it.
- In 7.0 every `_` tag is declared in HEAD.SCHMA (`writeSchema`) and written uppercase. 7.0 tags are `[A-Z0-9_]`, so clear `GedNode.spelling` when writing 7.0.
- A FamilySearch-registered tag (`gedcom/extensionRegistry.ts`) gets the registry's URI. Any other tag gets a GED Merge terms page (`gedcom/extensionTerms.ts`, served under `gedmerge.com/terms/`). A tag GED Merge starts writing needs its terms page in the same merge, and that page must be live on production before files declaring it ship.
- Don't invent an extension where a standard structure exists: a media description is a `NOTE`, a filing number is `REPO.CALN`, a source's agency is `DATA.AGNC`.

**One source of truth for the standard.**
- `src/tools/conformance/spec70.ts` and `spec551.ts` hold which tags exist, where, how often, with which payload and enumeration.
- `spec70.ts` is generated by `scripts/gedcom7-spec-table.ts` from a **pinned FamilySearch/GEDCOM release tag** (e.g. `v7.0.18`), never from `main`, which carries 7.1 work. The generated file records the tag it came from. Moving to a newer 7.0.x is a deliberate regeneration reviewed as its own change.
- Do not add another hard-coded list of tags, enum values or "is this standard?" predicates. Several already exist (`KNOWN_TAGS`, the event-order lists, `NAME_TYPES_*`, `STAT_ENUM`, the PEDI list in `migrate.ts`, `QUAY_VALUES`, …) and are being folded into the tables.
- New code asks the tables, through a helper next to them when one is missing. `VENDOR_TAGS` supplies labels, the owning program (the dialect) and standard equivalents for extensions; it never decides what is standard.

**The UI shows what is standard.**
- Pickers (add event/attribute, name type, media format, privacy, ASSO role, PEDI, QUAY, sex …) list what the target allows, read from the spec tables.
- Extensions and dialect tags appear in a separate, visibly marked part of a menu.
- A feature the version cannot carry is hidden, or says why it is unavailable. It never silently writes an extension.
- Every non-standard tag is visibly marked wherever it is shown (Edit rows, menus, chips, merge review, charts, reports, health check). The marks are the ◦ glyph and the "(TAG)" suffix, through `eventDisplayLabel` / `eventGlyph` in `gedcom/eventTags.ts`. Never index `EVENT_GLYPHS` directly or keep a local label list.

**The health check knows the standard and repairs it.**
- Every standard rule a writer obeys is also a health-check rule, checked against the file's **declared** version's table, never a union of versions. That means tags from the other version, bare vendor tags, `_` tags with a standard equivalent in this version, payload kind, empty pointers, cardinality, enumerations, value grammars (DATE, AGE, LANG, MIME, URI, LATI/LONG) and reciprocal links from both sides.
- Dates are judged against the GEDCOM date grammar, never against the file's own style.
- Offer an auto-fix wherever the repair is mechanical. Build it on the conversions `migrate.ts` already has rather than writing a second implementation.
- A fix must write valid lines for the target, be idempotent, run through `applyPassSafely` as one undo step, and not create a finding that another fix undoes (no ping-pong).
- Prefer repairing over deleting. A one-way link gets its missing back-pointer; a dangling 7.0 pointer that carries detail becomes `@VOID@`.
- A problem only the save repairs (header, trailer, SCHMA) is shown as "repaired on save", not hidden.

**Merging and importing keep the main's target.**
- Compare-file content is migrated to the main's version and reshaped to its target before it is copied.
- Copied records get a fresh xref whenever theirs is not valid for the target version (7.0: `@[A-Z0-9_]+@`, not `@VOID@`; 5.5.1: at most 20 characters between the `@`s).
- Unparsed (`verbatim`) lines are not carried from one file into the other.
- Pointers stay reciprocal on both sides.

**Test it like the standard would.**
- A new writer, fix or conversion gets a unit test that runs its output through `validateConformance` in the strict 5.5.1 and 7.0 modes and asserts that it adds no finding. Where its Master file behaviour differs, a test also shows that it copies the dialect it was given.
- A new health-check rule gets one negative fixture per violation class, so a lenient table entry can't slip back in.

**Performance on 500k-person files.**
- No `records.find(...)` per item inside a loop over people, citations or links: build an xref index once, or use the dataset's own maps.
- Walk the tree once per pass, keeping ancestors on a push/pop stack rather than copying an array per node.
- Allocate xrefs from one counter per prefix.
- Batch new records into place instead of calling `insertRecord` per record.
- Group repeated health-check findings (count + samples), and compute counts in the worker.

