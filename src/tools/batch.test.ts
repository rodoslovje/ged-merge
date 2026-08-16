import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { Dataset } from "../gedcom/types";
import { marriedSurnamesOf } from "../match/relatives";
import {
  ANY_EVENT,
  ANY_VENDOR_EVENT,
  applyBatchAction,
  buildBatchRows,
  computeKinship,
  computeLineSides,
  matchesBatch,
  previewBirthEstimates,
  previewMarriedNames,
  readMarriedNames,
  unionMarriage,
  unionMarriageByChildren,
  type BatchCriterion,
  type KinshipSets,
} from "./batch";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const nameOf = (indi: { names: { full: string }[] }) => indi.names[0]?.full ?? "?";

/** Home @I1@ with father @I2@, mother @I3@; paternal grandfather @I4@;
 *  maternal grandmother @I5@; full sibling @I6@; home's child @I7@ with
 *  the other parent (home's partner, no blood relation) @I8@. */
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
0 @I8@ INDI
1 NAME Partner //
1 SEX F
1 FAMS @F3@
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
1 WIFE @I8@
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
1 OCCU Farmer
1 SOUR @S1@
0 @I3@ INDI
1 NAME Cilka /Zupan/
1 SEX F
1 NOTE https://web.facebook.com/cilka.zupan
2 PRIV
0 @I4@ INDI
1 NAME Davorin /Praprotnik/
1 SEX M
1 BIRT
2 DATE 2 FEB 2000
2 NOTE Baptised in Šenčur
1 _MILT army
0 @O1@ OBJE
1 FILE died-young.png
1 TITL Died young
0 @S1@ SOUR
1 TITL Parish book
0 TRLR`);
  const rows = buildBatchRows(ds, nameOf, new Date(2026, 0, 15));
  const ctx = { lineSides: null, kinship: null };
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

  it("scopes the name filter to the given name or the surname", () => {
    // "an" is in Ana (given) and Zupan (surname) — the scope tells them apart.
    expect(match([{ kind: "name", text: "an" }])).toEqual(["@I1@", "@I3@"]);
    expect(match([{ kind: "name", text: "an", part: "given" }])).toEqual(["@I1@"]);
    expect(match([{ kind: "name", text: "an", part: "surname" }])).toEqual(["@I3@"]);
  });

  it("filters by name, sex, birth year and place (accent-blind)", () => {
    expect(match([{ kind: "name", text: "kovac" }])).toEqual(["@I2@"]);
    expect(match([{ kind: "sex", value: "F" }])).toEqual(["@I1@", "@I3@"]);
    expect(match([{ kind: "birthYear", from: 1890, to: 1910 }])).toEqual(["@I1@"]);
    expect(match([{ kind: "place", text: "skofja" }])).toEqual(["@I2@"]);
  });

  it("finds people by what their notes say, wherever the note hangs", () => {
    // The case this exists for: a note that is nothing but a URL. The display
    // copy of such a note has the URL stripped out and is empty, so the filter
    // reads the verbatim text — and a private note is still findable in one's
    // own file, which is the only place this search runs.
    expect(match([{ kind: "note", text: "facebook.com" }])).toEqual(["@I3@"]);
    expect(match([{ kind: "note", text: "cilka.zupan" }])).toEqual(["@I3@"]);
    // An event's note counts too, and the match is accent-blind like the rest.
    expect(match([{ kind: "note", text: "sencur" }])).toEqual(["@I4@"]);
    expect(match([{ kind: "note", text: "nobody wrote this" }])).toEqual([]);
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

  it("filters by event presence — the missing-record audit", () => {
    expect(match([{ kind: "event", tag: "BIRT", mode: "lacks" }])).toEqual(["@I3@"]);
    expect(match([{ kind: "event", tag: "DEAT", mode: "lacks" }])).toEqual(["@I3@", "@I4@"]);
    expect(match([{ kind: "event", tag: "OCCU", mode: "has" }])).toEqual(["@I2@"]);
    expect(match([{ kind: "event", tag: "OCCU", mode: "lacks" }])).toEqual(["@I1@", "@I3@", "@I4@"]);
  });

  it("matches any non-standard event via the sentinel tag", () => {
    expect(match([{ kind: "event", tag: ANY_VENDOR_EVENT, mode: "has" }])).toEqual(["@I4@"]);
    expect(match([{ kind: "event", tag: ANY_VENDOR_EVENT, mode: "lacks" }])).toEqual(["@I1@", "@I2@", "@I3@"]);
  });

  it("combines criteria with AND — the died-young audit", () => {
    // Has the died-young image but reached 20: nobody in this fixture.
    expect(match([
      { kind: "media", mode: "has", xref: "@O1@" },
      { kind: "age", op: "gte", years: 20 },
    ])).toEqual([]);
  });
});

describe("name-part and relative presence criteria", () => {
  // @I1@ married name inline (_MARNM), partnered; @I2@ her husband, child in a
  // family that names no parent; @I3@ no surname, sole spouse of a family with
  // a child; @I4@ no surname but a separate `TYPE married` name; @I5@ has a
  // known mother; @I6@ surname only; @I7@ partnered woman with no married name.
  const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
2 _MARNM /Kovač/
1 SEX F
1 FAMS @F1@
0 @I2@ INDI
1 NAME Bo /Kovač/
1 SEX M
1 FAMS @F1@
1 FAMC @F3@
0 @I3@ INDI
1 NAME Marija //
1 SEX F
1 FAMS @F2@
0 @I4@ INDI
1 NAME Jera //
1 SEX F
1 NAME Jera /Zupančič/
2 TYPE married
0 @I5@ INDI
1 NAME Tone /Novak/
1 SEX M
1 FAMC @F2@
0 @I6@ INDI
1 NAME /Zupan/
1 SEX F
0 @I7@ INDI
1 NAME Neža /Hribar/
1 SEX F
1 FAMS @F4@
0 @I8@ INDI
1 NAME Rok /Hribar/
1 SEX M
1 FAMS @F4@
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I1@
0 @F2@ FAM
1 WIFE @I3@
1 CHIL @I5@
0 @F3@ FAM
1 CHIL @I2@
0 @F4@ FAM
1 HUSB @I8@
1 WIFE @I7@
0 TRLR`);
  const rows = buildBatchRows(ds, nameOf);
  const match = (criteria: BatchCriterion[]) =>
    rows.filter((r) => matchesBatch(r, criteria, { lineSides: null, kinship: null })).map((r) => r.id).sort();

  it("reads the given name and surname off the primary name", () => {
    expect(match([{ kind: "nameField", field: "given", mode: "lacks" }])).toEqual(["@I6@"]);
    // @I4@ counts as surname-less: her only surname is on the married name.
    expect(match([{ kind: "nameField", field: "surname", mode: "lacks" }])).toEqual(["@I3@", "@I4@"]);
  });

  it("finds a married name in either notation", () => {
    expect(match([{ kind: "nameField", field: "married", mode: "has" }])).toEqual(["@I1@", "@I4@"]);
  });

  it("requires a second spouse for a partner, and a named parent for parents", () => {
    // @I3@ is a lone spouse — a family slot on its own is not a partner.
    expect(match([{ kind: "relation", rel: "spouse", mode: "has" }]))
      .toEqual(["@I1@", "@I2@", "@I7@", "@I8@"]);
    expect(match([{ kind: "relation", rel: "children", mode: "has" }])).toEqual(["@I3@"]);
    // @I2@ is a child of @F3@, which names neither parent.
    expect(match([{ kind: "relation", rel: "parents", mode: "has" }])).toEqual(["@I5@"]);
  });

  it("answers the two women-without-a-name audits", () => {
    expect(match([
      { kind: "sex", value: "F" },
      { kind: "nameField", field: "surname", mode: "lacks" },
      { kind: "nameField", field: "married", mode: "lacks" },
    ])).toEqual(["@I3@"]);
    expect(match([
      { kind: "sex", value: "F" },
      { kind: "relation", rel: "spouse", mode: "has" },
      { kind: "nameField", field: "married", mode: "lacks" },
    ])).toEqual(["@I7@"]);
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

describe("computeKinship", () => {
  const ds = dataset(FAMILY);
  const rows = buildBatchRows(ds, nameOf);
  const kinship = computeKinship(ds, "@I1@")!;
  const match = (criteria: BatchCriterion[], k: KinshipSets | null = kinship) =>
    rows.filter((r) => matchesBatch(r, criteria, { lineSides: null, kinship: k })).map((r) => r.id).sort();

  it("classifies ancestors, descendants and blood relatives", () => {
    expect(match([{ kind: "kinship", rel: "ancestor" }])).toEqual(["@I2@", "@I3@", "@I4@", "@I5@"]);
    expect(match([{ kind: "kinship", rel: "descendant" }])).toEqual(["@I7@"]);
    // Blood = self + ancestors + all their descendants (sibling, own child)…
    expect(match([{ kind: "kinship", rel: "blood" }]))
      .toEqual(["@I1@", "@I2@", "@I3@", "@I4@", "@I5@", "@I6@", "@I7@"]);
    // …and the partner is related only by marriage.
    expect(match([{ kind: "kinship", rel: "notBlood" }])).toEqual(["@I8@"]);
  });

  it("matches nobody without a start person", () => {
    expect(match([{ kind: "kinship", rel: "blood" }], null)).toEqual([]);
    expect(computeKinship(ds, "@I99@")).toBeNull();
  });
});

describe("addMarriedName action", () => {
  /** @I1@ takes her husband's surname; @I2@ already has a married name; @I3@'s
   *  husband has no surname; @I4@ has no partner; @I5@ married a man with her
   *  own surname; @I6@ has two unions, the first husband surname-less. */
  const FILE = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 SEX F
1 FAMS @F1@
0 @H1@ INDI
1 NAME Bo /Kovač/
1 SEX M
1 FAMS @F1@
0 @I2@ INDI
1 NAME Cilka /Zupan/
1 SEX F
1 NAME /Rakar/
2 TYPE married
1 FAMS @F2@
0 @H2@ INDI
1 NAME Dare /Rakar/
1 SEX M
1 FAMS @F2@
0 @I3@ INDI
1 NAME Eva /Bizjak/
1 SEX F
1 FAMS @F3@
0 @H3@ INDI
1 NAME Franc //
1 SEX M
1 FAMS @F3@
0 @I4@ INDI
1 NAME Greta /Hribar/
1 SEX F
0 @I5@ INDI
1 NAME Ida /Jereb/
1 SEX F
1 FAMS @F5@
0 @H5@ INDI
1 NAME Jaka /Jereb/
1 SEX M
1 FAMS @F5@
0 @I6@ INDI
1 NAME Klara /Lah/
1 SEX F
1 FAMS @F6@
1 FAMS @F7@
0 @H6@ INDI
1 NAME Lojze //
1 SEX M
1 FAMS @F6@
0 @H7@ INDI
1 NAME Miha /Oblak/
1 SEX M
1 FAMS @F7@
0 @F1@ FAM
1 HUSB @H1@
1 WIFE @I1@
0 @F2@ FAM
1 HUSB @H2@
1 WIFE @I2@
0 @F3@ FAM
1 HUSB @H3@
1 WIFE @I3@
0 @F5@ FAM
1 HUSB @H5@
1 WIFE @I5@
0 @F6@ FAM
1 HUSB @H6@
1 WIFE @I6@
1 MARR
2 DATE 1900
0 @F7@ FAM
1 HUSB @H7@
1 WIFE @I6@
1 MARR
2 DATE 1910
0 TRLR`;
  const ids = ["@I1@", "@I2@", "@I3@", "@I4@", "@I5@", "@I6@"];

  it("previews only the people a partner surname is available for", () => {
    const preview = [...previewMarriedNames(dataset(FILE), ids)].map(([id, s]) => [id, s.map((x) => x.surname)]);
    expect(preview).toEqual([
      ["@I1@", ["Kovač"]],
      // @I6@'s surname-less first husband contributes nothing, the second does.
      ["@I6@", ["Oblak"]],
    ]);
  });

  it("writes the file's own record form and skips the rest", () => {
    const ds = dataset(FILE);
    const res = applyBatchAction(ds, ids, { kind: "addMarriedName" });
    expect(res.changed).toBe(2);
    expect(res.skipped).toBe(4);
    const ana = ds.individuals.get("@I1@")!;
    expect(ana.names.map((n) => [n.full, n.type])).toEqual([["Ana Novak", undefined], ["Kovač", "married"]]);
    expect(ana.raw.children.filter((c) => c.tag === "NAME").map((c) => c.value)).toEqual(["Ana /Novak/", "/Kovač/"]);
    expect(marriedSurnamesOf(ana)).toEqual(["Kovač"]);
    // Re-running is a no-op — everyone now has a married name or no source for one.
    expect(applyBatchAction(ds, ids, { kind: "addMarriedName" })).toMatchObject({ changed: 0, patches: [] });
  });

  it("follows a file that carries married names inline as _MARNM", () => {
    const ds = dataset(
      FILE.replace("1 NAME Cilka /Zupan/\n1 SEX F\n1 NAME /Rakar/\n2 TYPE married", "1 NAME Cilka /Zupan/\n2 _MARNM /Rakar/\n1 SEX F"),
    );
    applyBatchAction(ds, ids, { kind: "addMarriedName" });
    const ana = ds.individuals.get("@I1@")!;
    expect(ana.names).toHaveLength(1);
    expect(ana.names[0].married).toBe("Kovač");
  });

  it("falls back to the standard record form when the file has no married name at all", () => {
    const ds = dataset(FILE.replace("1 NAME /Rakar/\n2 TYPE married\n", ""));
    applyBatchAction(ds, ids, { kind: "addMarriedName" });
    expect(ds.individuals.get("@I1@")!.names[1]).toMatchObject({ full: "Kovač", type: "married" });
  });
});

describe("addMarriedName across unions", () => {
  /** @W1@ married twice — @FB@ (Kovač) in 1880 before @FA@ (Novak) in 1890,
   *  the reverse of the file order. @W2@'s union records no marriage and her
   *  child carries her own surname; @W3@'s is noted as a partnership. */
  const FILE = `0 HEAD
1 CHAR UTF-8
0 @W1@ INDI
1 NAME Marija /Kos/
1 SEX F
1 FAMS @FA@
1 FAMS @FB@
0 @M1@ INDI
1 NAME Anton /Novak/
1 SEX M
1 FAMS @FA@
0 @M2@ INDI
1 NAME Blaž /Kovač/
1 SEX M
1 FAMS @FB@
0 @W2@ INDI
1 NAME Neža /Potok/
1 SEX F
1 FAMS @FC@
0 @M3@ INDI
1 NAME Ciril /Rus/
1 SEX M
1 FAMS @FC@
0 @C1@ INDI
1 NAME Jera /Potok/
1 SEX F
1 FAMC @FC@
0 @W3@ INDI
1 NAME Ema /Sever/
1 SEX F
1 FAMS @FD@
0 @M4@ INDI
1 NAME Davorin /Turk/
1 SEX M
1 FAMS @FD@
0 @FA@ FAM
1 HUSB @M1@
1 WIFE @W1@
1 MARR
2 DATE 1890
0 @FB@ FAM
1 HUSB @M2@
1 WIFE @W1@
1 MARR
2 DATE 1880
0 @FC@ FAM
1 HUSB @M3@
1 WIFE @W2@
1 CHIL @C1@
0 @FD@ FAM
1 HUSB @M4@
1 WIFE @W3@
1 _MSTAT Partners
0 TRLR`;
  const ids = ["@W1@", "@W2@", "@W3@"];
  const surnamesOf = (ds: Dataset, id: string) =>
    (previewMarriedNames(ds, [id]).get(id) ?? []).map((s) => s.surname);

  it("takes a surname from every union, ordered by marriage date", () => {
    const ds = dataset(FILE);
    expect(surnamesOf(ds, "@W1@")).toEqual(["Kovač", "Novak"]);
    const res = applyBatchAction(ds, ids, { kind: "addMarriedName" });
    expect(res.changed).toBe(3);
    const w1 = ds.individuals.get("@W1@")!;
    expect(w1.names.map((n) => [n.full, n.type])).toEqual([
      ["Marija Kos", undefined], ["Kovač", "married"], ["Novak", "married"],
    ]);
    expect(marriedSurnamesOf(w1, ds)).toEqual(["Kovač", "Novak"]);
  });

  it("comma-joins several unions into the single _MARNM the tag convention has", () => {
    const ds = dataset(FILE.replace("0 @W3@ INDI\n1 NAME Ema /Sever/", "0 @W3@ INDI\n1 NAME Ema /Sever/\n2 _MARNM Turk"));
    applyBatchAction(ds, ["@W1@"], { kind: "addMarriedName" });
    const w1 = ds.individuals.get("@W1@")!;
    expect(w1.names).toHaveLength(1);
    expect(w1.names[0].married).toBe("Kovač, Novak");
  });

  it("adds the second marriage to a person already carrying the first name", () => {
    const ds = dataset(FILE.replace("1 NAME Marija /Kos/", "1 NAME Marija /Kos/\n1 NAME /Kovač/\n2 TYPE married"));
    expect(previewMarriedNames(ds, ["@W1@"]).get("@W1@")).toEqual([
      { surname: "Kovač", marriage: "married", byChildren: false, recorded: true },
      { surname: "Novak", marriage: "married", byChildren: false, recorded: false },
    ]);
    applyBatchAction(ds, ["@W1@"], { kind: "addMarriedName" });
    expect(marriedSurnamesOf(ds.individuals.get("@W1@")!, ds)).toEqual(["Kovač", "Novak"]);
  });

  it("reads the marriage evidence a union carries, or the one its children imply", () => {
    const ds = dataset(FILE);
    expect(unionMarriage(ds.families.get("@FA@")!)).toBe("married");
    expect(unionMarriage(ds.families.get("@FD@")!)).toBe("unmarried");
    // Nothing recorded on @FC@ — the child's surname is the only signal.
    expect(unionMarriage(ds.families.get("@FC@")!)).toBe("unknown");
    expect(unionMarriageByChildren(ds, ds.families.get("@FC@")!)).toBe("unmarried");
    // A child carrying the father's surname reads the other way.
    const married = dataset(FILE.replace("1 NAME Jera /Potok/", "1 NAME Jera /Rus/"));
    expect(unionMarriageByChildren(married, married.families.get("@FC@")!)).toBe("married");
  });

  it("leaves the doubtful people unchecked but keeps their preview", () => {
    const ds = dataset(FILE);
    const preview = previewMarriedNames(ds, ids);
    expect(readMarriedNames(preview.get("@W1@")!)).toMatchObject({ doubt: null, evidenced: true });
    expect(readMarriedNames(preview.get("@W2@")!)).toMatchObject({
      surnames: ["Rus"], doubt: "children", evidenced: false,
    });
    expect(readMarriedNames(preview.get("@W3@")!)).toMatchObject({
      surnames: ["Turk"], doubt: "partners", evidenced: false,
    });
    // An undocumented union is a doubt of its own, not a verdict.
    const bare = dataset(FILE.replace("1 _MSTAT Partners\n", ""));
    expect(readMarriedNames(previewMarriedNames(bare, ["@W3@"]).get("@W3@")!)).toMatchObject({
      doubt: "noMarriage", evidenced: false,
    });
  });

  it("filters on the events of the person's unions", () => {
    const ds = dataset(FILE);
    const rows = buildBatchRows(ds, nameOf);
    const match = (c: BatchCriterion[]) =>
      rows.filter((r) => matchesBatch(r, c, { lineSides: null, kinship: null })).map((r) => r.id).sort();
    // The question the married-name action raises: partnered, but never married.
    expect(match([
      { kind: "relation", rel: "spouse", mode: "has" },
      { kind: "familyEvent", tag: "MARR", mode: "lacks" },
    ])).toEqual(["@M3@", "@M4@", "@W2@", "@W3@"]);
    // @FC@ records nothing at all; @FD@ at least carries a status.
    expect(match([{ kind: "familyEvent", tag: ANY_EVENT, mode: "lacks" }])).toEqual(["@C1@", "@M3@", "@W2@"]);
    expect(match([{ kind: "familyEvent", tag: "_MSTAT", mode: "has" }])).toEqual(["@M4@", "@W3@"]);
    // One union with a marriage is enough for "has".
    expect(match([{ kind: "familyEvent", tag: "MARR", mode: "has" }])).toEqual(["@M1@", "@M2@", "@W1@"]);
  });

  it("counts a divorce and Brother's Keeper's flags as evidence either way", () => {
    const divorced = dataset(FILE.replace("1 _MSTAT Partners", "1 DIV\n2 DATE 1899"));
    expect(unionMarriage(divorced.families.get("@FD@")!)).toBe("married");
    const never = dataset(FILE.replace("1 _MSTAT Partners", "1 _NMR"));
    expect(unionMarriage(never.families.get("@FD@")!)).toBe("unmarried");
    const flagged = dataset(FILE.replace("1 _MSTAT Partners", "1 _MARRIED N"));
    expect(unionMarriage(flagged.families.get("@FD@")!)).toBe("unmarried");
  });
});

describe("applyBatchAction", () => {
  it("marks people deceased with an undated DEAT Y, skipping death evidence", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME A //
1 DEAT
2 DATE 1900
0 @I2@ INDI
1 NAME B //
1 BIRT
2 DATE 1850
0 @I3@ INDI
1 NAME C //
1 BURI
0 TRLR`);
    const res = applyBatchAction(ds, ["@I1@", "@I2@", "@I3@"], { kind: "markDeceased" });
    expect(res.changed).toBe(1);
    expect(res.skipped).toBe(2);
    expect(res.patches.map((p) => p.id)).toEqual(["@I2@"]);
    const raw = ds.individuals.get("@I2@")!.raw;
    const deat = raw.children.find((c) => c.tag === "DEAT")!;
    expect(deat.value).toBe("Y");
    expect(deat.children).toEqual([]); // undated
    const tags = raw.children.map((c) => c.tag);
    expect(tags.indexOf("BIRT")).toBeLessThan(tags.indexOf("DEAT")); // canonical order
    // Re-running is a no-op: everyone now carries death evidence.
    const again = applyBatchAction(ds, ["@I1@", "@I2@", "@I3@"], { kind: "markDeceased" });
    expect(again.changed).toBe(0);
    expect(again.patches).toEqual([]);
  });

  it("writes ABT birth estimates without chaining, skipping anyone dated", () => {
    // Three generations: only grandfather @I2@ is dated. His child @I1@ is
    // estimable (parent + a generation); @I1@'s child @I3@ has no dated
    // relative before the run, so estimating them would require chaining
    // off @I1@'s own fresh estimate.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Middle //
1 FAMC @F1@
1 FAMS @F2@
0 @I2@ INDI
1 NAME Grandpa //
1 SEX M
1 FAMS @F1@
1 BIRT
2 DATE 1850
0 @I3@ INDI
1 NAME Youngest //
1 FAMC @F2@
0 @I4@ INDI
1 NAME Undated Birt //
1 BIRT
2 PLAC Kranj
1 FAMS @F3@
0 @I5@ INDI
1 NAME Dated Spouse //
1 SEX F
1 BIRT
2 DATE 12 MAY 1880
1 FAMS @F3@
0 @F1@ FAM
1 HUSB @I2@
1 CHIL @I1@
0 @F2@ FAM
1 HUSB @I1@
1 CHIL @I3@
0 @F3@ FAM
1 HUSB @I4@
1 WIFE @I5@
0 TRLR`);
    const ids = ["@I1@", "@I2@", "@I3@", "@I4@", "@I5@"];
    const res = applyBatchAction(ds, ids, { kind: "estimateBirth" });
    // @I1@ from father 1850, @I4@ from spouse 1880; @I2@/@I5@ dated, @I3@ unestimable.
    expect(res.changed).toBe(2);
    expect(res.skipped).toBe(3);
    expect(res.patches.map((p) => p.id).sort()).toEqual(["@I1@", "@I4@"]);
    const birtOf = (id: string) => ds.individuals.get(id)!.raw.children.find((c) => c.tag === "BIRT")!;
    // Father 1850 + a generation = 1878, rounded to the nearest 5.
    expect(birtOf("@I1@").children.map((c) => [c.tag, c.value])).toEqual([["DATE", "ABT 1880"]]);
    // The undated BIRT node gained a DATE and kept its place.
    expect(birtOf("@I4@").children.map((c) => [c.tag, c.value])).toEqual([
      ["DATE", "ABT 1880"],
      ["PLAC", "Kranj"],
    ]);
    // @I5@'s recorded date is untouched.
    expect(birtOf("@I5@").children).toEqual([{ level: 2, tag: "DATE", value: "12 MAY 1880", children: [] }]);
    // Re-running reaches @I3@ through @I1@'s now-written estimate; the rest skip.
    const again = applyBatchAction(ds, ids, { kind: "estimateBirth" });
    expect(again.changed).toBe(1);
    expect(again.skipped).toBe(4);
    expect(birtOf("@I3@").children.map((c) => [c.tag, c.value])).toEqual([["DATE", "ABT 1910"]]);
  });

  it("keeps sibling estimates distinct: spread around the parent guess, or anchored on a dated sibling", () => {
    // Family A: dated mother, three undated children — all would share
    // 1850+28≈1880; instead they spread a step apart in listed order.
    // Family B: parents undated, first child dated 1882 — the other two anchor
    // on that sibling, and the father estimates from his child as before.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @M1@ INDI
1 NAME Mother //
1 SEX F
1 BIRT
2 DATE 1850
1 FAMS @FA@
0 @C1@ INDI
1 NAME First //
1 FAMC @FA@
0 @C2@ INDI
1 NAME Second //
1 FAMC @FA@
0 @C3@ INDI
1 NAME Third //
1 FAMC @FA@
0 @P1@ INDI
1 NAME Father //
1 SEX M
1 FAMS @FB@
0 @D1@ INDI
1 NAME Dated //
1 FAMC @FB@
1 BIRT
2 DATE 1882
0 @C4@ INDI
1 NAME Fourth //
1 FAMC @FB@
0 @C5@ INDI
1 NAME Fifth //
1 FAMC @FB@
0 @FA@ FAM
1 WIFE @M1@
1 CHIL @C1@
1 CHIL @C2@
1 CHIL @C3@
0 @FB@ FAM
1 HUSB @P1@
1 CHIL @D1@
1 CHIL @C4@
1 CHIL @C5@
0 TRLR`);
    const ids = ["@C1@", "@C2@", "@C3@", "@C4@", "@C5@", "@P1@"];
    // The preview is a pure dry-run: it reports the exact years the action
    // then writes, and dated @D1@ (queried too) gets no entry.
    const preview = previewBirthEstimates(ds, [...ids, "@D1@"]);
    expect(Object.fromEntries(preview)).toEqual({
      "@C1@": 1879, "@C2@": 1880, "@C3@": 1881, "@C4@": 1883, "@C5@": 1884, "@P1@": 1855,
    });
    expect(ds.individuals.get("@C1@")!.raw.children.some((c) => c.tag === "BIRT")).toBe(false);
    const res = applyBatchAction(ds, ids, { kind: "estimateBirth" });
    expect(res.changed).toBe(6);
    expect(res.skipped).toBe(0);
    const abtOf = (id: string) =>
      ds.individuals.get(id)!.raw.children.find((c) => c.tag === "BIRT")!.children[0].value;
    // Spread a year apart around the shared 1880 guess, in the family's child order.
    expect([abtOf("@C1@"), abtOf("@C2@"), abtOf("@C3@")]).toEqual(["ABT 1879", "ABT 1880", "ABT 1881"]);
    // Anchored one and two years after the dated 1882 sibling (unrounded) —
    // even though no parent is dated and estimateBirthYear finds nothing.
    expect([abtOf("@C4@"), abtOf("@C5@")]).toEqual(["ABT 1883", "ABT 1884"]);
    // The father's estimate comes from his own child — no sibling adjustment.
    expect(abtOf("@P1@")).toBe("ABT 1855");
  });

  it("converts vendor events to a named EVEN, keeping the substructure", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME A //
1 _FNRL
2 DATE 1 JAN 1900
2 PLAC Kranj
0 @I2@ INDI
1 NAME B //
1 _INTE
2 DATE 1950
0 TRLR`);
    const res = applyBatchAction(ds, ["@I1@", "@I2@"], {
      kind: "convertEvent", fromTag: "_FNRL", toTag: "EVEN", type: "Funeral",
    });
    expect(res.changed).toBe(1);
    expect(res.skipped).toBe(1); // @I2@ has no _FNRL
    const even = ds.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "EVEN")!;
    expect(even.children.map((c) => [c.tag, c.value])).toEqual([
      ["TYPE", "Funeral"],
      ["DATE", "1 JAN 1900"],
      ["PLAC", "Kranj"],
    ]);
    // Re-running finds nothing left to convert.
    const again = applyBatchAction(ds, ["@I1@", "@I2@"], {
      kind: "convertEvent", fromTag: "_FNRL", toTag: "EVEN", type: "Funeral",
    });
    expect(again.changed).toBe(0);

    // Standard targets take no TYPE — the tag itself is the name.
    applyBatchAction(ds, ["@I2@"], { kind: "convertEvent", fromTag: "_INTE", toTag: "BURI", type: "x" });
    const buri = ds.individuals.get("@I2@")!.raw.children.find((c) => c.tag === "BURI")!;
    expect(buri.children.map((c) => c.tag)).toEqual(["DATE"]);
  });

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
