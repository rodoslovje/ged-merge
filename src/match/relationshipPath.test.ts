import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildAssociationIndex } from "../gedcom/assoc";
import { assocLinks, assocPaths, bloodLineage, bloodPath, bloodPaths, labelPaths, relationshipPaths, shortestPath } from "./relationshipPath";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const ids = (p?: { steps: { id: string }[] }) => p?.steps.map((s) => s.id);
const edges = (p?: { steps: { edge?: string }[] }) => p?.steps.map((s) => s.edge);

// I1 = ego; parents I2/I3; paternal grandparents I4/I5; uncle I6 (+ wife I7) with
// cousin I8; ego's spouse I9 whose parents are the in-laws I10/I11.
const TREE = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ego /Test/
1 SEX M
1 FAMC @F1@
1 FAMS @F4@
0 @I2@ INDI
1 NAME Father /Test/
1 SEX M
1 FAMC @F2@
1 FAMS @F1@
0 @I3@ INDI
1 NAME Mother /Test/
1 SEX F
1 FAMS @F1@
0 @I4@ INDI
1 NAME Grandfather /Test/
1 SEX M
1 FAMS @F2@
0 @I5@ INDI
1 NAME Grandmother /Test/
1 SEX F
1 FAMS @F2@
0 @I6@ INDI
1 NAME Uncle /Test/
1 SEX M
1 FAMC @F2@
1 FAMS @F3@
0 @I7@ INDI
1 NAME Aunt /Test/
1 SEX F
1 FAMS @F3@
0 @I8@ INDI
1 NAME Cousin /Test/
1 SEX M
1 FAMC @F3@
0 @I9@ INDI
1 NAME Spouse /Test/
1 SEX F
1 FAMC @F5@
1 FAMS @F4@
0 @I10@ INDI
1 NAME InLawFather /Test/
1 SEX M
1 FAMS @F5@
0 @I11@ INDI
1 NAME InLawMother /Test/
1 SEX F
1 FAMS @F5@
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I3@
1 CHIL @I1@
0 @F2@ FAM
1 HUSB @I4@
1 WIFE @I5@
1 CHIL @I2@
1 CHIL @I6@
0 @F3@ FAM
1 HUSB @I6@
1 WIFE @I7@
1 CHIL @I8@
0 @F4@ FAM
1 HUSB @I1@
1 WIFE @I9@
0 @F5@ FAM
1 HUSB @I10@
1 WIFE @I11@
1 CHIL @I9@
0 TRLR
`;

describe("relationshipPath", () => {
  const ds = dataset(TREE);

  it("self is a single step", () => {
    const p = shortestPath(ds, "@I1@", "@I1@");
    expect(p?.hops).toBe(0);
    expect(ids(p)).toEqual(["@I1@"]);
  });

  it("direct parent is one parent hop", () => {
    const p = shortestPath(ds, "@I1@", "@I2@");
    expect(ids(p)).toEqual(["@I1@", "@I2@"]);
    expect(edges(p)).toEqual([undefined, "parent"]);
  });

  it("spouse is one spouse hop", () => {
    const p = shortestPath(ds, "@I1@", "@I9@");
    expect(ids(p)).toEqual(["@I1@", "@I9@"]);
    expect(edges(p)).toEqual([undefined, "spouse"]);
  });

  it("blood path to a cousin forks at the common grandparent", () => {
    const p = bloodPath(ds, "@I1@", "@I8@");
    expect(ids(p)).toEqual(["@I1@", "@I2@", "@I4@", "@I6@", "@I8@"]);
    expect(edges(p)).toEqual([undefined, "parent", "parent", "child", "child"]);
    expect(p?.lcaIndex).toBe(2); // @I4@ is the common ancestor
  });

  it("offers no separate blood path when the shortest path is already blood", () => {
    const { shortest, blood } = relationshipPaths(ds, "@I1@", "@I8@");
    expect(ids(shortest)).toEqual(["@I1@", "@I2@", "@I4@", "@I6@", "@I8@"]);
    expect(blood).toBeUndefined();
  });

  it("reaches an in-law through the spouse (no blood path)", () => {
    const { shortest, blood } = relationshipPaths(ds, "@I1@", "@I10@");
    expect(ids(shortest)).toEqual(["@I1@", "@I9@", "@I10@"]);
    expect(edges(shortest)).toEqual([undefined, "spouse", "parent"]);
    expect(blood).toBeUndefined();
    expect(bloodPath(ds, "@I1@", "@I10@")).toBeUndefined();
  });

  it("labelPaths: the bloodlines themselves for a blood relative", () => {
    expect(labelPaths(ds, "@I1@", "@I8@")).toEqual(bloodPaths(ds, "@I1@", "@I8@"));
  });

  it("labelPaths: a relative's spouse is the bloodline plus the marriage", () => {
    // Aunt-by-marriage @I7@: bloodline to uncle @I6@, then his marriage.
    const [p, ...rest] = labelPaths(ds, "@I1@", "@I7@");
    expect(rest).toEqual([]);
    expect(ids(p)).toEqual(["@I1@", "@I2@", "@I4@", "@I6@", "@I7@"]);
    expect(edges(p)).toEqual([undefined, "parent", "parent", "child", "spouse"]);
    expect(p.hops).toBe(4);
    expect(p.steps[p.lcaIndex!].id).toBe("@I4@");
  });

  it("labelPaths: a spouse's relative is the marriage plus the spouse's bloodline", () => {
    const [p, ...rest] = labelPaths(ds, "@I1@", "@I10@");
    expect(rest).toEqual([]);
    expect(ids(p)).toEqual(["@I1@", "@I9@", "@I10@"]);
    expect(edges(p)).toEqual([undefined, "spouse", "parent"]);
    expect(p.steps[p.lcaIndex!].id).toBe("@I10@");
  });

  it("labelPaths: empty for one's own spouse and for the unrelated", () => {
    expect(labelPaths(ds, "@I1@", "@I9@")).toEqual([]);
    expect(labelPaths(ds, "@I1@", "@NOPE@")).toEqual([]);
  });

  it("returns undefined for unknown ids", () => {
    expect(shortestPath(ds, "@I1@", "@NOPE@")).toBeUndefined();
    expect(bloodPath(ds, "@NOPE@", "@I1@")).toBeUndefined();
  });

  it("bloodPaths collapses a shared ancestor couple to one route", () => {
    // Cousins share a whole grandparent couple (@I4@ + @I5@) — that's one
    // bloodline, not two, so only a single path is returned.
    const paths = bloodPaths(ds, "@I1@", "@I8@");
    expect(paths).toHaveLength(1);
    expect(paths[0].hops).toBe(4);
    expect(paths[0].steps[paths[0].lcaIndex!].id).toBe("@I4@");
  });

  it("bloodPaths is empty for an in-law", () => {
    expect(bloodPaths(ds, "@I1@", "@I10@")).toEqual([]);
  });

  it("lineage: paternal ancestors climb the father's side", () => {
    expect(bloodLineage(ds, "@I1@", "@I2@")).toBe("paternal"); // father
    expect(bloodLineage(ds, "@I1@", "@I4@")).toBe("paternal"); // paternal grandfather
    expect(bloodLineage(ds, "@I1@", "@I6@")).toBe("paternal"); // paternal uncle
    expect(bloodLineage(ds, "@I1@", "@I8@")).toBe("paternal"); // paternal cousin
  });

  it("lineage: the mother is on the maternal side", () => {
    expect(bloodLineage(ds, "@I1@", "@I3@")).toBe("maternal");
  });

  it("lineage: spouses and in-laws have no blood line", () => {
    expect(bloodLineage(ds, "@I1@", "@I9@")).toBeUndefined(); // spouse
    expect(bloodLineage(ds, "@I1@", "@I10@")).toBeUndefined(); // in-law
    expect(bloodLineage(ds, "@I1@", "@I1@")).toBeUndefined(); // self
  });
});

// A two-parent family for the "both lines" and descendant cases:
//   I1 = ego; full sibling I2; parents I3 (M) / I4 (F); ego's son I5.
const FAMILY = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ego /Test/
1 SEX M
1 FAMC @F1@
1 FAMS @F2@
0 @I2@ INDI
1 NAME Sibling /Test/
1 SEX F
1 FAMC @F1@
0 @I3@ INDI
1 NAME Father /Test/
1 SEX M
1 FAMS @F1@
0 @I4@ INDI
1 NAME Mother /Test/
1 SEX F
1 FAMS @F1@
0 @I5@ INDI
1 NAME Son /Test/
1 SEX M
1 FAMC @F2@
0 @F1@ FAM
1 HUSB @I3@
1 WIFE @I4@
1 CHIL @I1@
1 CHIL @I2@
0 @F2@ FAM
1 HUSB @I1@
1 CHIL @I5@
0 TRLR
`;

