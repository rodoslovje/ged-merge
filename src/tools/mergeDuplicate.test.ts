import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { applyRecordPatches } from "../ui/historyTypes";
import { individualFieldRows } from "../review/fields";
import type { CandidateDecision, FieldChoice } from "../review/types";
import { validateDataset } from "./validate";
import { removeIndividual } from "../gedcom/edit";
import { findDuplicates, makeDuplicatePair } from "./duplicates";
import { clusterMergeSteps } from "./mergeCluster";
import {
  mergeDuplicate,
  mergeDuplicateChain,
  duplicateDefaults,
  relatedMergeOrder,
  relatedSeparateRecords,
} from "./mergeDuplicate";

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

  it("repoints a third record naming the folded family, and undoes it", () => {
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Jože /Horvat/\n1 SEX M\n1 FAMS @F1@\n" +
      "0 @I2@ INDI\n1 NAME Jože /Horvat/\n1 SEX M\n1 FAMS @F2@\n" +
      "0 @I3@ INDI\n1 NAME Marija /Horvat/\n1 SEX F\n1 FAMS @F1@\n1 FAMS @F2@\n" +
      "0 @I5@ INDI\n1 NAME Priča /Kos/\n1 ASSO @F2@\n2 RELA Witness\n" +
      "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I3@\n1 MARR\n2 DATE 1880\n" +
      "0 @F2@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n",
    ));
    const original = serializeGedcom(ds.records);
    const patches = mergeDuplicate(ds, "@I1@", "@I2@", decide({}), tr);
    expect(ds.families.has("@F2@")).toBe(false);
    expect(ds.individuals.get("@I5@")!.raw.children.find((c) => c.tag === "ASSO")?.value).toBe("@F1@");
    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records)).toBe(original);
  });

  // A person has one set of parents, so the two parent families are an
  // either/or choice — not the union partners and children get.
  const twoParentCouples = wrap(
    "0 @I1@ INDI\n1 NAME Otrok /Novak/\n1 SEX M\n1 FAMC @F1@\n" +
    "0 @I2@ INDI\n1 NAME Otrok /Novak/\n1 SEX M\n1 FAMC @F2@\n" +
    "0 @I3@ INDI\n1 NAME Oče /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
    "0 @I5@ INDI\n1 NAME Mati /Novak/\n1 SEX F\n1 FAMS @F1@\n" +
    "0 @I4@ INDI\n1 NAME Drug /Drugic/\n1 SEX M\n1 FAMS @F2@\n" +
    "0 @I6@ INDI\n1 NAME Druga /Drugic/\n1 SEX F\n1 FAMS @F2@\n" +
    "0 @F1@ FAM\n1 HUSB @I3@\n1 WIFE @I5@\n1 CHIL @I1@\n" +
    "0 @F2@ FAM\n1 HUSB @I4@\n1 WIFE @I6@\n1 CHIL @I2@\n",
  );

  it("keeps the survivor's own parents by default", () => {
    const ds = dataset(twoParentCouples);
    const rows = individualFieldRows(tr, ds.individuals.get("@I1@"), ds.individuals.get("@I2@"), ds, ds);
    expect(duplicateDefaults(rows)["parents"]).toBe("main");

    mergeDuplicate(ds, "@I1@", "@I2@", decide({}), tr);

    const survivor = ds.individuals.get("@I1@")!;
    // Only its own parent family @F1@; the candidate's parents were not added.
    expect(survivor.childOf).toEqual(["@F1@"]);
    // @F2@ and its people survive, just without this child — the duplicate
    // finder can still merge @I3@/@I4@ and @I5@/@I6@ afterwards.
    expect(ds.families.get("@F2@")!.children).toEqual([]);
    expect(ds.individuals.has("@I4@")).toBe(true);
    expect(validateDataset(ds).counts.brokenLink).toBe(0);
  });

  it("swaps in the candidate's parents when the parents choice is incoming", () => {
    const ds = dataset(twoParentCouples);
    mergeDuplicate(ds, "@I1@", "@I2@", decide({ parents: "incoming" }), tr);

    const survivor = ds.individuals.get("@I1@")!;
    expect(survivor.childOf).toEqual(["@F2@"]);
    expect(ds.families.get("@F1@")!.children).toEqual([]);
    expect(validateDataset(ds).counts.brokenLink).toBe(0);
  });

  it("keeps both parent families when the parents choice is both", () => {
    const ds = dataset(twoParentCouples);
    mergeDuplicate(ds, "@I1@", "@I2@", decide({ parents: "both" }), tr);

    const survivor = ds.individuals.get("@I1@")!;
    expect(new Set(survivor.childOf)).toEqual(new Set(["@F1@", "@F2@"]));
    expect(validateDataset(ds).counts.brokenLink).toBe(0);
  });

  it("inherits the candidate's parents when the survivor has none", () => {
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Otrok /Novak/\n1 SEX M\n" +
      "0 @I2@ INDI\n1 NAME Otrok /Novak/\n1 SEX M\n1 FAMC @F2@\n" +
      "0 @I4@ INDI\n1 NAME Oče /Novak/\n1 SEX M\n1 FAMS @F2@\n" +
      "0 @I6@ INDI\n1 NAME Mati /Novak/\n1 SEX F\n1 FAMS @F2@\n" +
      "0 @F2@ FAM\n1 HUSB @I4@\n1 WIFE @I6@\n1 CHIL @I2@\n",
    ));
    const rows = individualFieldRows(tr, ds.individuals.get("@I1@"), ds.individuals.get("@I2@"), ds, ds);
    expect(duplicateDefaults(rows)["parents"]).toBe("incoming");

    mergeDuplicate(ds, "@I1@", "@I2@", decide({}), tr);
    expect(ds.individuals.get("@I1@")!.childOf).toEqual(["@F2@"]);
    expect(validateDataset(ds).counts.brokenLink).toBe(0);
  });

  it("folds the two parent families once the duplicate parents are merged too", () => {
    const ds = dataset(twoParentCouples);
    mergeDuplicate(ds, "@I1@", "@I2@", decide({ parents: "both" }), tr);
    // Merging the duplicate fathers, then the mothers, collapses the couple.
    mergeDuplicate(ds, "@I3@", "@I4@", decide({}), tr);
    mergeDuplicate(ds, "@I5@", "@I6@", decide({}), tr);

    const survivor = ds.individuals.get("@I1@")!;
    expect(survivor.childOf.length).toBe(1);
    const fam = ds.families.get(survivor.childOf[0])!;
    expect(fam.husband).toBe("@I3@");
    expect(fam.wife).toBe("@I5@");
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

  it("flags parents that are separate records even when the names don't align", () => {
    // "Štefanija" (no surname) is too unlike "Štefka Kržišnik" to be paired onto
    // one comparison line, but a person has one mother — so the two records are
    // still the pair to merge, and this is where it is easiest to miss.
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Urban /Demšar/\n1 SEX M\n1 FAMC @F1@\n" +
      "0 @I2@ INDI\n1 NAME Urban /Demšar/\n1 SEX M\n1 FAMC @F2@\n" +
      "0 @I3@ INDI\n1 NAME Matevž /Demšar/\n1 SEX M\n1 FAMS @F1@\n" +
      "0 @I5@ INDI\n1 NAME Štefka /Kržišnik/\n1 SEX F\n1 FAMS @F1@\n" +
      "0 @I4@ INDI\n1 NAME Matevž /Demšar/\n1 SEX M\n1 FAMS @F2@\n" +
      "0 @I6@ INDI\n1 NAME Štefanija //\n1 SEX F\n1 FAMS @F2@\n" +
      "0 @F1@ FAM\n1 HUSB @I3@\n1 WIFE @I5@\n1 CHIL @I1@\n" +
      "0 @F2@ FAM\n1 HUSB @I4@\n1 WIFE @I6@\n1 CHIL @I2@\n",
    ));
    const rows = individualFieldRows(tr, ds.individuals.get("@I1@"), ds.individuals.get("@I2@"), ds, ds);
    const related = relatedSeparateRecords(rows);
    expect(related.map((r) => `${r.relation} ${r.aId}/${r.bId}`)).toEqual([
      "father @I3@/@I4@",
      "mother @I5@/@I6@",
    ]);
  });

  it("does not flag a parent that both sides already share", () => {
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Urban /Demšar/\n1 SEX M\n1 FAMC @F1@\n" +
      "0 @I2@ INDI\n1 NAME Urban /Demšar/\n1 SEX M\n1 FAMC @F2@\n" +
      "0 @I3@ INDI\n1 NAME Matevž /Demšar/\n1 SEX M\n1 FAMS @F1@\n1 FAMS @F2@\n" +
      "0 @F1@ FAM\n1 HUSB @I3@\n1 CHIL @I1@\n" +
      "0 @F2@ FAM\n1 HUSB @I3@\n1 CHIL @I2@\n",
    ));
    const rows = individualFieldRows(tr, ds.individuals.get("@I1@"), ds.individuals.get("@I2@"), ds, ds);
    expect(relatedSeparateRecords(rows)).toEqual([]);
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

  // Both Pavels are married to the *same* Barbara record, so their families fold
  // on their own — but each side carries its own record of the son Janez, and
  // folding just carries both into the one surviving family.
  const twoJanezes = wrap(
    "0 @I1@ INDI\n1 NAME Pavel /Fabjan/\n1 SEX M\n1 BIRT\n2 DATE 1770\n1 FAMS @F1@\n" +
    "0 @I2@ INDI\n1 NAME Pavel /Fabjan/\n1 SEX M\n1 BIRT\n2 DATE 1770\n1 FAMS @F2@\n" +
    "0 @I3@ INDI\n1 NAME Barbara /Gorjanc/\n1 SEX F\n1 BIRT\n2 DATE 1775\n1 FAMS @F1@\n1 FAMS @F2@\n" +
    "0 @I5@ INDI\n1 NAME Janez /Fabjan/\n1 SEX M\n1 BIRT\n2 DATE 1800\n1 FAMC @F1@\n" +
    "0 @I6@ INDI\n1 NAME Janez /Fabjan/\n1 SEX M\n1 BIRT\n2 DATE 1800\n1 FAMC @F2@\n" +
    "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I3@\n1 CHIL @I5@\n" +
    "0 @F2@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I6@\n",
  );

  it("flags a child that is a separate record on each side, to merge after the pair", () => {
    const ds = dataset(twoJanezes);
    const rows = individualFieldRows(tr, ds.individuals.get("@I1@"), ds.individuals.get("@I2@"), ds, ds);
    expect(relatedSeparateRecords(rows)).toEqual([
      { aId: "@I5@", bId: "@I6@", label: "Janez Fabjan", relation: "child" },
    ]);
    expect(relatedMergeOrder("child")).toBe("after");
    expect(relatedMergeOrder("partner")).toBe("before");
  });

  it("leaves the duplicated children as two siblings when only the pair is merged", () => {
    const ds = dataset(twoJanezes);
    mergeDuplicate(ds, "@I1@", "@I2@", decide({}), tr);

    // Nothing is lost or broken — the two Janez records simply both end up in
    // the one surviving family, which is why the panel offers to merge them.
    const fam = ds.families.get(ds.individuals.get("@I1@")!.spouseOf[0])!;
    expect(fam.children).toEqual(["@I5@", "@I6@"]);
    expect(validateDataset(ds).counts.brokenLink).toBe(0);
  });

  it("collapses the duplicated children when they are merged after the pair", () => {
    const ds = dataset(twoJanezes);
    // What the panel builds when the child is ticked: the pair first, then the
    // child — by then it has one set of parents, so no parents choice is needed.
    mergeDuplicateChain(ds, [
      { survivorId: "@I1@", removedId: "@I2@", decision: decide({}) },
      { survivorId: "@I5@", removedId: "@I6@", decision: decide({}) },
    ], tr);

    const survivor = ds.individuals.get("@I1@")!;
    expect(survivor.spouseOf.length).toBe(1);
    const fam = ds.families.get(survivor.spouseOf[0])!;
    expect(fam.children).toEqual(["@I5@"]);
    expect(ds.individuals.get("@I5@")!.childOf).toEqual([fam.id]);
    expect(ds.individuals.has("@I6@")).toBe(false);
    expect(validateDataset(ds).counts.brokenLink).toBe(0);
  });

  it("keeps a parent family that would otherwise strand its only parent", () => {
    // The candidate's parent family is just a mother and this child: dropping
    // the link would prune it and leave @I6@ with no tie to the tree at all,
    // so the family is brought across instead.
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Otrok /Novak/\n1 SEX M\n1 FAMC @F1@\n" +
      "0 @I2@ INDI\n1 NAME Otrok /Novak/\n1 SEX M\n1 FAMC @F2@\n" +
      "0 @I3@ INDI\n1 NAME Oče /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
      "0 @I5@ INDI\n1 NAME Mati /Novak/\n1 SEX F\n1 FAMS @F1@\n" +
      "0 @I6@ INDI\n1 NAME Štefanija /Sama/\n1 SEX F\n1 FAMS @F2@\n" +
      "0 @F1@ FAM\n1 HUSB @I3@\n1 WIFE @I5@\n1 CHIL @I1@\n" +
      "0 @F2@ FAM\n1 WIFE @I6@\n1 CHIL @I2@\n",
    ));
    mergeDuplicate(ds, "@I1@", "@I2@", decide({ parents: "main" }), tr);

    const survivor = ds.individuals.get("@I1@")!;
    expect(new Set(survivor.childOf)).toEqual(new Set(["@F1@", "@F2@"]));
    expect(ds.individuals.get("@I6@")!.spouseOf).toEqual(["@F2@"]);
    expect(validateDataset(ds).counts.brokenLink).toBe(0);
  });

  it("merges the duplicate parents first, so the child needs no parents choice", () => {
    const ds = dataset(twoParentCouples);
    // What the panel builds when both parent pairs are ticked: relatives first,
    // then the pair itself — all as one composed patch batch.
    const patches = mergeDuplicateChain(ds, [
      { survivorId: "@I3@", removedId: "@I4@", decision: decide({}) },
      { survivorId: "@I5@", removedId: "@I6@", decision: decide({}) },
      { survivorId: "@I1@", removedId: "@I2@", decision: decide({ parents: "main" }) },
    ], tr);

    // One family, one father, one mother — and nobody left disconnected.
    const survivor = ds.individuals.get("@I1@")!;
    expect(survivor.childOf.length).toBe(1);
    const fam = ds.families.get(survivor.childOf[0])!;
    expect(fam.husband).toBe("@I3@");
    expect(fam.wife).toBe("@I5@");
    expect(ds.individuals.has("@I4@")).toBe(false);
    expect(ds.individuals.has("@I6@")).toBe(false);
    expect(validateDataset(ds).counts.brokenLink).toBe(0);
    // Every record appears once in the batch, so one undo restores everything.
    const ids = patches.map((p) => `${p.type}:${p.id}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("composes a chain's patches so one undo restores the pre-chain state", () => {
    const ds = dataset(twoParentCouples);
    const original = new Map(
      [...ds.individuals.keys(), ...ds.families.keys()].map((id) => [
        id,
        serializeGedcom([(ds.individuals.get(id) ?? ds.families.get(id))!.raw]),
      ]),
    );

    const patches = mergeDuplicateChain(ds, [
      { survivorId: "@I3@", removedId: "@I4@", decision: decide({}) },
      { survivorId: "@I5@", removedId: "@I6@", decision: decide({}) },
      { survivorId: "@I1@", removedId: "@I2@", decision: decide({}) },
    ], tr);

    for (const p of patches) {
      // `before` is the state from before the *first* step that touched it.
      expect(p.before === null ? null : serializeGedcom([p.before])).toBe(original.get(p.id) ?? null);
    }
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

  it("repoints a third party's association from the duplicate onto the survivor", () => {
    // @I3@'s baptism names @I2@ as its godmother; @I2@ turns out to be @I1@.
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Jozefa /Pezdirc/\n1 SEX F\n1 BIRT\n2 DATE 1850\n" +
      "0 @I2@ INDI\n1 NAME Jozefa /Pezdirc/\n1 SEX F\n1 BIRT\n2 DATE 1850\n" +
      "0 @I3@ INDI\n1 NAME Janez /Renko/\n1 BAPM\n2 DATE 1880\n2 ASSO @I2@\n3 RELA botra\n",
    ));
    const patches = mergeDuplicate(ds, "@I1@", "@I2@", decide({}), tr);

    const bapm = ds.individuals.get("@I3@")!.raw.children.find((c) => c.tag === "BAPM")!;
    const asso = bapm.children.filter((c) => c.tag === "ASSO");
    expect(asso).toHaveLength(1);
    expect(asso[0].value).toBe("@I1@");
    // …and the repointed record is in the undo patch, not silently changed.
    expect(patches.some((p) => p.id === "@I3@")).toBe(true);
    // No dangling reference is left behind for the health check to find.
    expect(validateDataset(ds).issues.some((i) => i.category === "brokenLink")).toBe(false);
  });

  it("moves a child linked only from its own side into the kept family", () => {
    // @F2@ never lists @I3@; only @I3@'s FAMC names it. Folding @F2@ into @F1@
    // must carry that link (and its PEDI), and the undo patch must hold @I3@.
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Renko/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @F1@\n" +
      "0 @I2@ INDI\n1 NAME Janez /Renko/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @F2@\n" +
      "0 @I5@ INDI\n1 NAME Ana /Novak/\n1 SEX F\n1 FAMS @F1@\n1 FAMS @F2@\n" +
      "0 @I3@ INDI\n1 NAME Tone /Renko/\n1 FAMC @F2@\n2 PEDI adopted\n" +
      "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I5@\n" +
      "0 @F2@ FAM\n1 HUSB @I2@\n1 WIFE @I5@\n",
    ));
    const rows = individualFieldRows(tr, ds.individuals.get("@I1@"), ds.individuals.get("@I2@"), ds, ds);
    const patches = mergeDuplicate(ds, "@I1@", "@I2@", decide(duplicateDefaults(rows)), tr);

    expect(ds.families.has("@F2@")).toBe(false);
    const famc = ds.individuals.get("@I3@")!.raw.children.filter((c) => c.tag === "FAMC");
    expect(famc.map((c) => c.value)).toEqual(["@F1@"]);
    expect(famc[0].children.find((c) => c.tag === "PEDI")?.value).toBe("adopted");
    const p3 = patches.find((p) => p.id === "@I3@");
    expect(p3?.before && serializeGedcom([p3.before])).toContain("1 FAMC @F2@");
  });

  it("drops an association naming a person a delete removed", () => {
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Jozefa /Pezdirc/\n1 SEX F\n" +
      "0 @I3@ INDI\n1 NAME Janez /Renko/\n1 BAPM\n2 ASSO @I1@\n3 RELA botra\n",
    ));
    removeIndividual(ds, ds.individuals.get("@I1@")!);

    const bapm = ds.individuals.get("@I3@")!.raw.children.find((c) => c.tag === "BAPM")!;
    expect(bapm.children.some((c) => c.tag === "ASSO")).toBe(false);
    // The domain projection is rebuilt too, not just the raw tree.
    expect(ds.individuals.get("@I3@")!.events[0].associations).toBeUndefined();
  });
});

describe("mergeDuplicate — lines no row compares", () => {
  const FILE = wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 SUBM @U1@\n1 _UID AAA\n" +
    "0 @I2@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 OBJE @O2@\n2 _X birth extra\n" +
    "1 DEAT\n2 DATE 1900\n2 _X death extra\n1 BURI\n2 _GRAVE row 4\n" +
    "1 OBJE @O1@\n1 _PHOTO @O1@\n1 _CUSTOM keep me\n1 SUBM @U1@\n1 _UID BBB\n1 RIN 7\n" +
    "0 @O1@ OBJE\n1 FILE portrait.jpg\n0 @O2@ OBJE\n1 FILE birth.jpg\n0 @U1@ SUBM\n1 NAME Me\n",
  );

  for (const [label, seeded] of [["seeded defaults", true], ["empty choices (cluster merge)", false]] as const) {
    it(`carries the absorbed record's media, custom tags and event extras — ${label}`, () => {
      const ds = dataset(FILE);
      const rows = individualFieldRows(tr, ds.individuals.get("@I1@"), ds.individuals.get("@I2@"), ds, ds);
      mergeDuplicate(ds, "@I1@", "@I2@", decide(seeded ? duplicateDefaults(rows) : {}), tr);
      const out = serializeGedcom(ds.records);
      const i1 = out.slice(out.indexOf("0 @I1@ INDI"), out.indexOf("0 @O1@"));
      expect(i1).toContain("1 OBJE @O1@");
      expect(i1).toContain("1 _PHOTO @O1@");
      expect(i1).toContain("1 _CUSTOM keep me");
      expect(i1.match(/1 SUBM @U1@/g)).toHaveLength(1); // not doubled
      expect(i1).toContain("1 _UID AAA");
      expect(i1).not.toContain("BBB");
      expect(i1).not.toContain("1 RIN 7");
      expect(i1).toMatch(/1 BIRT\n2 DATE 1850\n(2 .*\n)*2 OBJE @O2@/);
      expect(i1).toContain("2 _X birth extra");
      expect(i1).toMatch(/1 DEAT\n2 DATE 1900\n(2 .*\n)*2 _X death extra/);
      expect(i1).toMatch(/1 BURI\n2 _GRAVE row 4/);
    });
  }

  it("repoints ALIA and vendor pointers to the absorbed record and drops self-references", () => {
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 ALIA @I2@\n" +
      "0 @I2@ INDI\n1 NAME Janez /Novak/\n1 ALIA @I1@\n1 FAMS @F1@\n" +
      "0 @I3@ INDI\n1 NAME Ana /Novak/\n1 ALIA @I2@\n1 EVEN\n2 TYPE Visit\n2 _WITN @I2@\n3 _XREF @I2@\n1 FAMS @F1@\n" +
      "0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 _SPONSOR @I2@\n",
    ));
    const patches = mergeDuplicate(ds, "@I1@", "@I2@", decide({}), tr);
    const out = serializeGedcom(ds.records);
    expect(out).not.toContain("@I2@");
    const i1 = out.slice(out.indexOf("0 @I1@ INDI"), out.indexOf("0 @I3@"));
    expect(i1).not.toContain("ALIA"); // both directions would point at itself
    expect(out).toContain("1 ALIA @I1@\n1 EVEN\n2 TYPE Visit\n2 _WITN @I1@\n3 _XREF @I1@\n1 FAMS @F1@");
    expect(out).toContain("1 HUSB @I1@");
    expect(out).toContain("1 _SPONSOR @I1@");
    // Every changed record is in the undo batch.
    expect(patches.map((p) => p.id).sort()).toEqual(["@F1@", "@I1@", "@I2@", "@I3@"]);
  });

  it("refuses to merge a person with their own parent or partner", () => {
    const text = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
      "0 @I2@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMC @F1@\n1 FAMS @F2@\n" +
      "0 @I3@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMC @F2@\n" +
      "0 @I4@ INDI\n1 NAME Ana /Novak/\n1 SEX F\n1 FAMS @F3@\n" +
      "0 @I5@ INDI\n1 NAME Ana /Novak/\n1 SEX F\n1 FAMS @F3@\n" +
      "0 @F1@ FAM\n1 HUSB @I1@\n1 CHIL @I2@\n" +
      "0 @F2@ FAM\n1 HUSB @I2@\n1 CHIL @I3@\n" +
      "0 @F3@ FAM\n1 WIFE @I4@\n1 HUSB @I5@\n",
    );
    for (const [a, b] of [["@I1@", "@I2@"], ["@I3@", "@I1@"], ["@I4@", "@I5@"]]) {
      const ds = dataset(text);
      expect(mergeDuplicate(ds, a, b, decide({}), tr)).toEqual([]);
      expect(serializeGedcom(ds.records)).toBe(serializeGedcom(dataset(text).records));
    }
    const ds = dataset(text);
    expect(makeDuplicatePair(ds, "@I1@", "@I3@")).toBeUndefined();
    expect(clusterMergeSteps(ds, "@I1@", ["@I1@", "@I2@", "@I3@"], [])).toEqual([]);
    expect(findDuplicates(ds, 0).some((p) => [p.aId, p.bId].includes("@I1@") && [p.aId, p.bId].includes("@I3@"))).toBe(false);
  });

  it("keeps PEDI and _FREL/_MREL on the links it moves", () => {
    const ds = dataset(wrap(
      // I1 has no parents; I2 is the adopted child of F1. I1 and I2 each
      // married I3 in their own family record (F2, F3), folded into one.
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F2@\n" +
      "0 @I2@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMC @F1@\n2 PEDI adopted\n1 FAMS @F3@\n" +
      "0 @I3@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 FAMS @F2@\n1 FAMS @F3@\n" +
      "0 @I4@ INDI\n1 NAME Oče /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
      "0 @I5@ INDI\n1 NAME Miha /Novak/\n1 SEX M\n1 FAMC @F3@\n2 PEDI foster\n" +
      "0 @F1@ FAM\n1 HUSB @I4@\n1 CHIL @I2@\n2 _FREL Adopted\n" +
      "0 @F2@ FAM\n1 HUSB @I1@\n1 WIFE @I3@\n" +
      "0 @F3@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I5@\n2 _MREL Foster\n",
    ));
    mergeDuplicate(ds, "@I1@", "@I2@", decide({}), tr);
    const out = serializeGedcom(ds.records);
    expect(out).toContain("1 FAMC @F1@\n2 PEDI adopted");
    expect(out).toContain("1 CHIL @I1@\n2 _FREL Adopted");
    const kept = ds.individuals.get("@I5@")!.childOf[0];
    expect(out).toContain(`1 FAMC ${kept}\n2 PEDI foster`);
    expect(out).toContain("1 CHIL @I5@\n2 _MREL Foster");
  });

  it("leaves the extras of an event whose rows were declined", () => {
    const ds = dataset(FILE);
    mergeDuplicate(ds, "@I1@", "@I2@", decide({ "DEAT.date": "main" }), tr);
    expect(serializeGedcom(ds.records)).not.toContain("death extra");
  });
});
