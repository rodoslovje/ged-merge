import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildRelationshipChart } from "./relationshipLayout";
import { NODE_H, NODE_W } from "./treeLayout";
import { buildAssociationIndex } from "../gedcom/assoc";
import { assocLinks, bloodPath, shortestPath } from "../match/relationshipPath";

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
1 FAMS @F6@
0 @I20@ INDI
1 NAME CousinWife /Test/
1 SEX F
1 FAMC @F7@
1 FAMS @F6@
0 @I21@ INDI
1 NAME CousinWifeFather /Test/
1 SEX M
1 FAMS @F7@
0 @I22@ INDI
1 NAME CousinWifeMother /Test/
1 SEX F
1 FAMS @F7@
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
0 @F6@ FAM
1 HUSB @I8@
1 WIFE @I20@
0 @F7@ FAM
1 HUSB @I21@
1 WIFE @I22@
1 CHIL @I20@
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
    // Generations count from the start person as the rows draw them: the
    // parents one up, the common grandparents two, the cousin level with ego.
    expect(box("@I1@").gen).toBe(0);
    expect(box("@I2@").gen).toBe(1);
    expect(box("@I3@").gen).toBe(1);
    expect(box("@I4@").gen).toBe(2);
    expect(box("@I6@").gen).toBe(1);
    expect(box("@I8@").gen).toBe(0);

    // Three couples (I2/I3, I4/I5, I6/I7) → 3 partner lines; 4 parent drops.
    expect(chart.links.filter((l) => l.kind === "partner")).toHaveLength(3);
    expect(chart.links.filter((l) => l.kind === "parent")).toHaveLength(4);
    expect(chart.rootKey).toBe("@I1@");
  });

  it("hangs a descent straight below the start person, the other parent beside them", () => {
    // Grandmother @I5@ to her grandson @I8@: her husband @I4@ is the other
    // parent of their son @I6@, so he stands beside her, off the line.
    const chart = buildRelationshipChart(ds, bloodPath(ds, "@I5@", "@I8@")!);
    const box = (id: string) => chart.boxes.find((b) => b.id === id)!;
    expect(box("@I5@").x).toBe(box("@I6@").x);
    expect(box("@I6@").x).toBe(box("@I8@").x);
    expect(box("@I4@").onSpine).toBe(false);
    expect(box("@I4@").y).toBe(box("@I5@").y);
    // The son's wife lines up under her father-in-law.
    expect(box("@I7@").x).toBe(box("@I4@").x);
  });

  it("draws an in-law path with a spouse hop and one couple", () => {
    const chart = buildRelationshipChart(ds, shortestPath(ds, "@I1@", "@I10@")!);

    expect(idSet(chart)).toEqual(new Set(["@I1@", "@I9@", "@I10@", "@I11@"]));
    expect(chart.boxes.find((b) => b.id === "@I11@")!.onSpine).toBe(false);
    // Spouse link (I1~I9) + couple link (I10~I11) = 2 partner lines; 1 parent drop.
    expect(chart.links.filter((l) => l.kind === "partner")).toHaveLength(2);
    expect(chart.links.filter((l) => l.kind === "parent")).toHaveLength(1);
  });

  it("keeps rails from overlapping when the path turns more than once", () => {
    // Ego → grandfather (apex) → cousin → cousin's wife (a marriage) → her
    // father. The second ascent (into the wife's family) must not collide with
    // the first descent (the cousin's line): every box gets its own cell, and
    // every parent drop connects a real box directly above its child.
    const chart = buildRelationshipChart(ds, shortestPath(ds, "@I1@", "@I21@")!);

    // No two boxes share a coordinate cell (the multi-apex overlap bug).
    const cells = chart.boxes.map((b) => `${b.x},${b.y}`);
    expect(new Set(cells).size).toBe(chart.boxes.length);

    // The cousin's wife's other parent is drawn, not dropped or buried.
    expect(chart.boxes.some((b) => b.id === "@I22@")).toBe(true);

    // Every parent drop starts on a real parent box's bottom edge — not dangling
    // into an empty cell (the old fixed stub started wherever the child's column
    // happened to be, so a column-shifted parent left it hanging in blank space).
    const box = (id: string) => chart.boxes.find((b) => b.id === id);
    for (const link of chart.links.filter((l) => l.kind === "parent")) {
      const [, sx, sy] = link.d.match(/^M([\d.-]+),([\d.-]+)/)!;
      const onABox = chart.boxes.some(
        (b) => Math.abs(b.x + NODE_W / 2 - Number(sx)) < 0.5 && Math.abs(b.y + NODE_H - Number(sy)) < 0.5,
      );
      expect(onABox).toBe(true);
    }
    expect(box("@I1@")!.role).toBe("start");
    expect(box("@I21@")!.role).toBe("target");
  });

  it("carries the couple's marriage (year + place) on the partner link", () => {
    const chart = buildRelationshipChart(ds, bloodPath(ds, "@I1@", "@I8@")!);
    // The common-ancestor couple (I4/I5) records a MARR; their partner line gets it.
    const link = chart.links.find((l) => l.id === "p~@I4@~@I5@")!;
    // Undated people read as presumed living, so the couple is flagged: the
    // chart drops the label when privacy is on.
    expect(link.marriage).toEqual({ year: "1800", place: "Kranj", living: true });
    expect(link.mid).toBeDefined();
    // A couple with no MARR (I2/I3) leaves the link's marriage undefined.
    expect(chart.links.find((l) => l.id === "p~@I2@~@I3@")!.marriage).toBeUndefined();
  });
});

