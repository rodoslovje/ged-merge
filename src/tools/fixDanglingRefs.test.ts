import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import type { GedNode } from "../gedcom/types";
import { validateConformance } from "./conformance/conformance";
import { countDanglingRefs, fixDanglingRefs } from "./fixDanglingRefs";
import { validateStructure } from "./structure";

/** A file in `vers` with a header complete enough that strict conformance
 *  has nothing to say about it, around `body`. */
function dataset(vers: "5.5.1" | "7.0", body: string) {
  const head = vers === "7.0"
    ? "0 HEAD\n1 GEDC\n2 VERS 7.0\n"
    : "0 HEAD\n1 SOUR TEST\n1 SUBM @U1@\n1 GEDC\n2 VERS 5.5.1\n2 FORM LINEAGE-LINKED\n1 CHAR UTF-8\n0 @U1@ SUBM\n1 NAME Test\n";
  return buildDataset(parseGedcom(new TextEncoder().encode(`${head}${body}\n0 TRLR`).buffer));
}

const rec = (ds: ReturnType<typeof dataset>, xref: string) => ds.records.find((r) => r.xref === xref)!;
const lines = (node: GedNode, depth = 1): string[] =>
  node.children.flatMap((c) => [`${depth} ${c.tag}${c.value !== undefined ? ` ${c.value}` : ""}`, ...lines(c, depth + 1)]);

/** Fix, then check: strict conformance finds nothing, no dangling reference
 *  is left, and a second run changes nothing. */
function fixClean(ds: ReturnType<typeof dataset>) {
  expect(validateConformance(ds)).toEqual([]);
  expect(countDanglingRefs(ds)).toBeGreaterThan(0);
  fixDanglingRefs(ds);
  expect(validateConformance(ds)).toEqual([]);
  expect(countDanglingRefs(ds)).toBe(0);
  expect(validateStructure(ds).counts.danglingXref ?? 0).toBe(0);
  const once = serializeGedcom(ds.records);
  expect(fixDanglingRefs(ds)).toHaveLength(0);
  expect(serializeGedcom(ds.records)).toBe(once);
}

describe("fixDanglingRefs repairs rather than deletes", () => {
  it("7.0: a dangling citation with detail becomes @VOID@ and keeps its PAGE and transcript", () => {
    const ds = dataset("7.0", `0 @I1@ INDI
1 NAME Bo /Horvat/
1 BIRT
2 DATE 1900
2 SOUR @S9@
3 PAGE p. 12
3 DATA
4 TEXT Bo, son of Jan
3 QUAY 2`);
    fixClean(ds);
    expect(lines(rec(ds, "@I1@"))).toEqual([
      "1 NAME Bo /Horvat/", "1 BIRT", "2 DATE 1900",
      "2 SOUR @VOID@", "3 PAGE p. 12", "3 DATA", "4 TEXT Bo, son of Jan", "3 QUAY 2",
    ]);
  });

  it("7.0: a dangling association becomes @VOID@ with its PHRASE and ROLE", () => {
    const ds = dataset("7.0", `0 @I1@ INDI
1 NAME Bo /Horvat/
1 ASSO @I9@
2 PHRASE Janez Novak
2 ROLE GODP`);
    fixClean(ds);
    expect(lines(rec(ds, "@I1@"))).toEqual(["1 NAME Bo /Horvat/", "1 ASSO @VOID@", "2 PHRASE Janez Novak", "2 ROLE GODP"]);
  });

  it("7.0: a dangling pointer with no detail, and a NOTE that is text in 7.0, are removed", () => {
    const ds = dataset("7.0", `0 @I1@ INDI
1 NAME Bo /Horvat/
1 SOUR @S9@
1 OBJE @O9@
1 SNOTE @N9@`);
    fixClean(ds);
    expect(lines(rec(ds, "@I1@"))).toEqual(["1 NAME Bo /Horvat/"]);
  });

  it("5.5.1: a dangling citation becomes a text citation, its PAGE the text", () => {
    const ds = dataset("5.5.1", `0 @I1@ INDI
1 NAME Bo /Horvat/
1 BIRT
2 DATE 1900
2 SOUR @S9@
3 PAGE p. 12
3 DATA
4 TEXT Bo, son of Jan
3 QUAY 2`);
    fixClean(ds);
    expect(lines(rec(ds, "@I1@"))).toEqual([
      "1 NAME Bo /Horvat/", "1 BIRT", "2 DATE 1900",
      "2 SOUR p. 12", "3 TEXT Bo, son of Jan", "3 QUAY 2",
    ]);
  });

  it("5.5.1: a dangling association becomes a note naming the associate and the relation", () => {
    const ds = dataset("5.5.1", `0 @I1@ INDI
1 NAME Bo /Horvat/
1 ASSO @I9@
2 RELA Godfather
2 NOTE Janez Novak, farmer`);
    fixClean(ds);
    expect(lines(rec(ds, "@I1@"))).toEqual(["1 NAME Bo /Horvat/", "1 NOTE Janez Novak, farmer (Godfather)"]);
  });

  it("5.5.1: a dangling association that only names a relation, and a dangling NOTE pointer, are removed", () => {
    const ds = dataset("5.5.1", `0 @I1@ INDI
1 NAME Bo /Horvat/
1 ASSO @I9@
2 RELA Godfather
1 NOTE @N9@`);
    fixClean(ds);
    expect(lines(rec(ds, "@I1@"))).toEqual(["1 NAME Bo /Horvat/"]);
  });

  it("5.5.1: any other dangling pointer with detail becomes an inline note spelling it out", () => {
    const ds = dataset("5.5.1", `0 @I1@ INDI
1 NAME Bo /Horvat/
1 ADOP
2 DATE 1900
2 FAMC @F9@
3 ADOP BOTH
1 OBJE @O9@
2 _PRIM Y
1 NOTE @N9@
2 SOUR @S1@
3 PAGE p. 3
1 OBJE @O8@
0 @S1@ SOUR
1 TITL Book`);
    fixClean(ds);
    expect(lines(rec(ds, "@I1@"))).toEqual([
      "1 NAME Bo /Horvat/",
      "1 ADOP",
      "2 DATE 1900",
      "2 NOTE FAMC @F9@\n  ADOP BOTH",
      "1 NOTE OBJE @O9@\n  _PRIM Y",
      // A note keeps what hangs under it as lines.
      "1 NOTE NOTE @N9@",
      "2 SOUR @S1@",
      "3 PAGE p. 3",
      // …and a pointer with nothing under it still just goes.
    ]);
    expect(serializeGedcom(ds.records)).toContain("2 NOTE FAMC @F9@\n3 CONT   ADOP BOTH\n");
  });

  it("repairs a dangling pointer nested under a kept one in the same run", () => {
    const ds = dataset("7.0", `0 @I1@ INDI
1 NAME Bo /Horvat/
1 SOUR @S9@
2 PAGE p. 3
2 OBJE @O9@`);
    fixClean(ds);
    // The media link carried nothing of its own; the citation still has its PAGE.
    expect(lines(rec(ds, "@I1@"))).toEqual(["1 NAME Bo /Horvat/", "1 SOUR @VOID@", "2 PAGE p. 3"]);
  });
});
