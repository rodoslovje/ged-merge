import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { inferMasterProfile } from "./profile";
import { normalizeDataset } from "./normalize";
import { formatGedDate } from "./date";
import { parseDate } from "../gedcom/date";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

// Master uses lowercase full month names, zero-padded days, and the spelling
// "Wien" / "Österreich". Compare uses standard uppercase abbreviations and
// lowercase place names. (Cross-language month translation is out of scope:
// detection covers month case, abbreviated-vs-full, and day padding.)
const MASTER = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Franz /Müller/
1 BIRT
2 DATE 05 january 1880
2 PLAC Wien, Österreich
1 DEAT
2 DATE 03 march 1950
2 PLAC Wien, Österreich
0 TRLR
`;

const COMPARE = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Müller/
1 BIRT
2 DATE 5 JAN 1885
2 PLAC wien, österreich
0 TRLR
`;

describe("inferMasterProfile", () => {
  it("detects lowercase full-month style and day padding", () => {
    const profile = inferMasterProfile(dataset(MASTER));
    expect(profile.date.monthTokens[1]).toBe("january");
    expect(profile.date.monthTokens[3]).toBe("march");
    expect(profile.date.padDay).toBe(true);
  });

  it("captures canonical place casing/spelling", () => {
    const profile = inferMasterProfile(dataset(MASTER));
    expect(profile.place.partCanonical.get("wien")).toBe("Wien");
    expect(profile.place.partCanonical.get("österreich")).toBe("Österreich");
    expect(profile.place.modalDepth).toBe(2);
  });
});

describe("formatGedDate", () => {
  it("renders qualifiers and ranges in master style", () => {
    const profile = inferMasterProfile(dataset(MASTER));
    expect(formatGedDate(parseDate("12 FEB 1900"), profile.date)).toBe("12 february 1900");
    expect(formatGedDate(parseDate("ABT 1900"), profile.date)).toBe("ABT 1900");
    expect(formatGedDate(parseDate("BET 1900 AND 1905"), profile.date)).toBe(
      "BET 1900 AND 1905",
    );
    expect(formatGedDate(parseDate("FROM 1900 TO 1905"), profile.date)).toBe(
      "FROM 1900 TO 1905",
    );
  });
});

describe("normalizeDataset", () => {
  it("converts compare dates and places to master conventions", () => {
    const profile = inferMasterProfile(dataset(MASTER));
    const { dataset: out, report } = normalizeDataset(dataset(COMPARE), profile);

    const anna = out.individuals.get("@I1@")!;
    const birth = anna.events.find((e) => e.tag === "BIRT")!;
    expect(birth.date?.raw).toBe("05 january 1885");
    expect(birth.place?.raw).toBe("Wien, Österreich");

    expect(report.datesChanged).toBe(1);
    expect(report.placesChanged).toBe(1);
    expect(report.dateExamples[0]).toEqual({ before: "5 JAN 1885", after: "05 january 1885" });
  });

  it("does not mutate the input dataset", () => {
    const profile = inferMasterProfile(dataset(MASTER));
    const input = dataset(COMPARE);
    normalizeDataset(input, profile);
    const anna = input.individuals.get("@I1@")!;
    expect(anna.events.find((e) => e.tag === "BIRT")?.date?.raw).toBe("5 JAN 1885");
  });
});