describe("bloodLineage both / descendant", () => {
  const ds = dataset(FAMILY);

  it("a full sibling is reached through both parents", () => {
    expect(bloodLineage(ds, "@I1@", "@I2@")).toBe("both");
  });

  it("a descendant has no ancestral line from the start person", () => {
    expect(bloodLineage(ds, "@I1@", "@I5@")).toBeUndefined();
  });
});

describe("shortestPath through associations", () => {
  // Two families with no kinship: C, child of F, was held at the font by G,
  // whose son is GS. F's wedding to M was witnessed by W. C's uncle U is also
  // C's godfather.
  const ds = dataset(
    `0 HEAD\n1 GEDC\n2 VERS 7.0\n` +
      `0 @C@ INDI\n1 FAMC @F1@\n1 BIRT\n2 ASSO @G@\n3 ROLE GODP\n2 ASSO @U@\n3 ROLE GODP\n` +
      `0 @F@ INDI\n1 FAMC @F0@\n1 FAMS @F1@\n0 @M@ INDI\n1 FAMS @F1@\n` +
      `0 @U@ INDI\n1 FAMC @F0@\n0 @GF@ INDI\n1 FAMS @F0@\n` +
      `0 @G@ INDI\n1 FAMS @F2@\n0 @GS@ INDI\n1 FAMC @F2@\n0 @W@ INDI\n0 @X@ INDI\n` +
      `0 @F0@ FAM\n1 HUSB @GF@\n1 CHIL @F@\n1 CHIL @U@\n` +
      `0 @F1@ FAM\n1 HUSB @F@\n1 WIFE @M@\n1 CHIL @C@\n1 MARR\n2 ASSO @W@\n3 ROLE WITN\n` +
      `0 @F2@ FAM\n1 HUSB @G@\n1 CHIL @GS@\n0 TRLR\n`,
  );
  const ties = assocLinks(ds, buildAssociationIndex(ds));

  it("finds no family path between the two families, and one through the godparent", () => {
    expect(shortestPath(ds, "@C@", "@GS@")).toBeUndefined();
    const p = shortestPath(ds, "@C@", "@GS@", ties);
    expect(p?.kind).toBe("assoc");
    expect(ids(p)).toEqual(["@C@", "@G@", "@GS@"]);
    expect(edges(p)).toEqual([undefined, "assoc", "child"]);
    // The step names the association and who the associate is.
    expect(p?.steps[1].assoc).toMatchObject({ id: "@G@", associate: true, assoc: { role: "GODP" } });
  });

  it("walks it the other way, from the godparent to the child", () => {
    const p = shortestPath(ds, "@GS@", "@C@", ties);
    expect(ids(p)).toEqual(["@GS@", "@G@", "@C@"]);
    expect(p?.steps[2].assoc).toMatchObject({ id: "@C@", associate: false });
  });

  it("ties a wedding's witness to both partners", () => {
    expect(edges(shortestPath(ds, "@M@", "@W@", ties))).toEqual([undefined, "assoc"]);
    expect(edges(shortestPath(ds, "@W@", "@F@", ties))).toEqual([undefined, "assoc"]);
  });

  it("takes the godparent's step where it is shorter than the kinship", () => {
    expect(shortestPath(ds, "@C@", "@U@")?.hops).toBe(3);
    expect(shortestPath(ds, "@C@", "@U@", ties)).toMatchObject({ kind: "assoc", hops: 1 });
  });

  it("stays a family path where no association is on it", () => {
    expect(shortestPath(ds, "@C@", "@M@", ties)?.kind).toBe("shortest");
    expect(shortestPath(ds, "@C@", "@X@", ties)).toBeUndefined();
  });
});

