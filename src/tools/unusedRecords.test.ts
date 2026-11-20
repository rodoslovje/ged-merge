import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { findUnusedRecords, validateStructure } from "./structure";

function dataset(body: string) {
  const text = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}\n0 TRLR`;
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer as ArrayBuffer));
}
const unused = (body: string) => findUnusedRecords(dataset(body).records).map((r) => r.xref).sort();

describe("findUnusedRecords", () => {
  it("names the shared records nothing points at", () => {
    expect(unused(`0 @I1@ INDI
1 NAME Ana /Kos/
1 BIRT
2 SOUR @S1@
3 OBJE @O1@
1 NOTE @N1@
0 @S1@ SOUR
1 TITL Cited
0 @S2@ SOUR
1 TITL Not cited
0 @O1@ OBJE
1 FILE a.jpg
0 @O2@ OBJE
1 FILE b.jpg
0 @N1@ NOTE used
0 @N2@ NOTE left behind`)).toEqual(["@N2@", "@O2@", "@S2@"]);
  });

  it("counts a record used only by an unused one as unused too", () => {
    // The page image of a source nobody cites, and that source's note.
    expect(unused(`0 @I1@ INDI
1 NAME Ana /Kos/
0 @S1@ SOUR
1 TITL Not cited
1 OBJE @O1@
1 NOTE @N1@
0 @O1@ OBJE
1 FILE page.jpg
0 @N1@ NOTE about the source`)).toEqual(["@N1@", "@O1@", "@S1@"]);
  });

  it("follows use through shared records, and ignores a record's pointer to itself", () => {
    expect(unused(`0 @I1@ INDI
1 NAME Ana /Kos/
1 SOUR @S1@
0 @S1@ SOUR
1 TITL Cited
1 OBJE @O1@
0 @O1@ OBJE
1 FILE page.jpg
1 NOTE @N1@
0 @N1@ NOTE on the page
0 @N2@ NOTE names itself
1 NOTE @N2@
0 @R1@ REPO
1 NAME Archive`)).toEqual(["@N2@"]);
  });

  it("is an informational finding in the health check, one per record", () => {
    const report = validateStructure(dataset(`0 @I1@ INDI
1 NAME Ana /Kos/
0 @S1@ SOUR
1 TITL Not cited`));
    const rows = report.issues.filter((i) => i.category === "unusedRecord");
    expect(rows).toMatchObject([{ severity: "info", recordId: "@S1@", recordTag: "SOUR" }]);
    expect(report.counts.unusedRecord).toBe(1);
  });
});
