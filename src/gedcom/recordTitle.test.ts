import { describe, expect, it } from "vitest";
import { parseGedcom } from "./parser";
import { recordByXref, recordTitle } from "./recordTitle";

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

const records = parseGedcom(bytes(`0 HEAD
1 CHAR UTF-8
0 @S1@ SOUR
1 TITL Krstna knjiga Šentvid 1850–1870
0 @S2@ SOUR
1 ABBR RKŽ Šentvid
0 @M1@ OBJE
1 FILE photos/janez.jpg
2 FORM jpg
0 @M2@ OBJE
1 FILE scans/p12.png
2 TITL Krstna knjiga, stran 12
0 @R1@ REPO
1 NAME Nadškofijski arhiv Ljubljana
0 @N1@ NOTE Kratka opomba
0 @X1@ SOUR
0 TRLR`)).records;

describe("recordTitle", () => {
  const title = (xref: string) => recordTitle(recordByXref(records, xref)!);

  it("names each kind of record the way a reader would look for it", () => {
    expect(title("@S1@")).toBe("Krstna knjiga Šentvid 1850–1870");
    expect(title("@S2@")).toBe("RKŽ Šentvid");
    expect(title("@M1@")).toBe("janez.jpg");
    expect(title("@M2@")).toBe("Krstna knjiga, stran 12");
    expect(title("@R1@")).toBe("Nadškofijski arhiv Ljubljana");
    expect(title("@N1@")).toBe("Kratka opomba");
  });

  it("says nothing for a record without a name of its own", () => {
    expect(title("@X1@")).toBeUndefined();
  });
});
