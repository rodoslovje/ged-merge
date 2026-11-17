import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildPublishedTree, defaultPublishOptions } from "../publish/model";
import { hydrateTree, xrefOf } from "../publish/hydrate";
import { familyEventAges, personEventAges } from "./ages";

const t = (key: string) => key;
const NOW = new Date("2026-06-01");

// Ivan and Marija have Ana in 1930; Ana marries Peter in 1952 and dies in
// 1990. Year-only dates count as the app's age helpers count them.
const FILE = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Ivan /Kos/
1 SEX M
1 BIRT
2 DATE 12 MAR 1900
1 DEAT
2 DATE 1970
1 FAMS @F1@
0 @I2@ INDI
1 NAME Marija /Kos/
1 SEX F
1 BIRT
2 DATE 1905
1 DEAT
2 DATE 1980
1 FAMS @F1@
0 @I3@ INDI
1 NAME Ana /Kos/
1 SEX F
1 BIRT
2 DATE 1 JUN 1930
1 DEAT
2 DATE 1990
1 FAMC @F1@
1 FAMS @F2@
0 @I4@ INDI
1 NAME Peter /Novak/
1 SEX M
1 BIRT
2 DATE 1928
1 DEAT
2 DATE 1995
1 FAMS @F2@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
0 @F2@ FAM
1 HUSB @I4@
1 WIFE @I3@
1 MARR
2 DATE 1952
0 TRLR
`;

const ds = buildDataset(parseGedcom(new TextEncoder().encode(FILE).buffer));
const { tree } = buildPublishedTree(ds, defaultPublishOptions("Kos", "sl"), "@I3@", NOW);
const site = hydrateTree(tree);
const pubOf = (given: string) => tree.people.find((p) => p.given === given)!;

describe("site event ages", () => {
  it("show the parents' ages at a birth and the person's own at other events", () => {
    const ana = pubOf("Ana");
    const ages = personEventAges(site, site.individuals.get(xrefOf(ana.id))!, t);
    const birth = ana.events!.find((e) => e.tag === "BIRT")!;
    const death = ana.events!.find((e) => e.tag === "DEAT")!;
    expect(ages(birth)!.map((b) => b.text)).toEqual(["♂30", "♀25"]);
    expect(ages(birth)![0].title).toMatch(/^event\.age\.father/);
    expect(ages(death)!.map((b) => b.text)).toEqual(["60"]);
  });

  it("show both partners' ages at a family event", () => {
    const fam = [...site.families.values()].find((f) => f.children.length === 0)!;
    const marr = tree.families.find((f) => xrefOf(f.id) === fam.id)!.events!.find((e) => e.tag === "MARR")!;
    expect(familyEventAges(site, fam, t)(marr)!.map((b) => b.text)).toEqual(["♂24", "♀22"]);
  });
});
