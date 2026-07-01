# Anonymized GEDCOM test corpus

Small, privacy-scrubbed slices of **real** GEDCOM exports, used by the
round-trip / decode / normalize regression tests. They deliberately span the
exporter × charset × GEDCOM-version × line-ending matrix so the parser and
serializer are exercised against real-world quirks, not just synthetic strings.

These files are generated — **do not hand-edit them.** Regenerate with:

```bash
node scripts/anonymize-corpus.ts
```

The un-anonymized source files live in `test-data/` (git-ignored, never
committed). `manifest.json` records each fixture's fingerprint and is the list
the tests iterate.

## Fixtures

| File | Exporter | GEDCOM | Charset | EOL | Note |
|------|----------|--------|---------|-----|------|
| ancestry-5.5.1-utf8.ged | Ancestry.com Family Trees | 5.5.1 | UTF-8 | CRLF | |
| rootsmagic-5.5.1-utf8.ged | RootsMagic | 5.5.1 | UTF-8 | LF | |
| familyhistorian-5.5.1-utf8.ged | Family Historian 7 | 5.5.1 | UTF-8 | CRLF | |
| familyhistorian-5.5.1-w1250.ged | Family Historian 7 | 5.5.1 | Windows-1250 (`CHAR ANSI`) | CRLF | |
| brotherskeeper-5.5.1-w1250.ged | Brother's Keeper | 5.5.1 | Windows-1250 | CRLF | |
| brotherskeeper-5.5-w1250.ged | Brother's Keeper | **5.5** | Windows-1250 | CRLF | older GEDCOM 5.5 |
| geneanet-5.5.1-utf8.ged | Geneanet | 5.5.1 | UTF-8 | LF | |
| geneanet-5.5.1-w1250.ged | Geneanet | 5.5.1 | Windows-1250 | LF | |
| gramps-5.5.1-utf8.ged | Gramps | 5.5.1 | UTF-8 | CRLF | |
| myheritage-5.5.1-utf8.ged | MyHeritage | 5.5.1 | UTF-8 | CRLF | |
| webtrees-5.5.1-utf8.ged | webtrees | 5.5.1 | UTF-8 | CRLF | |
| reunion-5.5.1-utf8.ged | Reunion | 5.5.1 | UTF-8 | **CR** | classic-Mac CR-only endings |
| synium-7.0-utf8.ged | Synium MacFamilyTree | **7.0** | UTF-8 | LF | GEDCOM 7.0 |
| unknown-5.5.1-utf8.ged | (none) | 5.5.1 | UTF-8 | LF | `HEAD` with no `SOUR` line |

## What is preserved vs. scrubbed

The whole point of the corpus is format fidelity, so the structural
"fingerprint" is preserved byte-for-byte:

**Preserved** — every tag, record nesting and `CONT`/`CONC` layout; dates
exactly as written; place names & structure (incl. house numbers); source /
citation titles and links (Matricula/Geneanet URLs); original line-endings,
final-newline and **character encoding** (Windows-1250 files stay Windows-1250
bytes, so `decode.ts` charset detection is genuinely tested).

**Scrubbed** (per the agreed *names + free text + contacts* policy):

- personal names on `NAME` / `GIVN` / `SURN` / `NICK` / `_MARNM` / `_AKA` →
  pseudonyms from a fixed vocabulary (`../pseudonyms.ts`). Within a file the same
  real name always maps to the same fake one (family groupings survive); across
  files, each fixture gets a **disjoint block of surname stems**, so two
  unrelated families never share — nor fuzzy-match — a surname. That keeps the
  cross-family precision test (below) honest.
- `NOTE` / `TEXT` free-text narrative → placeholder text
- email / phone / fax lines
- submitter (`HEAD`/`SUBM`) name & postal address
- `OBJE`/`FILE` media paths (often embed a local user directory)

Deliberately **kept** although arguably personal: place names (needed for
place-format tests; geography alone is not identifying) and bibliographic
`SOUR` `TITL`/`AUTH`/`PUBL` (needed for citation-format tests).

Each fixture is sliced to the first ~12–300 individuals plus a capped set of the
records they reference (families, a few sources/media/notes), with dangling
pointers pruned, keeping every file under ~100 KB.

## What the tests do

- **`corpus.roundtrip.test.ts`** — per file: charset/version/line-ending
  detection, serialize idempotency (a stable parse→serialize fixed-point), and
  a **privacy tripwire** asserting every personal-name token comes from the
  fixed pseudonym vocabulary. If a newly-added source ever leaks a real name,
  this fails loudly before the fixture can be committed.
- **`corpus.match.test.ts`** — exercises the real `matchDatasets` engine:
  - *recall* — matching a file against itself must always prefer the identical
    record over a look-alike and re-find nearly everyone;
  - *precision* — matching any two unrelated files yields **no strong match**
    (guaranteed meaningful by the disjoint-surname design above).
