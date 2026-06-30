import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildRelationshipChart } from "./relationshipChartLayout";
import { bloodPath, shortestPath } from "./relationshipPath";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

// Same family as relationshipPath.test: ego I1; parents I2/I3; grandparents
// I4/I5; uncle I6 (+ I7) with cousin I8; spouse I9 with in-laws I10/I11.
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
1 MARR
2 DATE 1800
2 PLAC Kranj, Slovenija
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

describe("relationshipChartLayout", () => {
  const ds = dataset(TREE);

  const idSet = (chart: { boxes: { id: string }[] }) => new Set(chart.boxes.map((b) => b.id));

  it("draws a blood path as two vertical rails joined at the common ancestor", () => {
    const chart = buildRelationshipChart(ds, bloodPath(ds, "@I1@", "@I8@")!);

    // 5 spine people + 3 "other parent" context boxes (@I3@, @I5@, @I7@).
    expect(idSet(chart)).toEqual(
      new Set(["@I1@", "@I2@", "@I3@", "@I4@", "@I5@", "@I6@", "@I7@", "@I8@"]),
    );
    expect(new Set(chart.boxes.filter((b) => !b.onSpine).map((b) => b.id))).toEqual(
      new Set(["@I3@", "@I5@", "@I7@"]),
    );

    const box = (id: string) => chart.boxes.find((b) => b.id === id)!;
    // Common ancestor @I4@ sits at the top; the two endpoints at the bottom.
    expect(box("@I4@").y).toBeLessThan(box("@I2@").y);
    expect(box("@I1@").y).toBe(box("@I8@").y);
    expect(box("@I1@").y).toBeGreaterThan(box("@I2@").y);

    // Each direct line is a single column: start's ancestors all share one x,
    // the target's descendants another — only two rails wide (plus spouses).
    expect(box("@I1@").x).toBe(box("@I2@").x);
    expect(box("@I2@").x).toBe(box("@I4@").x);
    expect(box("@I6@").x).toBe(box("@I8@").x);
    expect(box("@I4@").x).not.toBe(box("@I8@").x);

    expect(box("@I1@").role).toBe("start");
    expect(box("@I8@").role).toBe("target");

    // Three couples (I2/I3, I4/I5, I6/I7) → 3 partner lines; 4 parent drops.
    expect(chart.links.filter((l) => l.kind === "partner")).toHaveLength(3);
    expect(chart.links.filter((l) => l.kind === "parent")).toHaveLength(4);
    expect(chart.rootKey).toBe("@I1@");
  });

  it("draws an in-law path with a spouse hop and one couple", () => {
    const chart = buildRelationshipChart(ds, shortestPath(ds, "@I1@", "@I10@")!);

    expect(idSet(chart)).toEqual(new Set(["@I1@", "@I9@", "@I10@", "@I11@"]));
    expect(chart.boxes.find((b) => b.id === "@I11@")!.onSpine).toBe(false);
    // Spouse link (I1~I9) + couple link (I10~I11) = 2 partner lines; 1 parent drop.
    expect(chart.links.filter((l) => l.kind === "partner")).toHaveLength(2);
    expect(chart.links.filter((l) => l.kind === "parent")).toHaveLength(1);
  });

  it("carries the couple's marriage (year + place) on the partner link", () => {
    const chart = buildRelationshipChart(ds, bloodPath(ds, "@I1@", "@I8@")!);
    // The common-ancestor couple (I4/I5) records a MARR; their partner line gets it.
    const link = chart.links.find((l) => l.id === "p~@I4@~@I5@")!;
    expect(link.marriage).toEqual({ year: "1800", place: "Kranj" });
    expect(link.mid).toBeDefined();
    // A couple with no MARR (I2/I3) leaves the link's marriage undefined.
    expect(chart.links.find((l) => l.id === "p~@I2@~@I3@")!.marriage).toBeUndefined();
  });
});
