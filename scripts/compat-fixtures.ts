/**
 * Byte-level compatibility fixtures.
 *
 * `anonymize-corpus.ts` slices real exports through a line model, which keeps
 * a file's structure but not its byte-level damage: a stray Windows-1250 byte
 * inside UTF-8, a character split across a CONC line, a raw line break inside
 * a value. These fixtures reproduce exactly those shapes, as found in the
 * genealogical-index corpus (`srd-data/index/input`, 2026-11-06 sweep), with
 * pseudonyms from `src/__fixtures__/pseudonyms.ts` in place of every real name
 * and invented text in place of every note.
 *
 * Run:  node scripts/compat-fixtures.ts
 * The output is deterministic; `src/__fixtures__/compat.test.ts` reads it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src/__fixtures__/compat");

const utf8 = (s: string) => Buffer.from(s, "utf-8");
/** Windows-1250 bytes for the letters these fixtures use. */
const CP1250: Record<string, number> = { "Š": 0x8a, "š": 0x9a, "Ž": 0x8e, "ž": 0x9e, "Č": 0xc8, "č": 0xe8, "–": 0x96 };
const cp1250 = (s: string) => Buffer.from([...s].map((ch) => (ch.charCodeAt(0) < 0x80 ? ch.charCodeAt(0) : CP1250[ch] ?? 0x3f)));
const bytes = (...parts: (string | Buffer | number[])[]) =>
  Buffer.concat(parts.map((p) => (typeof p === "string" ? utf8(p) : Array.isArray(p) ? Buffer.from(p) : p)));

const BOM = [0xef, 0xbb, 0xbf];
const CRLF = "\r\n";
const lines = (...l: string[]) => l.map((x) => x + CRLF).join("");

const FIXTURES: Record<string, Buffer> = {
  /**
   * MyHeritage, UTF-8 with BOM, CRLF (Šterman.ged, Ravnik-MA.ged, Novak.ged):
   * - a DSCR whose pasted text keeps its own bare LF line breaks, so the
   *   following text sits on lines with no level or tag;
   * - "š" split across a CONC line (lead byte ends one line, its continuation
   *   byte opens the next);
   * - a married name listing spellings with slashes, which a 7.0 save must
   *   keep whole;
   * - a CONC line holding U+2028 (LINE SEPARATOR) pasted from a web page
   *   (Ivanc.ged).
   */
  "myheritage-raw-breaks-utf8.ged": bytes(
    BOM,
    lines("0 HEAD", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8", "1 SOUR MYHERITAGE",
      "2 NAME MyHeritage Family Tree Builder", "1 SUBM @SUB1@", "0 @SUB1@ SUBM", "1 NAME Ana Golobič",
      "0 @I1@ INDI", "1 NAME Jožef /Golobič/", "1 SEX M"),
    "1 DSCR Izvor priimka Golobič: domače ime po kmetiji.&#13;\n&#13;\nDruga vrstica brez oznake.", CRLF,
    lines("1 BIRT", "2 DATE 12 MAR 1850", "2 PLAC Kranj, Slovenija",
      "0 @I2@ INDI", "1 NAME Marija /Kobalek/", "2 _MARNM Golobič/Golobek/Golobar", "1 SEX F"),
    "1 NOTE Hči kmeta, rojena na Golobovi kmetiji, poročena v Ma", [0xc5], CRLF,
    "2 CONC ", [0xa1], "ovi hiši.", CRLF,
    "2 CONC  Prepis iz spletne strani:\u2028stran 4.", CRLF,
    lines("1 FAMS @F1@", "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@", "1 MARR", "2 DATE 3 FEB 1875", "0 TRLR"),
  ),
  /**
   * Brother's Keeper, `CHAR ANSI` (Windows-1250), CRLF (Novaković.ged): a
   * NAME broken over three physical lines, two of them starting with a digit.
   */
  "brotherskeeper-broken-name-w1250.ged": Buffer.concat([
    cp1250(lines("0 HEAD", "1 SOUR BROSKEEP", "2 VERS 7.3.3 WINDOWS", "1 CHAR ANSI", "1 GEDC", "2 VERS 5.5",
      "2 FORM LINEAGE-LINKED", "0 @I1@ INDI", "1 NAME Matija Žnidarič  , ", "6th Bt, ", "8th of /Žnidarič/",
      "1 SEX M", "1 BIRT", "2 DATE 1695", "1 DEAT", "2 DATE 1757", "0 @I2@ INDI", "1 NAME Neža /Šrajek/",
      "1 SEX F", "0 TRLR")),
  ]),
  /**
   * Brother's Keeper, `CHAR ANSEL` over Windows-1250 bytes (17 of the 18
   * ANSEL files in the corpus): read as ANSEL, č became a combining
   * diaeresis on the next character and š/ž/Š/Ž were lost as U+FFFD.
   */
  "brotherskeeper-ansel-label-w1250.ged": cp1250(lines("0 HEAD", "1 SOUR BROSKEEP", "2 VERS 6.6.10 WINDOWS",
    "1 CHAR ANSEL", "1 GEDC", "2 VERS 5.5", "2 FORM LINEAGE-LINKED", "0 @I1@ INDI", "1 NAME Jožef /Ambrožič/",
    "1 SEX M", "1 BIRT", "2 DATE 4 APR 1901", "2 PLAC Šentvid, Ljubljana", "1 OCCU učitelj", "0 @I2@ INDI",
    "1 NAME Uršula /Čebuljnik/", "1 SEX F", "1 RESI", "2 PLAC Nemški Rovt 7, Bohinjska Bistrica", "0 TRLR")),
  /**
   * MyHeritage, `CHAR UTF-8` without a BOM (Ivanc.ged, 136 MB): mostly valid
   * UTF-8, with a few values typed in Windows-1250 (`Makarovi\xE8`,
   * `u\xE8itelj`; here a bare 0x8E for Ž and an en dash as 0x96) and a "č"
   * split across CONC.
   */
  "myheritage-stray-cp1250-utf8.ged": bytes(
    lines("0 HEAD", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8", "1 SOUR MYHERITAGE",
      "2 VERS 8.0.0.8645", "0 @I1@ INDI", "1 NAME Terezija /Kobalič/"),
    "2 _MARNM ", cp1250("Žnidarnik"), CRLF,
    lines("1 SEX F", "1 BIRT", "2 DATE 30 APR 1890", "2 PLAC Škofja Loka, Slovenija"),
    "1 NOTE Izvor: Popis 1900 ", [0x96], " župnija Šentjošt, stran 12.", CRLF,
    "1 OCCU šivilja in kuharica pri družini Kre", [0xc4], CRLF,
    "2 CONC ", [0x8d], "ar", CRLF,
    lines("0 @I2@ INDI", "1 NAME Andrej /Žnidarnik/", "1 SEX M", "1 OCCU čevljar", "0 TRLR"),
  ),
};

mkdirSync(OUT_DIR, { recursive: true });
for (const [file, data] of Object.entries(FIXTURES)) {
  writeFileSync(resolve(OUT_DIR, file), data);
  console.log(`✓ ${file.padEnd(40)} ${data.length} bytes`);
}
