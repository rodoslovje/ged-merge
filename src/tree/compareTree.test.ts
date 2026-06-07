import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { matchDatasets } from "../match/engine";
import { buildCompareTree, buildMatchMaps, type TreeNode } from "./compareTree";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

/** Identity translator: tests assert on keys/states, not localized labels. */
const tr = (key: string) => key;

const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// A child with two parents on each side. The father's birth year differs (a
// major, key conflict), the mother only gains a birth place (a minor diff), and
// the master has an extra grandfather the incoming file lacks.
const MASTER = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1900\n1 FAMC @F1@\n" +
    "0 @I2@ INDI\n1 NAME Anton /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1870\n1 FAMS @F1@\n1 FAMC @F2@\n" +
    "0 @I3@ INDI\n1 NAME Marija /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1872\n1 FAMS @F1@\n" +
    "0 @I4@ INDI\n1 NAME Jakob /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1840\n1 FAMS @F2@\n" +
    "0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I1@\n" +
    "0 @F2@ FAM\n1 HUSB @I4@\n1 CHIL @I2@\n",
);

const COMPARE = wrap(
  "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1900\n1 FAMC @G1@\n" +
    "0 @P2@ INDI\n1 NAME Anton /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1871\n1 FAMS @G1@\n" +
    "0 @P3@ INDI\n1 NAME Marija /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1872\n2 PLAC Kranj\n1 FAMS @G1@\n" +
    "0 @G1@ FAM\n1 HUSB @P2@\n1 WIFE @P3@\n1 CHIL @P1@\n",
);

function find(node: TreeNode, name: string): TreeNode | undefined {
  if (node.name === name) return node;
  // Children hang off the person directly (spouseless) or off a partner (union).
  const descendants = [...node.children, ...node.partners.flatMap((p) => p.children)];
  for (const c of descendants) {
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

describe("buildCompareTree (ancestors)", () => {
  const masterDs = dataset(MASTER);
  const compareDs = dataset(COMPARE);
  const matches = matchDatasets(masterDs, compareDs);
  const root = buildCompareTree(
    tr,
    masterDs.individuals.get("@I1@"),
    compareDs.individuals.get("@P1@"),
    masterDs,
    compareDs,
    buildMatchMaps(matches),
    "ancestors",
  )!;

  it("roots at the person and fully matches them", () => {
    expect(root.name).toBe("Janez Novak");
    expect(root.status).toBe("match");
    expect(root.children).toHaveLength(2); // father + mother
  });

  it("flags a key conflict (birth year) on the father as major", () => {
    const father = root.children.find((c) => c.sex === "M")!;
    expect(father.name).toBe("Anton Novak");
    expect(father.status).toBe("major");
    expect(father.years).toBe("1870");
  });

  it("flags a non-key difference (extra birth place) on the mother as minor", () => {
    const mother = root.children.find((c) => c.sex === "F")!;
    expect(mother.name).toBe("Marija Novak");
    expect(mother.status).toBe("minor");
    expect(mother.years).toBe("1872");
  });

  it("marks an ancestor present only in the master file", () => {
    const grandfather = find(root, "Jakob Novak")!;
    expect(grandfather.status).toBe("master-only");
  });
});

describe("buildCompareTree (descendants)", () => {
  const masterDs = dataset(MASTER);
  const compareDs = dataset(COMPARE);
  const matches = matchDatasets(masterDs, compareDs);

  it("walks children downward from a parent", () => {
    const root = buildCompareTree(
      tr,
      masterDs.individuals.get("@I2@"),
      compareDs.individuals.get("@P2@"),
      masterDs,
      compareDs,
      buildMatchMaps(matches),
      "descendants",
    )!;
    expect(root.name).toBe("Anton Novak");
    const child = find(root, "Janez Novak")!;
    expect(child.status).toBe("match");
  });

  it("shows the spouse as a partner node beside the person", () => {
    const root = buildCompareTree(
      tr,
      masterDs.individuals.get("@I2@"),
      compareDs.individuals.get("@P2@"),
      masterDs,
      compareDs,
      buildMatchMaps(matches),
      "descendants",
    )!;
    expect(root.partners.map((p) => p.name)).toContain("Marija Novak");
  });

  it("hangs the union's children off the partner, not the main person", () => {
    const root = buildCompareTree(
      tr,
      masterDs.individuals.get("@I2@"),
      compareDs.individuals.get("@P2@"),
      masterDs,
      compareDs,
      buildMatchMaps(matches),
      "descendants",
    )!;
    // Anton has no spouseless children; Janez belongs to his union with Marija.
    expect(root.children).toHaveLength(0);
    const marija = root.partners.find((p) => p.name === "Marija Novak")!;
    expect(marija.children.map((c) => c.name)).toContain("Janez Novak");
  });

  it("omits partners in ancestor mode", () => {
    const root = buildCompareTree(
      tr,
      masterDs.individuals.get("@I1@"),
      compareDs.individuals.get("@P1@"),
      masterDs,
      compareDs,
      buildMatchMaps(matches),
      "ancestors",
    )!;
    expect(root.partners).toHaveLength(0);
  });
});