describe("bloodPaths, every way up", () => {
  // E's parents F and M are first cousins: both grandchildren of the couple
  // A + B, through the brothers P (F's father) and Q (M's father). T is a
  // third grandchild, through their sister R.
  const person = (id: string, famc: string | undefined, fams: string[]) =>
    `0 @${id}@ INDI\n` + (famc ? `1 FAMC @${famc}@\n` : "") + fams.map((f) => `1 FAMS @${f}@\n`).join("");
  const ds = dataset(
    `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n` +
      person("A", undefined, ["F0"]) + person("B", undefined, ["F0"]) +
      person("P", "F0", ["F1"]) + person("Q", "F0", ["F2"]) + person("R", "F0", ["F3"]) +
      person("F", "F1", ["F4"]) + person("M", "F2", ["F4"]) + person("T", "F3", []) + person("E", "F4", []) +
      `0 @F0@ FAM\n1 HUSB @A@\n1 WIFE @B@\n1 CHIL @P@\n1 CHIL @Q@\n1 CHIL @R@\n` +
      `0 @F1@ FAM\n1 HUSB @P@\n1 CHIL @F@\n0 @F2@ FAM\n1 HUSB @Q@\n1 CHIL @M@\n0 @F3@ FAM\n1 WIFE @R@\n1 CHIL @T@\n` +
      `0 @F4@ FAM\n1 HUSB @F@\n1 WIFE @M@\n1 CHIL @E@\n0 TRLR\n`,
  );

  it("offers the line through each parent to the same ancestors", () => {
    const paths = bloodPaths(ds, "@E@", "@T@");
    // The couple A + B is one apex; the two ways up to it are two bloodlines.
    expect(paths.map((p) => ids(p)!.slice(0, 3).join(">"))).toEqual(["@E@>@F@>@P@", "@E@>@M@>@Q@"]);
    expect(paths.every((p) => p.hops === 5 && ids(p)!.at(-1) === "@T@")).toBe(true);
  });

  it("keeps one line where there is one way", () => {
    expect(bloodPaths(ds, "@F@", "@T@")).toHaveLength(1);
    // E to their own father: the direct line only, not the detour over M's side.
    expect(bloodPaths(ds, "@E@", "@F@").map(ids)).toEqual([["@E@", "@F@"]]);
  });
});

