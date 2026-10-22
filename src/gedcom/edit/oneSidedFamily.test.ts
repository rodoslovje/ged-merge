import { describe, expect, it } from "vitest";
import { parseGedcom } from "../parser";
import { buildDataset } from "../builder";
import { serializeGedcom } from "../serialize";
import { familyMembers, removeFamily, removeIndividual } from "../edit";

/** @F1@ lists only its husband; @I3@ claims it as a birth family with a FAMC
 *  the family does not answer with a CHIL — a one-sided file. */
const LINES = [
  "0 HEAD",
  "0 @I1@ INDI",
  "1 NAME Oče /Novak/",
  "1 FAMS @F1@",
  "0 @I3@ INDI",
  "1 NAME Sin /Novak/",
  "1 FAMC @F1@",
  "0 @F1@ FAM",
  "1 HUSB @I1@",
  "0 TRLR",
];

const load = () => buildDataset(parseGedcom(new TextEncoder().encode(LINES.join("\n")).buffer));

describe("a family named from one side only", () => {
  it("counts the people whose own record names it", () => {
    const ds = load();
    expect(familyMembers(ds, ds.families.get("@F1@")!).sort()).toEqual(["@I1@", "@I3@"]);
  });

  it("deleting its only listed member prunes it without leaving the child's FAMC dangling", () => {
    const ds = load();
    removeIndividual(ds, ds.individuals.get("@I1@")!);
    expect(ds.families.has("@F1@")).toBe(false);
    expect(serializeGedcom(ds.records)).not.toContain("@F1@");
    expect(ds.individuals.get("@I3@")!.childOf).toEqual([]);
  });

  it("a back-linked child counts as a member, so the family keeps its remaining parent", () => {
    const ds = buildDataset(parseGedcom(new TextEncoder().encode([
      ...LINES.slice(0, -2),
      "1 WIFE @I2@",
      "0 @I2@ INDI",
      "1 FAMS @F1@",
      "0 TRLR",
    ].join("\n")).buffer));
    removeIndividual(ds, ds.individuals.get("@I2@")!);
    expect(ds.families.has("@F1@")).toBe(true);
    expect(ds.individuals.get("@I3@")!.childOf).toEqual(["@F1@"]);
  });

  it("removing it strips every pointer naming it, not only its listed members'", () => {
    const ds = load();
    removeFamily(ds, ds.families.get("@F1@")!);
    const out = serializeGedcom(ds.records);
    expect(out).not.toContain("@F1@");
    expect(ds.individuals.get("@I3@")!.childOf).toEqual([]);
  });
});
