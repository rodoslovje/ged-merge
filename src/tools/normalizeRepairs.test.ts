import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import type { Dataset } from "../gedcom/types";
import { targetFormatOverrides } from "../normalize/target";
import type { NormalizeOptions } from "../normalize/types";
import { applyBulkNormalize, bulkNormalize } from "./bulkNormalize";
import { fixableConformance, validateConformance } from "./conformance/conformance";
import { normalizeRepairKinds } from "./normalizeRepairs";

const dsOf = (lines: string[]): Dataset => buildDataset(parseGedcom(new TextEncoder().encode(lines.join("\n")).buffer as ArrayBuffer));
const strict = (version: "5.5.1" | "7.0") => targetFormatOverrides({}, { strict: true, version });
const ALL: NormalizeOptions = { dates: true, places: true, links: true, names: true, vendorTags: true, sourceCoverage: true, noteShape: false, repairs: true, stripInternal: false };

/** A 7.0 file with findings the health check repairs: a value in the wrong
 *  case, an exact repeat, a media file with no FORM, a pointer to nothing. */
const V7 = [
  "0 HEAD", "1 GEDC", "2 VERS 7.0",
  "0 @I1@ INDI", "1 NAME Ana /Kos/", "2 TYPE birth", "1 SEX F", "1 SEX F", "1 SOUR @S9@", "1 OBJE @M1@",
  "0 @M1@ OBJE", "1 FILE slike/ana.jpg",
  "0 TRLR",
];

describe("Normalize runs the health check's repairs", () => {
  it("leaves no finding the health check would fix, in 7.0", () => {
    const ds = dsOf(V7);
    expect(fixableConformance(ds.records).length).toBeGreaterThan(0);
    const before = validateConformance(ds).length;
    applyBulkNormalize(ds, ALL, strict("7.0"));
    expect(fixableConformance(ds.records)).toEqual([]);
    expect(validateConformance(ds).length).toBeLessThan(before);
    const text = serializeGedcom(ds.records);
    expect(text).toContain("2 TYPE BIRTH");
    expect(text).toContain("2 FORM image/jpeg");
    expect(text).not.toContain("@S9@");
    expect(text.match(/1 SEX F/g)).toHaveLength(1);
  });

  it("adds no finding to a clean strict 5.5.1 file", () => {
    const ds = dsOf([
      "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8",
      "0 @I1@ INDI", "1 NAME Ana /Kos/", "1 SEX F", "1 BIRT", "2 DATE 2 FEB 1850", "2 PLAC Kranj",
      "0 TRLR",
    ]);
    const before = validateConformance(ds);
    expect(applyBulkNormalize(ds, ALL, strict("5.5.1"))).toEqual([]);
    expect(validateConformance(ds)).toEqual(before);
  });

  it("counts each repair in the preview, as the apply makes it", () => {
    const { report } = bulkNormalize(dsOf(V7), undefined, strict("7.0"));
    expect(report.repairs).toMatchObject({ dangling: 1, values: 1, repeats: 1, forms: 1 });
  });

  it("runs none when the reader unticks them", () => {
    const ds = dsOf(V7);
    applyBulkNormalize(ds, { ...ALL, repairs: false }, strict("7.0"));
    expect(serializeGedcom(ds.records)).toContain("1 SOUR @S9@");
  });

  it("keeps the program's own source fields and event stamps in a file kept with its variations", () => {
    const flat = dsOf([
      "0 HEAD", "1 SOUR MacFamilyTree", "1 GEDC", "2 VERS 5.5.1",
      "0 @I1@ INDI", "1 NAME Ana /Kos/", "1 BIRT", "2 DATE 1850", "2 CHAN", "3 DATE 1 JAN 2020",
      "0 @S1@ SOUR", "1 TITL Kranj, rojstva 1800–1850", "1 PLAC Kranj", "1 DATE 1800-1850",
      "0 TRLR",
    ]);
    expect(normalizeRepairKinds(flat, {})).not.toContain("stamps");
    expect(normalizeRepairKinds(flat, strict("5.5.1"))).toContain("stamps");
    applyBulkNormalize(flat, ALL, {});
    const text = serializeGedcom(flat.records);
    expect(text).toContain("2 CHAN\n3 DATE 1 JAN 2020");
    expect(text).toContain("1 PLAC Kranj\n1 DATE 1800-1850");
  });
});

describe("applyBulkNormalize", () => {
  it("rewrites the live records in place and returns one undo patch per changed record", () => {
    const ds = dsOf(V7);
    const raw = ds.individuals.get("@I1@")!.raw;
    const original = serializeGedcom([raw]);
    const patches = applyBulkNormalize(ds, ALL, strict("7.0"));
    // The typed model still points at the record the file has.
    expect(ds.individuals.get("@I1@")!.raw).toBe(raw);
    expect(ds.records).toContain(raw);
    const indi = patches.find((p) => p.id === "@I1@")!;
    expect(indi.type).toBe("individual");
    expect(serializeGedcom([indi.before!])).toBe(original);
    expect(serializeGedcom([indi.after!])).toBe(serializeGedcom([raw]));
    expect(patches.map((p) => p.id).sort()).toEqual(["@I1@", "@M1@"]);
  });

  it("changes nothing on a second run", () => {
    const ds = dsOf(V7);
    applyBulkNormalize(ds, ALL, strict("7.0"));
    const once = serializeGedcom(ds.records);
    expect(applyBulkNormalize(ds, ALL, strict("7.0"))).toEqual([]);
    expect(serializeGedcom(ds.records)).toBe(once);
  });
});
