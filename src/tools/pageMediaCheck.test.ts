import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { findMissingPageMedia, linkMissingPageMedia } from "./pageMediaCheck";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const BOOK = "https://data.matricula-online.eu/sl/slovenia/maribor/sentjur-pri-celju/03869";

/** One source, one page image, one citation of it — the plain case. */
const ONE_IMAGE = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Kern/
1 BIRT
2 DATE 3 MAR 1880
2 SOUR @S1@
3 PAGE 11
0 @S1@ SOUR
1 TITL Krstna knjiga - 03869
1 OBJE @M1@
0 @M1@ OBJE
1 FILE ${BOOK}/?pg=11
0 TRLR`;

describe("findMissingPageMedia", () => {
  it("reports a citation whose event does not link the source's page image", () => {
    const report = findMissingPageMedia(dataset(ONE_IMAGE), "event");
    expect(report.total).toBe(1);
    expect(report.ambiguous).toBe(0);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({
      id: "pm:@S1@",
      sourceXref: "@S1@",
      title: "Krstna knjiga - 03869",
    });
    expect(report.groups[0].missing[0]).toEqual({
      recordXref: "@I1@",
      eventTag: "BIRT",
      page: "11",
      objeXref: "@M1@",
    });
  });

  it("says nothing about a file that keeps page images under the source alone", () => {
    // The same file, read the other way: there the pointer would be the
    // mistake, and the main scan is the one that offers to fold it away.
    expect(findMissingPageMedia(dataset(ONE_IMAGE), "source")).toMatchObject({ total: 0, groups: [] });
  });

  it("leaves a citation that already links its page alone", () => {
    const text = ONE_IMAGE.replace("3 PAGE 11", "3 PAGE 11\n2 OBJE @M1@");
    expect(findMissingPageMedia(dataset(text), "event").total).toBe(0);
  });

  it("tells several pages apart by the cited page, and counts the ones it cannot", () => {
    const report = findMissingPageMedia(
      dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Kern/
1 BIRT
2 SOUR @S1@
3 PAGE 12
1 DEAT
2 SOUR @S1@
0 @I2@ INDI
1 NAME Blaz /Kern/
1 BIRT
2 SOUR @S1@
3 PAGE 94
0 @S1@ SOUR
1 TITL Krstna knjiga - 03869
1 OBJE @M1@
1 OBJE @M2@
0 @M1@ OBJE
1 FILE ${BOOK}/?pg=11
0 @M2@ OBJE
1 FILE ${BOOK}/?pg=12
0 TRLR`),
      "event",
    );
    // Ana's birth cites page 12, which one image answers to.
    expect(report.total).toBe(1);
    expect(report.groups[0].missing[0]).toMatchObject({ recordXref: "@I1@", eventTag: "BIRT", objeXref: "@M2@" });
    // Her death names no page, and Blaž's birth names one no image carries —
    // neither is guessed at, and neither is passed over in silence.
    expect(report.ambiguous).toBe(2);
    expect(report.groups[0].ambiguous).toBe(2);
  });

  it("ignores a source that holds no page images at all", () => {
    expect(
      findMissingPageMedia(
        dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Kern/
1 BIRT
2 SOUR @S1@
0 @S1@ SOUR
1 TITL Druzinski arhiv Kern
0 TRLR`),
        "event",
      ).total,
    ).toBe(0);
  });

  it("covers a citation on the record itself, and a family's", () => {
    const report = findMissingPageMedia(
      dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Kern/
1 SOUR @S1@
2 PAGE 11
0 @F1@ FAM
1 HUSB @I1@
1 MARR
2 SOUR @S1@
3 PAGE 11
0 @S1@ SOUR
1 TITL Krstna knjiga - 03869
1 OBJE @M1@
0 @M1@ OBJE
1 FILE ${BOOK}/?pg=11
0 TRLR`),
      "event",
    );
    expect(report.total).toBe(2);
    expect(report.groups[0].missing).toEqual([
      { recordXref: "@I1@", eventTag: undefined, page: "11", objeXref: "@M1@" },
      { recordXref: "@F1@", eventTag: "MARR", page: "11", objeXref: "@M1@" },
    ]);
  });
});

describe("linkMissingPageMedia", () => {
  it("links the image beside the citation, and nothing else", () => {
    const ds = dataset(ONE_IMAGE);
    const { records, count } = linkMissingPageMedia(ds.records, new Set(["@S1@"]));
    expect(count).toBe(1);
    const text = serializeGedcom(records);
    expect(text).toMatch(/1 BIRT\n2 DATE 3 MAR 1880\n2 OBJE @M1@\n2 SOUR @S1@\n3 PAGE 11/);
    // The input forest is untouched — the caller diffs the two.
    expect(serializeGedcom(ds.records)).not.toContain("2 OBJE @M1@");
  });

  it("writes nothing for a source that was not selected", () => {
    const ds = dataset(ONE_IMAGE);
    const { records, count } = linkMissingPageMedia(ds.records, new Set(["@S9@"]));
    expect(count).toBe(0);
    expect(records).toBe(ds.records);
  });

  it("is idempotent — a second run has nothing left to write", () => {
    const ds = dataset(ONE_IMAGE);
    const first = linkMissingPageMedia(ds.records, new Set(["@S1@"]));
    const second = linkMissingPageMedia(first.records, new Set(["@S1@"]));
    expect(second.count).toBe(0);
    expect(findMissingPageMedia({ ...ds, records: first.records }, "event").total).toBe(0);
  });
});