describe("assocPaths", () => {
  // C (child of F, grandchild of GF, nephew of U) has godfather G — father of
  // GS — and godfather U, his own uncle. F's wedding was witnessed by W.
  const ds = dataset(
    `0 HEAD\n1 GEDC\n2 VERS 7.0\n` +
      `0 @C@ INDI\n1 FAMC @F1@\n1 BIRT\n2 ASSO @G@\n3 ROLE GODP\n2 ASSO @U@\n3 ROLE GODP\n` +
      `0 @F@ INDI\n1 FAMC @F0@\n1 FAMS @F1@\n0 @M@ INDI\n1 FAMS @F1@\n` +
      `0 @U@ INDI\n1 FAMC @F0@\n0 @GF@ INDI\n1 FAMS @F0@\n` +
      `0 @G@ INDI\n1 FAMS @F2@\n0 @GS@ INDI\n1 FAMC @F2@\n0 @W@ INDI\n0 @X@ INDI\n` +
      `0 @F0@ FAM\n1 HUSB @GF@\n1 CHIL @F@\n1 CHIL @U@\n` +
      `0 @F1@ FAM\n1 HUSB @F@\n1 WIFE @M@\n1 CHIL @C@\n1 MARR\n2 ASSO @W@\n3 ROLE WITN\n` +
      `0 @F2@ FAM\n1 HUSB @G@\n1 CHIL @GS@\n0 TRLR\n`,
  );
  const ties = assocLinks(ds, buildAssociationIndex(ds));

  it("joins two families over the one association between them", () => {
    const paths = assocPaths(ds, "@F@", "@GS@", ties);
    expect(paths.map(ids)).toEqual([["@F@", "@C@", "@G@", "@GS@"]]);
    expect(edges(paths[0])).toEqual([undefined, "child", "assoc", "child"]);
    expect(paths[0].kind).toBe("assoc");
  });

  it("reads the far family's steps the right way round", () => {
    // From the godfather's son back to the child's grandfather.
    expect(edges(assocPaths(ds, "@GS@", "@GF@", ties)[0])).toEqual([undefined, "parent", "assoc", "parent", "parent"]);
  });

  it("offers the association beside a kinship that is as close or closer", () => {
    // C and uncle U: kin in three steps, godchild and godfather in one.
    expect(assocPaths(ds, "@C@", "@U@", ties).map(ids)).toEqual([["@C@", "@U@"]]);
    // C and his own father: the father's brother is C's godfather.
    expect(assocPaths(ds, "@C@", "@F@", ties).map(ids)).toContainEqual(["@C@", "@U@", "@GF@", "@F@"]);
  });

  it("takes a couple's witness over the nearer partner only", () => {
    // W witnessed the wedding of F and M: from C, one route, not one per parent.
    const paths = assocPaths(ds, "@C@", "@W@", ties);
    expect(paths.map(ids)).toEqual([["@C@", "@F@", "@W@"]]);
  });

  it("never passes a person twice, and keeps to the limit", () => {
    for (const p of assocPaths(ds, "@C@", "@F@", ties)) expect(new Set(ids(p)).size).toBe(ids(p)!.length);
    expect(assocPaths(ds, "@C@", "@F@", ties, 1)).toHaveLength(1);
  });

  it("finds nothing where no single association joins them", () => {
    expect(assocPaths(ds, "@C@", "@X@", ties)).toEqual([]);
    expect(assocPaths(ds, "@C@", "@C@", ties)).toEqual([]);
  });
});
