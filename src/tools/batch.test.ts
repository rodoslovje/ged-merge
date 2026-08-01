import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import {
  applyBatchAction,
  buildBatchRows,
  computeLineSides,
  matchesBatch,
  type BatchCriterion,
} from "./batch";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const nameOf = (indi: { names: { full: string }[] }) => indi.names[0]?.full ?? "?";

/** Home @I1@ with father @I2@, mother @I3@; paternal grandfather @I4@;
 *  maternal grandmother @I5@; full sibling @I6@; home's child @I7@. */
const FAMILY = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Home /Person/
1 FAMC @F1@
1 FAMS @F3@
0 @I2@ INDI
1 NAME Father //
1 SEX M
1 FAMS @F1@
1 FAMC @F2@
0 @I3@ INDI
1 NAME Mother //
1 SEX F
1 FAMS @F1@
1 FAMC @F4@
0 @I4@ INDI
1 NAME Grandpa /Paternal/
1 SEX M
1 FAMS @F2@
0 @I5@ INDI
1 NAME Grandma /Maternal/
1 SEX F
1 FAMS @F4@
0 @I6@ INDI
1 NAME Sibling //
1 FAMC @F1@
0 @I7@ INDI
1 NAME Child //
1 FAMC @F3@
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I3@
1 CHIL @I1@
1 CHIL @I6@
0 @F2@ FAM
1 HUSB @I4@
1 CHIL @I2@
0 @F4@ FAM
1 WIFE @I5@
1 CHIL @I3@
0 @F3@ FAM
1 HUSB @I1@
1 CHIL @I7@
0 TRLR`;

describe("batch criteria", () => {
  const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 SEX F
1 BIRT
2 DATE 12 MAY 1900
1 DEAT
2 DATE 3 MAY 1919
1 OBJE @O1@
0 @I2@ INDI
1 NAME Bo /Kovač/
1 SEX M
1 BIRT
2 DATE 1880
2 PLAC Škofja Loka
1 DEAT
2 DATE 1960
1 SOUR @S1@
0 @I3@ INDI
1 NAME Cilka /Zupan/
1 SEX F
0 @I4@ INDI
1 NAME Davorin /Praprotnik/
1 SEX M
1 BIRT
2 DATE 2 FEB 2000
0 @O1@ OBJE
1 FILE died-young.png
1 TITL Died young
0 @S1@ SOUR
1 TITL Parish book
0 TRLR`);
  const rows = buildBatchRows(ds, nameOf, new Date(2026, 0, 15));
  const ctx = { lineSides: null };
  const match = (criteria: BatchCriterion[]) =>
    rows.filter((r) => matchesBatch(r, criteria, ctx)).map((r) => r.id).sort();

  it("matches everyone on an empty criteria list", () => {
    expect(match([])).toEqual(["@I1@", "@I2@", "@I3@", "@I4@"]);
  });

  it("computes month-aware age — at death for the deceased, to today for the living", () => {
    // Ana died 9 days before her 19th birthday → 18, so she counts as under 20;
    // Davorin has no death record → 25 at the pinned "today" (15 Jan 2026).
    expect(match([{ kind: "age", op: "lt", years: 20 }])).toEqual(["@I1@"]);
    expect(match([{ kind: "age", op: "gte", years: 20 }])).toEqual(["@I2@", "@I4@"]);
  });

  it("filters by living status (no death evidence)", () => {
    expect(match([{ kind: "living", value: true }])).toEqual(["@I3@", "@I4@"]);
    expect(match([{ kind: "living", value: false }])).toEqual(["@I1@", "@I2@"]);
    // Living with a known age: Cilka drops out — no birth date, no age.
    expect(match([
      { kind: "living", value: true },
      { kind: "age", op: "gte", years: 20 },
    ])).toEqual(["@I4@"]);
  });

  it("filters by name, sex, birth year and place (accent-blind)", () => {
    expect(match([{ kind: "name", text: "kovac" }])).toEqual(["@I2@"]);
    expect(match([{ kind: "sex", value: "F" }])).toEqual(["@I1@", "@I3@"]);
    expect(match([{ kind: "birthYear", from: 1890, to: 1910 }])).toEqual(["@I1@"]);
    expect(match([{ kind: "place", text: "skofja" }])).toEqual(["@I2@"]);
  });

  it("filters by media presence and one specific image", () => {
    expect(match([{ kind: "media", mode: "none" }])).toEqual(["@I2@", "@I3@", "@I4@"]);
    expect(match([{ kind: "media", mode: "any" }])).toEqual(["@I1@"]);
    expect(match([{ kind: "media", mode: "has", xref: "@O1@" }])).toEqual(["@I1@"]);
    expect(match([{ kind: "media", mode: "has", file: "DIED-YOUNG.png" }])).toEqual(["@I1@"]);
    expect(match([{ kind: "media", mode: "lacks", xref: "@O1@" }])).toEqual(["@I2@", "@I3@", "@I4@"]);
  });

  it("filters by source presence", () => {
    expect(match([{ kind: "sources", mode: "any" }])).toEqual(["@I2@"]);
    expect(match([{ kind: "sources", mode: "none" }])).toEqual(["@I1@", "@I3@", "@I4@"]);
  });

  it("combines criteria with AND — the died-young audit", () => {
    // Has the died-young image but reached 20: nobody in this fixture.
    expect(match([
      { kind: "media", mode: "has", xref: "@O1@" },
      { kind: "age", op: "gte", years: 20 },
    ])).toEqual([]);
  });
});

