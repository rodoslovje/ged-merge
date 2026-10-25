import { describe, expect, it } from "vitest";
import { buildDataset } from "../../gedcom/builder";
import { parseGedcom } from "../../gedcom/parser";
import { mediaInfoOffered } from "../../gedcom/edit";
import { coverageFieldsOffered, idField, periodicalOffered } from "./standardFields";

// The source and media forms offer a field the standard does not have only in
// a file kept with its variations that already writes it; a strict target
// never offers one.

const records = (body: string) =>
  buildDataset(parseGedcom(new TextEncoder().encode(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${body}0 TRLR\n`).buffer as ArrayBuffer)).records;

const MFT = records(
  "0 @S1@ SOUR\n1 TITL Book\n1 PERI Daily\n1 FILN 7\n1 PLAC Kranj\n1 DATE 1850\n0 @O1@ OBJE\n1 FILE a.jpg\n1 DATE 1900\n1 PLAC Bled\n",
);
const PLAIN = records("0 @S1@ SOUR\n1 TITL Book\n0 @O1@ OBJE\n1 FILE a.jpg\n");

describe("the custom fields a form offers", () => {
  it("offers the file's own PERI, FILN, flat place and years, and media date and place", () => {
    expect(periodicalOffered(MFT)).toBe(true);
    expect(idField(MFT, "vendor", false).caln).toBe(false);
    expect(coverageFieldsOffered(MFT, undefined, false)).toBe(true);
    expect(mediaInfoOffered(MFT)).toEqual({ date: true, place: true });
  });

  it("offers none of them in a strict target, even where the file has them", () => {
    for (const standard of ["5.5.1", "7.0"] as const) {
      expect(periodicalOffered(MFT, standard)).toBe(false);
      expect(idField(MFT, "vendor", false, standard).caln).toBe(true);
      expect(coverageFieldsOffered(MFT, standard, false)).toBe(false);
      expect(mediaInfoOffered(MFT, { standard })).toEqual({ date: false, place: false });
    }
  });

  it("offers none of them in a file kept with its variations that has none", () => {
    expect(periodicalOffered(PLAIN)).toBe(false);
    expect(idField(PLAIN, "vendor", false).caln).toBe(true);
    expect(coverageFieldsOffered(PLAIN, undefined, false)).toBe(false);
    expect(mediaInfoOffered(PLAIN)).toEqual({ date: false, place: false });
  });

  it("offers the place and years where the standard states them, in DATA › EVEN", () => {
    expect(coverageFieldsOffered(PLAIN, "7.0", true)).toBe(true);
  });
});