describe("buildRelationshipChart through an association", () => {
  // C's godfather G has a son GS; nothing else joins the two families.
  const ds = dataset(
    `0 HEAD\n1 GEDC\n2 VERS 7.0\n` +
      `0 @C@ INDI\n1 BIRT\n2 ASSO @G@\n3 ROLE GODP\n` +
      `0 @G@ INDI\n1 FAMS @F2@\n0 @GW@ INDI\n1 FAMS @F2@\n0 @GS@ INDI\n1 FAMC @F2@\n` +
      `0 @F2@ FAM\n1 HUSB @G@\n1 WIFE @GW@\n1 CHIL @GS@\n0 TRLR\n`,
  );
  const ties = assocLinks(ds, buildAssociationIndex(ds));
  const box = (chart: ReturnType<typeof buildRelationshipChart>, id: string) => chart.boxes.find((b) => b.id === id)!;

  it("stands the godparent beside the child, on a link of its own kind", () => {
    const chart = buildRelationshipChart(ds, shortestPath(ds, "@C@", "@GS@", ties)!);
    const c = box(chart, "@C@"), g = box(chart, "@G@"), gs = box(chart, "@GS@");
    expect(g.y).toBe(c.y);
    expect(g.x).toBeGreaterThan(c.x);
    // His son hangs straight below him, the mother beside as a partner.
    expect(gs.x).toBe(g.x);
    expect(gs.y).toBeGreaterThan(g.y);
    expect(box(chart, "@GW@").onSpine).toBe(false);
    const tie = chart.links.filter((l) => l.kind === "assoc");
    expect(tie).toHaveLength(1);
    // The godfather is at the link's far end.
    expect(tie[0].assoc).toMatchObject({ associateId: "@G@", far: true, assoc: { role: "GODP" } });
    expect(tie[0].mid).toBeDefined();
    expect(chart.links.filter((l) => l.kind === "partner")).toHaveLength(1);
  });

  it("points the link back at the godparent when the path starts from his side", () => {
    const chart = buildRelationshipChart(ds, shortestPath(ds, "@GS@", "@C@", ties)!);
    expect(box(chart, "@C@").y).toBe(box(chart, "@G@").y);
    expect(chart.links.find((l) => l.kind === "assoc")?.assoc).toMatchObject({ associateId: "@G@", far: false });
  });
});
