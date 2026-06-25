import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { individualFieldRows } from "../review/fields";
import type { CandidateDecision, FieldChoice } from "../review/types";
import { validateDataset } from "./validate";
import { mergeDuplicate, duplicateDefaults, relatedSeparateRecords } from "./mergeDuplicate";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const tr = (key: string) => key;
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

function decide(fields: Record<string, FieldChoice>): CandidateDecision {
  return { status: "confirmed", fields };
}

describe("mergeDuplicate", () => {
  it("removes the duplicate and keeps the survivor", () => {
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
      "0 @I2@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n",
    ));
    const patches = mergeDuplicate(ds, "@I1@", "@I2@", decide({}), tr);

    expect(ds.individuals.has("@I1@")).toBe(true);
    expect(ds.individuals.has("@I2@")).toBe(false);
    // The removed record produces a deletion patch (after: null).
    expect(patches.some((p) => p.id === "@I2@" && p.after === null)).toBe(true);
  });

  it("combines a field only one side has", () => {
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
      "0 @I2@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 DEAT\n2 DATE 1900\n",
    ));
    // Default seeding should take the incoming-only death.
    const rows = individualFieldRows(tr, ds.individuals.get("@I1@"), ds.individuals.get("@I2@"), ds, ds);
    mergeDuplicate(ds, "@I1@", "@I2@", decide(duplicateDefaults(rows)), tr);

    const survivor = ds.individuals.get("@I1@")!;
    expect(survivor.events.some((e) => e.tag === "DEAT" && e.date?.year === 1900)).toBe(true);
  });

  it("prefers the more precise date by default", () => {
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Ana /Kovač/\n1 SEX F\n1 BIRT\n2 DATE 1850\n" +
      "0 @I2@ INDI\n1 NAME Ana /Kovač/\n1 SEX F\n1 BIRT\n2 DATE 12 MAR 1850\n",
    ));
    const rows = individualFieldRows(tr, ds.individuals.get("@I1@"), ds.individuals.get("@I2@"), ds, ds);
    const defaults = duplicateDefaults(rows);
    expect(defaults["BIRT.date"]).toBe("incoming");

    mergeDuplicate(ds, "@I1@", "@I2@", decide(defaults), tr);
    const survivor = ds.individuals.get("@I1@")!;
    const birth = survivor.events.find((e) => e.tag === "BIRT");
    expect(birth?.date?.day).toBe(12);
    expect(birth?.date?.month).toBe(3);
  });

  it("re-points the removed record's spouse family onto the survivor", () => {
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Jože /Horvat/\n1 SEX M\n" +
      "0 @I2@ INDI\n1 NAME Jože /Horvat/\n1 SEX M\n1 FAMS @F1@\n" +
      "0 @I3@ INDI\n1 NAME Marija /Horvat/\n1 SEX F\n1 FAMS @F1@\n" +
      "0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 MARR\n2 DATE 1880\n",
    ));
    mergeDuplicate(ds, "@I1@", "@I2@", decide({}), tr);

    const fam = ds.families.get("@F1@")!;
    expect(fam.husband).toBe("@I1@");
    expect(ds.individuals.get("@I1@")!.spouseOf).toContain("@F1@");
    expect(ds.individuals.has("@I2@")).toBe(false);
    // No dangling pointers left behind.
    expect(validateDataset(ds).counts.brokenLink).toBe(0);
  });

  it("collapses two records of the same couple into one family", () => {
    // Both I1 and I2 are married to the same woman I3, modelled as two families.
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Jože /Horvat/\n1 SEX M\n1 FAMS @F1@\n" +
      "0 @I2@ INDI\n1 NAME Jože /Horvat/\n1 SEX M\n1 FAMS @F2@\n" +
      "0 @I3@ INDI\n1 NAME Marija /Horvat/\n1 SEX F\n1 FAMS @F1@\n1 FAMS @F2@\n" +
      "0 @I4@ INDI\n1 NAME Otrok /Horvat/\n1 SEX M\n1 FAMC @F2@\n" +
      "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I3@\n1 MARR\n2 DATE 1880\n" +
      "0 @F2@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I4@\n",
    ));
    mergeDuplicate(ds, "@I1@", "@I2@", decide({}), tr);

    const survivor = ds.individuals.get("@I1@")!;
    // The two same-couple families are folded into one.
    expect(survivor.spouseOf.length).toBe(1);
    const fam = ds.families.get(survivor.spouseOf[0])!;
    expect(fam.wife).toBe("@I3@");
    expect(fam.children).toContain("@I4@"); // child carried over
    expect(validateDataset(ds).counts.brokenLink).toBe(0);
  });

  it("keeps the survivor's parents when the parent row is set to master", () => {
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Otrok /Novak/\n1 SEX M\n1 FAMC @F1@\n" +
      "0 @I2@ INDI\n1 NAME Otrok /Novak/\n1 SEX M\n1 FAMC @F2@\n" +
      "0 @I3@ INDI\n1 NAME Oče /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
      "0 @I4@ INDI\n1 NAME Drug /Drugic/\n1 SEX M\n1 FAMS @F2@\n" +
      "0 @F1@ FAM\n1 HUSB @I3@\n1 CHIL @I1@\n" +
      "0 @F2@ FAM\n1 HUSB @I4@\n1 CHIL @I2@\n",
    ));
    mergeDuplicate(ds, "@I1@", "@I2@", decide({ father: "master" }), tr);

    const survivor = ds.individuals.get("@I1@")!;
    // Survivor keeps only its own parent family @F1@; @I4@ was not brought in.
    expect(survivor.childOf).toEqual(["@F1@"]);
    expect(validateDataset(ds).counts.brokenLink).toBe(0);
  });

  // Each Pavel is married to his *own* Barbara record (a duplicate pair the user
  // hasn't merged yet). Merging only the Pavels can't fold their families because
  // the two Barbaras are distinct records — so the children stay split.
  const twoBarbaras = wrap(
    "0 @I1@ INDI\n1 NAME Pavel /Fabjan/\n1 SEX M\n1 BIRT\n2 DATE 1770\n1 FAMS @F1@\n" +
    "0 @I2@ INDI\n1 NAME Pavel /Fabjan/\n1 SEX M\n1 BIRT\n2 DATE 1770\n1 FAMS @F2@\n" +
    "0 @I3@ INDI\n1 NAME Barbara /Gorjanc/\n1 SEX F\n1 BIRT\n2 DATE 1775\n1 FAMS @F1@\n" +
    "0 @I4@ INDI\n1 NAME Barbara /Gorjanc/\n1 SEX F\n1 BIRT\n2 DATE 1775\n1 FAMS @F2@\n" +
    "0 @I5@ INDI\n1 NAME Ivana /Fabjan/\n1 SEX F\n1 BIRT\n2 DATE 1800\n1 FAMC @F1@\n" +
    "0 @I6@ INDI\n1 NAME Franc /Fabjan/\n1 SEX M\n1 BIRT\n2 DATE 1798\n1 FAMC @F2@\n" +
    "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I3@\n1 CHIL @I5@\n" +
    "0 @F2@ FAM\n1 HUSB @I2@\n1 WIFE @I4@\n1 CHIL @I6@\n",
  );

  it("flags a spouse that is a separate record on each side", () => {
    const ds = dataset(twoBarbaras);
    const rows = individualFieldRows(tr, ds.individuals.get("@I1@"), ds.individuals.get("@I2@"), ds, ds);
    const related = relatedSeparateRecords(rows);
    expect(related).toEqual([
      { aId: "@I3@", bId: "@I4@", label: "Barbara Gorjanc", relation: "partner" },
    ]);
  });

  it("does not flag a spouse that is already a single shared record", () => {
    // Same couple modelled as two families but one Barbara record (@I3@): nothing
    // to also-merge, so no related-record hint.
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Pavel /Fabjan/\n1 SEX M\n1 FAMS @F1@\n" +
      "0 @I2@ INDI\n1 NAME Pavel /Fabjan/\n1 SEX M\n1 FAMS @F2@\n" +
      "0 @I3@ INDI\n1 NAME Barbara /Gorjanc/\n1 SEX F\n1 FAMS @F1@\n1 FAMS @F2@\n" +
      "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I3@\n" +
      "0 @F2@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n",
    ));
    const rows = individualFieldRows(tr, ds.individuals.get("@I1@"), ds.individuals.get("@I2@"), ds, ds);
    expect(relatedSeparateRecords(rows)).toEqual([]);
  });

  it("combines the children once both the couple's duplicates are merged", () => {
    const ds = dataset(twoBarbaras);
    // Merge the Pavels first: families stay split because the two Barbaras differ.
    mergeDuplicate(ds, "@I1@", "@I2@", decide({}), tr);
    expect(ds.individuals.get("@I1@")!.spouseOf.length).toBe(2);

    // Now merge the Barbaras: the families collapse and the children come together.
    mergeDuplicate(ds, "@I3@", "@I4@", decide({}), tr);
    const pavel = ds.individuals.get("@I1@")!;
    expect(pavel.spouseOf.length).toBe(1);
    const fam = ds.families.get(pavel.spouseOf[0])!;
    expect(fam.wife).toBe("@I3@");
    expect(fam.children).toContain("@I5@"); // Ivana
    expect(fam.children).toContain("@I6@"); // Franc
    expect(validateDataset(ds).counts.brokenLink).toBe(0);
  });

  it("produces patches whose `before` snapshots restore the pre-merge state", () => {
    const text = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
      "0 @I2@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 12 MAR 1850\n1 DEAT\n2 DATE 1900\n",
    );
    const ds = dataset(text);
    const beforeI1 = serializeGedcom([ds.individuals.get("@I1@")!.raw]);
    const beforeI2 = serializeGedcom([ds.individuals.get("@I2@")!.raw]);

    const rows = individualFieldRows(tr, ds.individuals.get("@I1@"), ds.individuals.get("@I2@"), ds, ds);
    const patches = mergeDuplicate(ds, "@I1@", "@I2@", decide(duplicateDefaults(rows)), tr);

    const p1 = patches.find((p) => p.id === "@I1@");
    const p2 = patches.find((p) => p.id === "@I2@");
    expect(p1?.before && serializeGedcom([p1.before])).toBe(beforeI1);
    expect(p2?.before && serializeGedcom([p2.before])).toBe(beforeI2);
    expect(p2?.after).toBeNull();
  });
});
