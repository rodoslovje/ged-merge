/**
 * Whole-file merge over the anonymized corpus — every exporter we support
 * merged into every other, through the app's own pipeline (parse → normalize
 * against the main's profile → match → consolidate incoming duplicates →
 * mergeDecisions with `wholeFile`), and held to what a whole-file merge must
 * never do:
 *
 *  - lose or duplicate anyone: taking unreviewed candidates as new people, the
 *    output holds every main and every incoming person and family, exactly;
 *  - break the file: no dangling pointers, no broken family links, no duplicate
 *    families, nobody left disconnected who was not before;
 *  - make it less standard: in strict 5.5.1 and 7.0 the output has no kind of
 *    conformance finding (message and tag) that neither file had already —
 *    counted by kind, since the incoming file's own findings move with its
 *    records (a misplaced line under another event once its version is
 *    converted, a name type written the main file's way);
 *  - change a file merged into itself, joining on the matcher's candidates.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { serializeGedcom } from "../gedcom/serialize";
import { cloneNode } from "../gedcom/node";
import type { Dataset } from "../gedcom/types";
import { inferMainProfile } from "../normalize/profile";
import { normalizeDataset } from "../normalize/normalize";
import { matchDatasets } from "../match/engine";
import type { MatchResult } from "../match/types";
import { mergeDuplicate } from "../tools/mergeDuplicate";
import { findDanglingXrefs } from "../tools/structure";
import { validateDataset } from "../tools/validate";
import { validateConformance } from "../tools/conformance/conformance";
import { prepareDownload } from "../save/outputFile";
import { mergeDecisions } from "../merge/merge";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(HERE, "corpus");
const tr = (key: string) => key;
const FILES = [
  "ancestry-5.5.1-utf8.ged",
  "familyhistorian-5.5.1-utf8.ged",
  "gramps-5.5.1-utf8.ged",
  "myheritage-5.5.1-utf8.ged",
  "synium-7.0-utf8.ged",
];

const read = (name: string): Dataset => {
  const buf = readFileSync(resolve(CORPUS, name));
  return buildDataset(parseGedcom(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer));
};
const load = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));

/** The worker's pipeline: normalize the incoming file to the main's habits,
 *  match, fold the incoming file's own duplicates. */
function pair(mainName: string, compareName: string): { main: Dataset; compare: Dataset; result: MatchResult } {
  const main = read(mainName);
  const { dataset: compare } = normalizeDataset(read(compareName), inferMainProfile(main));
  let result = matchDatasets(main, compare);
  for (const { keepId, mergeIds } of result.incomingDuplicates ?? []) {
    for (const id of mergeIds) mergeDuplicate(compare, keepId, id, { status: "confirmed", fields: {} }, tr);
  }
  result = { individuals: result.individuals };
  return { main, compare, result };
}

/** The kinds of conformance finding a file has once saved in `version`. */
const findingKinds = (ds: Dataset, version: "5.5.1" | "7.0"): Set<string> => {
  const records = ds.records.map(cloneNode);
  prepareDownload(records, ds, version);
  return new Set(validateConformance(load(serializeGedcom(records))).map((i) => `${i.messageKey} ${i.messageVars.tag ?? ""}`));
};
const nonEmptyFamilies = (ds: Dataset) =>
  [...ds.families.values()].filter((f) => f.husband || f.wife || f.children.length).length;

describe("whole-file merge across the corpus", () => {
  for (const mainName of FILES) {
    for (const compareName of FILES) {
      it(`${compareName} into ${mainName}: everyone comes across, nothing breaks`, () => {
        const { main, compare, result } = pair(mainName, compareName);
        const { records } = mergeDecisions(main, compare, new Map(), result, tr, [], undefined, { pending: "new" });
        const out = load(serializeGedcom(records));

        expect(out.individuals.size).toBe(main.individuals.size + compare.individuals.size);
        expect(nonEmptyFamilies(out)).toBe(nonEmptyFamilies(main) + nonEmptyFamilies(compare));
        expect(findDanglingXrefs(out.records)).toEqual([]);

        const [m, c, o] = [main, compare, out].map((ds) => validateDataset(ds, 2026).counts);
        expect(o.brokenLink).toBeLessThanOrEqual(m.brokenLink + c.brokenLink);
        expect(o.orphan).toBeLessThanOrEqual(m.orphan + c.orphan);
        expect(o.duplicateFamily).toBeLessThanOrEqual(m.duplicateFamily + c.duplicateFamily);
        for (const version of ["5.5.1", "7.0"] as const) {
          const known = new Set([main, compare, read(compareName)].flatMap((ds) => [...findingKinds(ds, version)]));
          expect([...findingKinds(out, version)].filter((k) => !known.has(k)), version).toEqual([]);
        }
      });
    }
  }

  // MyHeritage's sample has people the matcher cannot pair with themselves
  // (anonymized to no name and no dates), so it is left out here.
  for (const name of FILES.filter((f) => !f.startsWith("myheritage"))) {
    it(`${name} merged into itself, joining on candidates, is unchanged`, () => {
      const { main, compare, result } = pair(name, name);
      const { records, report } = mergeDecisions(main, compare, new Map(), result, tr, [], undefined, { pending: "join" });
      expect(report.newPersons).toBe(0);
      expect(report.newFamilies).toBe(0);
      expect(serializeGedcom(records)).toBe(serializeGedcom(main.records));
    });
  }
});