describe("computeLineSides", () => {
  const ds = dataset(FAMILY);
  const sides = computeLineSides(ds, "@I1@")!;

  it("assigns each parent's side to their own kin", () => {
    expect(sides.get("@I2@")).toBe("paternal");
    expect(sides.get("@I4@")).toBe("paternal");
    expect(sides.get("@I3@")).toBe("maternal");
    expect(sides.get("@I5@")).toBe("maternal");
  });

  it("leaves full siblings, self and own descendants on neither line", () => {
    expect(sides.has("@I6@")).toBe(false); // equal distance from both parents
    expect(sides.has("@I1@")).toBe(false);
    expect(sides.has("@I7@")).toBe(false); // only reachable through home
  });

  it("returns null without a home person or known parents", () => {
    expect(computeLineSides(ds, "@I99@")).toBeNull();
    expect(computeLineSides(ds, "@I4@")).toBeNull();
  });
});

describe("applyBatchAction", () => {
  it("attaches an existing shared image as a pointer and skips holders", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME A //
1 OBJE @O1@
0 @I2@ INDI
1 NAME B //
0 @O1@ OBJE
1 FILE maternal.png
0 TRLR`);
    const res = applyBatchAction(ds, ["@I1@", "@I2@"], { kind: "addMedia", xref: "@O1@", file: "maternal.png" });
    expect(res.changed).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.patches).toHaveLength(1);
    expect(res.patches[0].id).toBe("@I2@");
    const objes = ds.individuals.get("@I2@")!.raw.children.filter((c) => c.tag === "OBJE");
    expect(objes.map((o) => o.value)).toEqual(["@O1@"]);
    // Re-running is a no-op: everyone already carries the image.
    const again = applyBatchAction(ds, ["@I1@", "@I2@"], { kind: "addMedia", xref: "@O1@", file: "maternal.png" });
    expect(again.changed).toBe(0);
    expect(again.patches).toEqual([]);
  });

  it("creates a shared record for a new image in a shared-style file", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME A //
0 TRLR`);
    const res = applyBatchAction(ds, ["@I1@"], { kind: "addMedia", file: "paternal.png", title: "Paternal line" });
    expect(res.changed).toBe(1);
    const created = res.patches.find((p) => p.type === "record");
    expect(created).toBeDefined();
    expect(created!.before).toBeNull();
    const ptr = ds.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "OBJE")!.value;
    expect(ptr).toBe(created!.id);
  });

  it("attaches inline in an inline-style file", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME A //
1 OBJE
2 FILE existing.jpg
0 @I2@ INDI
1 NAME B //
0 TRLR`);
    const res = applyBatchAction(ds, ["@I2@"], { kind: "addMedia", file: "maternal.png" });
    expect(res.changed).toBe(1);
    const obje = ds.individuals.get("@I2@")!.raw.children.find((c) => c.tag === "OBJE")!;
    expect(obje.value).toBeUndefined();
    expect(obje.children.find((c) => c.tag === "FILE")?.value).toBe("maternal.png");
  });

  it("adds a source citation with a page, skipping existing citers", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME A //
1 SOUR @S1@
0 @I2@ INDI
1 NAME B //
0 @S1@ SOUR
1 TITL Book
0 TRLR`);
    const res = applyBatchAction(ds, ["@I1@", "@I2@"], { kind: "addSource", xref: "@S1@", page: "fol. 12" });
    expect(res.changed).toBe(1);
    expect(res.skipped).toBe(1);
    const cite = ds.individuals.get("@I2@")!.raw.children.find((c) => c.tag === "SOUR")!;
    expect(cite.value).toBe("@S1@");
    expect(cite.children.find((c) => c.tag === "PAGE")?.value).toBe("fol. 12");
  });

  it("creates a new source from a title once, for all targets", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME A //
0 @I2@ INDI
1 NAME B //
0 TRLR`);
    const res = applyBatchAction(ds, ["@I1@", "@I2@"], { kind: "addSource", title: "Status animarum" });
    expect(res.changed).toBe(2);
    const sours = ds.records.filter((r) => r.tag === "SOUR" && r.xref);
    expect(sours).toHaveLength(1);
    expect(res.patches.filter((p) => p.type === "record")).toHaveLength(1);
  });

  it("removes an image by xref or resolved file, record- and event-level", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME A //
1 OBJE @O1@
1 BIRT
2 DATE 1900
2 OBJE @O1@
0 @I2@ INDI
1 NAME B //
1 OBJE
2 FILE died-young.png
0 @I3@ INDI
1 NAME C //
1 OBJE @O2@
0 @O1@ OBJE
1 FILE died-young.png
0 @O2@ OBJE
1 FILE other.png
0 TRLR`);
    const res = applyBatchAction(ds, ["@I1@", "@I2@", "@I3@"], { kind: "removeMedia", xref: "@O1@", file: "died-young.png" });
    expect(res.changed).toBe(2);
    expect(res.skipped).toBe(1);
    const hasObje = (id: string) =>
      JSON.stringify(ds.individuals.get(id)!.raw).includes("OBJE");
    expect(hasObje("@I1@")).toBe(false);
    expect(hasObje("@I2@")).toBe(false);
    expect(hasObje("@I3@")).toBe(true);
    // The shared record itself survives.
    expect(ds.records.some((r) => r.tag === "OBJE" && r.xref === "@O1@")).toBe(true);
  });
});
