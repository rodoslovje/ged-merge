import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { createSourceRecord } from "../gedcom/edit";
import { applySourceCleanup } from "./sourceCleanupApply";
import { findReshapableLinks } from "./sourceReshape";
import { findSourceDuplicates } from "./sourceDuplicates";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const BOOK = "https://data.matricula-online.eu/sl/slovenia/maribor/sentjur-pri-celju/03869";

describe("applySourceCleanup", () => {
  const FILE = [
    "0 HEAD",
    "1 CHAR UTF-8",
    "0 @I1@ INDI",
    "1 NAME Ana /Renko/",
    "1 BIRT",
    `2 NOTE ${BOOK}/?pg=10`,
    "0 TRLR",
  ].join("\n");

  it("writes the reshape into the open file, as undoable patches", () => {
    const ds = dataset(FILE);
    const report = findReshapableLinks(ds);
    const indiNode = ds.records.find((r) => r.xref === "@I1@")!;
    const patches = applySourceCleanup(ds, { groups: report.groups, enrichment: new Map(), options: {} }, []);

    // The file itself changed — no download involved.
    const text = serializeGedcom(ds.records);
    expect(text).toContain("0 @S1@ SOUR");
    expect(text).toMatch(/2 SOUR @S1@\n3 PAGE 10/);

    // The person's record object is the very one the typed model points at, so
    // an edit right after this run still lands on the file's own node.
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.raw).toBe(indiNode);
    expect(ds.records).toContain(indi.raw);
    // …and the typed projection was rebuilt from it: the note-with-a-URL is now
    // a citation on the birth.
    const birth = indi.raw.children.find((c) => c.tag === "BIRT")!;
    expect(birth.children.some((c) => c.tag === "SOUR")).toBe(true);

    const kinds = patches.map((p) => `${p.type}:${p.id}:${p.before ? "was" : "new"}`);
    expect(kinds).toContain("individual:@I1@:was");
    expect(kinds).toContain("record:@S1@:new");
    // Undo has the before state to go back to, and it is the pre-run record.
    const indiPatch = patches.find((p) => p.id === "@I1@")!;
    expect(JSON.stringify(indiPatch.before)).toContain(BOOK);
    expect(JSON.stringify(indiPatch.after)).not.toContain(BOOK);
  });

  it("records a merged-away duplicate as a deletion, with the place it stood in", () => {
    const ds = dataset([
      "0 HEAD",
      "1 CHAR UTF-8",
      "0 @I1@ INDI",
      "1 SOUR @S1@",
      "1 SOUR @S2@",
      "0 @S1@ SOUR",
      "1 TITL Krstna knjiga | 03869",
      "0 @S2@ SOUR",
      "1 TITL Krstna knjiga | 03869",
      "0 TRLR",
    ].join("\n"));
    const dups = findSourceDuplicates(ds);
    expect(dups.groups).toHaveLength(1);
    const index = ds.records.findIndex((r) => r.xref === "@S2@");
    const patches = applySourceCleanup(ds, { groups: [], enrichment: new Map(), options: {} }, dups.groups);

    expect(ds.records.some((r) => r.xref === "@S2@")).toBe(false);
    const gone = patches.find((p) => p.id === "@S2@")!;
    expect(gone.after).toBeNull();
    // Undo puts it back where it was, so the file's record order survives.
    expect(gone.index).toBe(index);
  });

  it("shortens the kept record's link when a media merge resolves viewer-state twins", () => {
    // Two OBJE records for one FamilySearch page, differing only in the
    // viewer state their URLs carry — the very duplicates "Shorten links"
    // is expected to leave fully resolved: one record, one canonical link.
    const ds = dataset([
      "0 HEAD",
      "1 CHAR UTF-8",
      "0 @I1@ INDI",
      "1 OBJE @O1@",
      "1 OBJE @O2@",
      "0 @O1@ OBJE",
      "1 FILE https://www.familysearch.org/ark:/61903/3:1:3QS7-L99C-53BC?view=index&lang=en",
      "1 TITL #005 - Marriages, Ravna Gora",
      "0 @O2@ OBJE",
      "1 FILE https://www.familysearch.org/ark:/61903/3:1:3QS7-L99C-53BC?wc=9R29&lang=en&i=184&cc=2040054",
      "0 TRLR",
    ].join("\n"));
    const dups = findSourceDuplicates(ds);
    expect(dups.groups).toHaveLength(1);
    applySourceCleanup(ds, { groups: [], enrichment: new Map(), options: { tidyLinks: true } }, dups.groups);

    const text = serializeGedcom(ds.records);
    expect(ds.records.filter((r) => r.tag === "OBJE")).toHaveLength(1);
    expect(text).toContain("1 FILE https://www.familysearch.org/ark:/61903/3:1:3QS7-L99C-53BC\n");
    expect(text).not.toContain("view=index");
  });

  it("touches nothing when nothing is selected", () => {
    const ds = dataset(FILE);
    const before = serializeGedcom(ds.records);
    expect(applySourceCleanup(ds, { groups: [], enrichment: new Map(), options: {} }, [])).toEqual([]);
    expect(serializeGedcom(ds.records)).toBe(before);
  });

  it("keeps hand-created xrefs fresh after transplanting run-created records", () => {
    // The bug scenario: a hand-added source warms the live array's max-xref
    // cache, the cleanup then creates its records against a *cloned* forest
    // and transplants them in — without telling the live cache. The next
    // hand-added source must not be handed a transplanted record's xref.
    const ds = dataset(FILE);
    createSourceRecord(ds.records, { title: "Ročno dodan vir" }); // warms the cache: @S1@

    const report = findReshapableLinks(ds);
    expect(report.groups.length).toBeGreaterThan(0);
    applySourceCleanup(ds, { groups: report.groups, enrichment: new Map(), options: {} }, []);

    const afterCleanup = createSourceRecord(ds.records, { title: "Še en vir" });
    const sourXrefs = ds.records.filter((r) => r.tag === "SOUR").map((r) => r.xref);
    expect(new Set(sourXrefs).size).toBe(sourXrefs.length); // no collision
    expect(sourXrefs).toContain(afterCleanup.xref);
  });
});
