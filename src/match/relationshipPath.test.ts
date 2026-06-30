import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { bloodLineage, bloodPath, bloodPaths, relationshipPaths, shortestPath } from "./relationshipPath";

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
