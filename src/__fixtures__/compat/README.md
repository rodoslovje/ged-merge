# Byte-level compatibility fixtures

Small GEDCOM files that reproduce, byte for byte, the damage real exporters
leave in a file — shapes the line-based anonymizer (`../corpus/`) cannot keep.
Each was found in the genealogical-index corpus (279 files) in the sweep of
2026-11-06; every name is a pseudonym from `../pseudonyms.ts` and every text is
invented.

Generated — **do not hand-edit**. Regenerate with:

```bash
node scripts/compat-fixtures.ts
```

| File | Exporter | What it reproduces | Seen in |
|------|----------|--------------------|---------|
| myheritage-raw-breaks-utf8.ged | MyHeritage | a DSCR with bare LF line breaks inside a CRLF file; "š" split across CONC; a CONC holding U+2028; `_MARNM` listing spellings with slashes | Šterman, Ravnik-MA, Ivanc, Novak |
| myheritage-stray-cp1250-utf8.ged | MyHeritage | `CHAR UTF-8` with a few Windows-1250 bytes (Ž, en dash); "č" split across CONC | Ivanc |
| brotherskeeper-broken-name-w1250.ged | Brother's Keeper | a NAME broken over three physical lines | Novaković |
| brotherskeeper-ansel-label-w1250.ged | Brother's Keeper | `CHAR ANSEL` over Windows-1250 bytes | 17 of the 18 ANSEL files |

`../compat.test.ts` reads each one with every letter intact and no line left
unparsed, round-trips it, and saves it as 5.5.1 and 7.0 into a file that reads
back and saves again unchanged.
