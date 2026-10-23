import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { captureBaseline } from "../gedcom/fingerprint";
import { cloneNode } from "../gedcom/node";
import { parseGedcom } from "../gedcom/parser";
import { downloadOptions, ensureUtf8Charset, serializeGedcom, stampHeadSource } from "../gedcom/serialize";
import type { Dataset, GedNode } from "../gedcom/types";
import { decisionKey } from "../review/types";
import { buildSavePreview, type SavePreviewInput } from "./buildSavePreview";
import { savedBaseline } from "./savedBaseline";

/**
 * After a confirmed save the live main is rebuilt in place from the records
 * just written, and from then on the app works on it as the file. That only
 * holds if the rebuild is the file: a fresh parse of the saved text must give
 * the same records, people and families. Run here the way handleConfirmSave
 * runs it — charset forced to UTF-8, HEAD.SOUR stamped, serialized with the
 * file's own line endings and byte-order mark.
 */

const corpus = resolve(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/corpus");
const parse = (bytes: Uint8Array): Dataset =>
  buildDataset(parseGedcom(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
const NOW = new Date("2026-10-23T12:00:00Z");

/** The save's own steps from the records to the downloaded text. */
function saveText(main: Dataset, records: GedNode[]): string {
  ensureUtf8Charset(records, main);
  stampHeadSource(records, main, NOW);
  return serializeGedcom(records, downloadOptions(main));
}

/** A typed record without its raw back-reference, which the two sides hold
 *  as different (equal) node trees. */
const typed = (rec: object) => JSON.parse(JSON.stringify(rec, (k, v) => (k === "raw" ? undefined : v)));

function expectSameAsFreshParse(rebuilt: Dataset, text: string) {
  const fresh = parse(new TextEncoder().encode(text));
  expect(serializeGedcom(rebuilt.records, downloadOptions(rebuilt))).toBe(text);
  expect(serializeGedcom(fresh.records, downloadOptions(fresh))).toBe(text);
  const meta = (d: Dataset) => ({
    version: d.version, charset: d.charset, eol: d.eol, finalNewline: d.finalNewline, bom: !!d.bom, chanCreaUsage: d.chanCreaUsage,
  });
  expect(meta(rebuilt)).toEqual(meta(fresh));
  expect([...rebuilt.individuals.keys()]).toEqual([...fresh.individuals.keys()]);
  expect([...rebuilt.families.keys()]).toEqual([...fresh.families.keys()]);
  for (const [id, ind] of rebuilt.individuals) expect(typed(ind), id).toEqual(typed(fresh.individuals.get(id)!));
  for (const [id, fam] of rebuilt.families) expect(typed(fam), id).toEqual(typed(fresh.families.get(id)!));
}

describe("savedBaseline", () => {
  it("equals a fresh parse of every corpus file as saved — charset, line endings and byte-order mark included", () => {
    for (const file of readdirSync(corpus).filter((f) => f.endsWith(".ged"))) {
      const main = parse(readFileSync(resolve(corpus, file)));
      const records = main.records.map(cloneNode);
      const text = saveText(main, records);
      const rebuilt = savedBaseline(main, records);
      expect(rebuilt.charset, file).toBe("UTF-8");
      expect(!!rebuilt.bom, file).toBe(!!main.bom);
      expectSameAsFreshParse(rebuilt, text);
    }
  });

  it("equals a fresh parse after a merge save that brought fields and a person in", () => {
    const wrap = (body: string) => `0 HEAD\r\n1 GEDC\r\n2 VERS 5.5.1\r\n1 CHAR ANSI\r\n${body}0 TRLR\r\n`;
    const main = parse(
      new TextEncoder().encode(
        "﻿" +
          wrap(
            "0 @I1@ INDI\r\n1 NAME Janez /Novak/\r\n1 SEX M\r\n1 BIRT\r\n2 DATE 1850\r\n1 FAMS @F1@\r\n" +
              "0 @I2@ INDI\r\n1 NAME Ana /Kos/\r\n1 SEX F\r\n1 FAMS @F1@\r\n" +
              "0 @F1@ FAM\r\n1 HUSB @I1@\r\n1 WIFE @I2@\r\n",
          ),
      ),
    );
    const compare = parse(
      new TextEncoder().encode(
        "0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n" +
          "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n1 DEAT\n2 DATE 1920\n0 TRLR\n",
      ),
    );
    const input: SavePreviewInput = {
      main,
      mainFileName: "rodovnik.ged",
      baseline: captureBaseline(main, () => undefined, () => undefined),
      compare,
      decisions: new Map([[decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed" as const, fields: {} }]]),
      matches: { individuals: [] },
      importRequests: [],
      confirmedCount: 1,
      importCount: 0,
      changedPersonIds: new Set(),
      changedFamilyIds: new Set(),
      changedRecordIds: new Set(),
      loadedPersonIds: new Set(main.individuals.keys()),
      loadedFamilyIds: new Set(main.families.keys()),
      personSnapshots: new Map(),
      familySnapshots: new Map(),
      recordSnapshots: new Map(),
      isSortEligible: () => false,
      isSubstantive: () => true,
      now: NOW,
      t: (key: string) => key,
    };
    const preview = buildSavePreview(input)!;
    const text = saveText(main, preview.records);
    expect(text).toContain("2 PLAC Kranj");
    expect(text).toContain("1 CHAR UTF-8");
    expect(text.startsWith("﻿0 HEAD\r\n")).toBe(true);
    const rebuilt = savedBaseline(main, preview.records);
    expectSameAsFreshParse(rebuilt, text);
    // Assigned in place, as App does: the live object now is the saved file.
    Object.assign(main, rebuilt);
    expect(main.individuals.get("@I1@")!.events.map((e) => e.tag)).toEqual(expect.arrayContaining(["BIRT", "DEAT"]));
    expect(serializeGedcom(main.records, downloadOptions(main))).toBe(text);
  });
});
