import { describe, expect, it } from "vitest";
import { parseGedcom } from "./parser";
import { buildSourceSearch, searchSources, sourceWithTitle } from "./sourceSearch";

const GED = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @S1@ SOUR
1 TITL Cerkniško jezero in ljudje ob njem
1 AUTH Kebe, Janez
0 @S2@ SOUR
1 TITL Krstna knjiga
1 AUTH Župnija Cerknica
0 @S3@ SOUR
1 TITL Krstna knjiga
1 AUTH Župnija Stari trg
0 @S4@ SOUR
1 ABBR Status animarum Cerknica
0 @S5@ SOUR
0 @I1@ INDI
1 SOUR @S1@
0 TRLR
`;

const entries = buildSourceSearch(parseGedcom(new TextEncoder().encode(GED).buffer as ArrayBuffer).records);

describe("source search", () => {
  it("lists every source that has something to be found by", () => {
    expect(entries.map((e) => e.xref).sort()).toEqual(["@S1@", "@S2@", "@S3@", "@S4@"]);
  });

  it("finds a book by its author, whatever the word order or diacritics", () => {
    expect(searchSources(entries, "Kebe").map((e) => e.xref)).toEqual(["@S1@"]);
    expect(searchSources(entries, "janez kebe").map((e) => e.xref)).toEqual(["@S1@"]);
    expect(searchSources(entries, "cerknisko jezero").map((e) => e.xref)).toEqual(["@S1@"]);
  });

  it("puts a title that starts with the query first", () => {
    expect(searchSources(entries, "cerkn").map((e) => e.xref)).toEqual(["@S1@", "@S2@", "@S4@"]);
  });

  it("answers nothing to a single letter, and keeps to the limit", () => {
    expect(searchSources(entries, "k")).toEqual([]);
    expect(searchSources(entries, "knjiga", 1)).toHaveLength(1);
  });

  it("proposes the source a typed title names, telling same-titled ones apart by author", () => {
    expect(sourceWithTitle(entries, "cerkniško jezero in ljudje ob njem.", undefined)?.xref).toBe("@S1@");
    expect(sourceWithTitle(entries, "Krstna knjiga", "Župnija Stari trg")?.xref).toBe("@S3@");
    expect(sourceWithTitle(entries, "Krstna knjiga", "Župnija Lož")).toBeUndefined();
    expect(sourceWithTitle(entries, "Cerkniško jezero", undefined)).toBeUndefined();
    expect(sourceWithTitle(entries, "", undefined)).toBeUndefined();
  });
});
