import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { matchDatasets } from "../match/engine";
import { buildPersonTree, buildMatchMaps, countTreePeople, type TreeNode } from "./personTree";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

/** Identity translator: tests assert on keys/states, not localized labels. */
const tr = (key: string) => key;

const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// A child with two parents on each side. The father's birth year differs (a
// major, key conflict), the mother only gains a birth place (a minor diff), and
// the main has an extra grandfather the incoming file lacks.
const MAIN = wrap(
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

describe("buildPersonTree (ancestors)", () => {
  const mainDs = dataset(MAIN);
  const compareDs = dataset(COMPARE);
  const matches = matchDatasets(mainDs, compareDs);
  const root = buildPersonTree(
    tr,
    mainDs.individuals.get("@I1@"),
    compareDs.individuals.get("@P1@"),
    mainDs,
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

  it("marks an ancestor present only in the main file", () => {
    const grandfather = find(root, "Jakob Novak")!;
    expect(grandfather.status).toBe("main-only");
  });

  it("drops the incoming side when a pairing is rejected", () => {
    const rejected = buildPersonTree(
      tr,
      mainDs.individuals.get("@I1@"),
      compareDs.individuals.get("@P1@"),
      mainDs,
      compareDs,
      buildMatchMaps(matches),
      "ancestors",
      (mainId, compareId) => mainId === "@I2@" && compareId === "@P2@",
    )!;
    const father = rejected.children.find((c) => c.sex === "M")!;
    // The rejected father keeps his main record and loses the incoming one,
    // turning the conflicted node into a clean main-only node.
    expect(father.name).toBe("Anton Novak");
    expect(father.status).toBe("main-only");
    expect(father.main?.id).toBe("@I2@");
    expect(father.incoming).toBeUndefined();
    // The main lineage above him still continues.
    expect(find(rejected, "Jakob Novak")?.status).toBe("main-only");
  });
});

describe("buildPersonTree (descendants)", () => {
  const mainDs = dataset(MAIN);
  const compareDs = dataset(COMPARE);
  const matches = matchDatasets(mainDs, compareDs);

  it("walks children downward from a parent", () => {
    const root = buildPersonTree(
      tr,
      mainDs.individuals.get("@I2@"),
      compareDs.individuals.get("@P2@"),
      mainDs,
      compareDs,
      buildMatchMaps(matches),
      "descendants",
    )!;
    expect(root.name).toBe("Anton Novak");
    const child = find(root, "Janez Novak")!;
    expect(child.status).toBe("match");
  });

  it("shows the spouse as a partner node beside the person", () => {
    const root = buildPersonTree(
      tr,
      mainDs.individuals.get("@I2@"),
      compareDs.individuals.get("@P2@"),
      mainDs,
      compareDs,
      buildMatchMaps(matches),
      "descendants",
    )!;
    expect(root.partners.map((p) => p.name)).toContain("Marija Novak");
  });

  it("hangs the union's children off the partner, not the main person", () => {
    const root = buildPersonTree(
      tr,
      mainDs.individuals.get("@I2@"),
      compareDs.individuals.get("@P2@"),
      mainDs,
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
    const root = buildPersonTree(
      tr,
      mainDs.individuals.get("@I1@"),
      compareDs.individuals.get("@P1@"),
      mainDs,
      compareDs,
      buildMatchMaps(matches),
      "ancestors",
    )!;
    expect(root.partners).toHaveLength(0);
  });
});

describe("buildPersonTree (pedigree collapse)", () => {
  // The root's father and mother are siblings (children of the same couple), so
  // the grandparents appear twice in the ancestor tree — once above each parent.
  const COLLAPSE = wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMC @F1@\n" +
      "0 @I2@ INDI\n1 NAME Anton /Novak/\n1 SEX M\n1 FAMS @F1@\n1 FAMC @F2@\n" +
      "0 @I3@ INDI\n1 NAME Ana /Novak/\n1 SEX F\n1 FAMS @F1@\n1 FAMC @F2@\n" +
      "0 @I4@ INDI\n1 NAME Jakob /Novak/\n1 SEX M\n1 FAMS @F2@\n" +
      "0 @I5@ INDI\n1 NAME Meta /Novak/\n1 SEX F\n1 FAMS @F2@\n" +
      "0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I1@\n" +
      "0 @F2@ FAM\n1 HUSB @I4@\n1 WIFE @I5@\n1 CHIL @I2@\n1 CHIL @I3@\n",
  );
  const ds = dataset(COLLAPSE);
  const emptyMaps = { mainToCompare: new Map<string, string>(), compareToMain: new Map<string, string>() };

  /** Every node in the tree, partners included, in walk order. */
  function allNodes(root: TreeNode): TreeNode[] {
    const out: TreeNode[] = [];
    const walk = (n: TreeNode) => {
      out.push(n);
      n.children.forEach(walk);
      n.partners.forEach(walk);
    };
    walk(root);
    return out;
  }

  it("gives every occurrence of a repeated ancestor its own key", () => {
    const root = buildPersonTree(tr, ds.individuals.get("@I1@"), undefined, ds, ds, emptyMaps, "ancestors")!;
    const nodes = allNodes(root);
    const keys = nodes.map((n) => n.key);
    expect(new Set(keys).size).toBe(keys.length);
    // The grandparents really do occur twice — as two nodes for the same person.
    const jakob = nodes.filter((n) => n.main?.id === "@I4@");
    expect(jakob).toHaveLength(2);
    expect(jakob[0].key).not.toBe(jakob[1].key);
  });

  it("counts a repeated ancestor once", () => {
    const root = buildPersonTree(tr, ds.individuals.get("@I1@"), undefined, ds, ds, emptyMaps, "ancestors")!;
    // Father, mother, and the shared grandparents: 4 people, not 6 positions.
    expect(countTreePeople(root)).toBe(4);
    // Only the later occurrence of each grandparent is flagged as a repeat, and
    // each points at the occurrence that does carry their line.
    const nodes = allNodes(root);
    const repeats = nodes.filter((n) => n.repeat);
    expect(repeats.map((n) => n.main?.id)).toEqual(["@I4@", "@I5@"]);
    for (const r of repeats) {
      const first = nodes.find((n) => n.key === r.repeatOf)!;
      expect(first.main?.id).toBe(r.main?.id);
      expect(first.repeat).toBeUndefined();
    }
  });

  it("keeps keys unique when a person is both spouse and child (descendants)", () => {
    // From the grandparents' view, Ana appears as a child of @F2@ and as
    // Anton's partner; the partner occurrence must not block the child's
    // expansion, and both occurrences need distinct keys.
    const root = buildPersonTree(tr, ds.individuals.get("@I4@"), undefined, ds, ds, emptyMaps, "descendants")!;
    const nodes = allNodes(root);
    const keys = nodes.map((n) => n.key);
    expect(new Set(keys).size).toBe(keys.length);
    const ana = nodes.filter((n) => n.main?.id === "@I3@");
    expect(ana.length).toBeGreaterThanOrEqual(2);
    // The grandson is still reachable (Ana's child occurrence expanded).
    expect(nodes.some((n) => n.main?.id === "@I1@")).toBe(true);
  });

  it("draws a couple's children once when both spouses descend from the root", () => {
    // Anton and Ana are both children of @F2@ and married to each other, so
    // their union is reached down each of their lines. It expands under the
    // first of them only — the shared child is not drawn (nor counted) twice.
    const root = buildPersonTree(tr, ds.individuals.get("@I4@"), undefined, ds, ds, emptyMaps, "descendants")!;
    const nodes = allNodes(root);
    expect(nodes.filter((n) => n.main?.id === "@I1@")).toHaveLength(1);
    expect(countTreePeople(root)).toBe(3); // Anton, Ana, Janez

    // The second occurrence keeps the couple and their marriage, flagged as a
    // repeat so an empty node doesn't read as a childless marriage.
    const repeats = nodes.filter((n) => n.repeat);
    expect(repeats).toHaveLength(1);
    expect(repeats[0].main?.id).toBe("@I2@"); // Anton, as Ana's partner
    expect(repeats[0].children).toHaveLength(0);

    // It points at the position that does carry them — Ana beside Anton — so
    // the marker can take the user there.
    const carrier = nodes.find((n) => n.key === repeats[0].repeatOf)!;
    expect(carrier.main?.id).toBe("@I3@");
    expect(carrier.children.map((c) => c.main?.id)).toEqual(["@I1@"]);
  });

  it("still expands a second marriage of a spouse already in the tree", () => {
    // Ana remarries outside the tree: that union is a different family and must
    // expand normally — the guard is per union, not per person.
    const remarried = dataset(
      COLLAPSE.replace("1 NAME Ana /Novak/\n1 SEX F\n1 FAMS @F1@\n", "1 NAME Ana /Novak/\n1 SEX F\n1 FAMS @F1@\n1 FAMS @F3@\n").replace(
        "0 TRLR\n",
        "0 @I6@ INDI\n1 NAME Lovro /Kos/\n1 SEX M\n1 FAMS @F3@\n" +
          "0 @I7@ INDI\n1 NAME Neza /Kos/\n1 SEX F\n1 FAMC @F3@\n" +
          "0 @F3@ FAM\n1 HUSB @I6@\n1 WIFE @I3@\n1 CHIL @I7@\n0 TRLR\n",
      ),
    );
    const root = buildPersonTree(tr, remarried.individuals.get("@I4@"), undefined, remarried, remarried, emptyMaps, "descendants")!;
    expect(allNodes(root).some((n) => n.main?.id === "@I7@")).toBe(true);
  });
});

describe("buildPersonTree (marriage)", () => {
  // A child and its two married parents (family records a MARR date + place).
  const MARR = wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMC @F1@\n" +
      "0 @I2@ INDI\n1 NAME Anton /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
      "0 @I3@ INDI\n1 NAME Marija /Novak/\n1 SEX F\n1 FAMS @F1@\n" +
      "0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I1@\n1 MARR\n2 DATE 12 JAN 1900\n2 PLAC Kranj, Slovenija\n",
  );
  const ds = dataset(MARR);
  const emptyMaps = { mainToCompare: new Map(), compareToMain: new Map() };

  it("attaches the parents' marriage to the child node (ancestor mode)", () => {
    const root = buildPersonTree(tr, ds.individuals.get("@I1@"), undefined, ds, ds, emptyMaps, "ancestors")!;
    expect(root.marriage).toEqual({ year: "1900", place: "Kranj" });
  });

  it("attaches the union's marriage to the partner node (descendant mode)", () => {
    const root = buildPersonTree(tr, ds.individuals.get("@I2@"), undefined, ds, ds, emptyMaps, "descendants")!;
    const spouse = root.partners.find((p) => p.name === "Marija Novak")!;
    expect(spouse.marriage).toEqual({ year: "1900", place: "Kranj" });
  });

  it("leaves marriage undefined when the family records no MARR", () => {
    const noMarr = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME A /B/\n1 SEX M\n1 FAMC @F1@\n" +
          "0 @I2@ INDI\n1 NAME C /B/\n1 SEX M\n1 FAMS @F1@\n" +
          "0 @F1@ FAM\n1 HUSB @I2@\n1 CHIL @I1@\n",
      ),
    );
    const root = buildPersonTree(tr, noMarr.individuals.get("@I1@"), undefined, noMarr, noMarr, emptyMaps, "ancestors")!;
    expect(root.marriage).toBeUndefined();
  });
});
