import { describe, expect, it } from "vitest";
import { parseGedcom } from "../parser";
import { buildDataset } from "../builder";
import { serializeGedcom } from "../serialize";
import { connectExistingChild, connectExistingParent, connectExistingPartner, impossibleRelatives } from "../edit";

/** @I1@ + @I2@ are the parents of @I3@ (F1); @I3@ + @I4@ have @I5@ (F2);
 *  @I6@ stands apart. */
const LINES = [
  "0 HEAD",
  "0 @I1@ INDI",
  "1 SEX M",
  "1 FAMS @F1@",
  "0 @I2@ INDI",
  "1 SEX F",
  "1 FAMS @F1@",
  "0 @I3@ INDI",
  "1 SEX M",
  "1 FAMC @F1@",
  "1 FAMS @F2@",
  "0 @I4@ INDI",
  "1 SEX F",
  "1 FAMS @F2@",
  "0 @I5@ INDI",
  "1 FAMC @F2@",
  "0 @I6@ INDI",
  "1 SEX F",
  "0 @I7@ INDI",
  "1 SEX M",
  "1 FAMS @F3@",
  "0 @F1@ FAM",
  "1 HUSB @I1@",
  "1 WIFE @I2@",
  "1 CHIL @I3@",
  "0 @F2@ FAM",
  "1 HUSB @I3@",
  "1 WIFE @I4@",
  "1 CHIL @I5@",
  "0 @F3@ FAM",
  "1 HUSB @I7@",
  "0 TRLR",
];

function load() {
  const ds = buildDataset(parseGedcom(new TextEncoder().encode(LINES.join("\n")).buffer));
  return { ds, before: serializeGedcom(ds.records) };
}

describe("connecting an existing relative refuses impossible structures", () => {
  it("the family's husband cannot also be its mother", () => {
    const { ds, before } = load();
    // F3 has a husband and no wife; @I5@ is put into it as a child first.
    const f3 = ds.families.get("@F3@")!;
    expect(impossibleRelatives(ds, ds.individuals.get("@I5@")!, "mother", f3).has("@I7@")).toBe(true);
    connectExistingParent(ds, ds.individuals.get("@I6@")!, "@I7@", f3, "mother");
    expect(ds.families.get("@F3@")!.wife).toBeUndefined();
    expect(serializeGedcom(ds.records)).toBe(before);
  });

  it("a descendant cannot become a parent", () => {
    const { ds, before } = load();
    const i1 = ds.individuals.get("@I1@")!;
    expect(impossibleRelatives(ds, i1, "father", undefined)).toEqual(new Set(["@I1@", "@I3@", "@I5@"]));
    connectExistingParent(ds, i1, "@I5@", undefined, "father");
    expect(serializeGedcom(ds.records)).toBe(before);
  });

  it("an ancestor, or a spouse of the family, cannot become a child", () => {
    const { ds, before } = load();
    const i3 = ds.individuals.get("@I3@")!;
    const f2 = ds.families.get("@F2@")!;
    expect(impossibleRelatives(ds, i3, "child", f2)).toEqual(new Set(["@I1@", "@I2@", "@I3@", "@I4@"]));
    connectExistingChild(ds, i3, "@I1@", f2);
    connectExistingChild(ds, i3, "@I4@", f2);
    expect(serializeGedcom(ds.records)).toBe(before);
  });

  it("a child or a parent cannot become a partner", () => {
    const { ds, before } = load();
    const i3 = ds.individuals.get("@I3@")!;
    expect(impossibleRelatives(ds, i3, "partner", undefined)).toEqual(new Set(["@I1@", "@I2@", "@I3@", "@I5@"]));
    connectExistingPartner(ds, i3, "@I5@", undefined);
    connectExistingPartner(ds, i3, "@I2@", undefined);
    expect(serializeGedcom(ds.records)).toBe(before);
  });

  it("anyone else still connects", () => {
    const { ds } = load();
    const i3 = ds.individuals.get("@I3@")!;
    connectExistingPartner(ds, i3, "@I6@", undefined);
    expect(ds.individuals.get("@I6@")!.spouseOf).toHaveLength(1);
  });
});
