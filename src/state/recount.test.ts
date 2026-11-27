import { describe, expect, it } from "vitest";
import { buildMatchMaps, buildPersonTree, countImportable } from "../chart/personTree";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { Dataset } from "../gedcom/types";
import type { MatchCandidate, MatchResult } from "../match/types";
import { materializeAdds } from "../merge/materialize";
import { decisionKey, type CandidateDecision } from "../review/types";
import { annotateCounts } from "../worker/annotateCounts";
import { recountCandidates, redecidedPeople, withCounts } from "./recount";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const tr = (key: string) => key;

// A couple and a child both files have; the incoming file also knows the
// husband's father (Jakob, P5) and a second child (Marko, P4).
const MAIN = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @F1@\n" +
    "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1855\n1 FAMS @F1@\n" +
    "0 @I3@ INDI\n1 NAME Peter /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n1 FAMC @F1@\n" +
    "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 CHIL @I3@\n",
);
const COMPARE = wrap(
  "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @G1@\n1 FAMC @G2@\n" +
    "0 @P2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1855\n1 FAMS @G1@\n" +
    "0 @P3@ INDI\n1 NAME Peter /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n1 FAMC @G1@\n" +
    "0 @P4@ INDI\n1 NAME Marko /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1883\n1 FAMC @G1@\n" +
    "0 @P5@ INDI\n1 NAME Jakob /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1820\n1 FAMS @G2@\n" +
    "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 CHIL @P3@\n1 CHIL @P4@\n" +
    "0 @G2@ FAM\n1 HUSB @P5@\n1 CHIL @P1@\n",
);
const PAIRS: MatchResult = {
  individuals: [
    { mainId: "@I1@", compareId: "@P1@" },
    { mainId: "@I2@", compareId: "@P2@" },
    { mainId: "@I3@", compareId: "@P3@" },
  ] as MatchCandidate[],
};
const FATHER = decisionKey("individual", "@I1@", "@P1@");

const imports = (list: MatchCandidate[]) => list.map((c) => [c.ancestorCount, c.descendantCount]);

/** What the compare tree counts for each listed pair, as MergeView asks it. */
function treeImports(list: MatchCandidate[], main: Dataset, compare: Dataset, decisions: ReadonlyMap<string, CandidateDecision>) {
  const maps = buildMatchMaps({ individuals: list });
  const isRejected = (m: string, c: string) => decisions.get(decisionKey("individual", m, c))?.status === "rejected";
  return list.map((c) =>
    (["ancestors", "descendants"] as const).map((mode) => {
      const tree = buildPersonTree(tr, main.individuals.get(c.mainId), compare.individuals.get(c.compareId), main, compare, maps, mode, isRejected);
      return tree ? countImportable(tree) : 0;
    }),
  );
}

describe("recountCandidates", () => {
  it("stops offering the people a confirmed match has added", () => {
    const main = dataset(MAIN);
    const compare = dataset(COMPARE);
    const listed = annotateCounts(PAIRS, main, compare, undefined).individuals;
    expect(imports(listed)).toEqual([[1, 1], [0, 1], [1, 0]]);

    const before = new Map<string, CandidateDecision>();
    const after = new Map(before).set(FATHER, { status: "confirmed", fields: {}, takenChildren: ["@P4@"] });
    const { decisions, patches } = materializeAdds(main, compare, PAIRS, before, after, tr);
    const seeds = new Set([...patches.map((p) => p.id), ...redecidedPeople(before, decisions)]);
    const counts = recountCandidates(listed, seeds, main, compare, decisions, undefined);
    const recounted = withCounts(listed, counts);

    expect(imports(recounted)).toEqual([[0, 0], [0, 0], [0, 0]]);
    expect(imports(recounted)).toEqual(treeImports(recounted, main, compare, decisions));
  });

  it("follows a rejection as the compare tree does", () => {
    const main = dataset(MAIN);
    const compare = dataset(COMPARE);
    const listed = annotateCounts(PAIRS, main, compare, undefined).individuals;
    const before = new Map<string, CandidateDecision>();
    const decisions = new Map(before).set(FATHER, { status: "rejected", fields: {} });
    const recounted = withCounts(listed, recountCandidates(listed, redecidedPeople(before, decisions), main, compare, decisions, undefined));

    // The rejected father brings nobody, and his father is no longer reached
    // through the son.
    expect(imports(recounted)[2]).toEqual([0, 0]);
    expect(imports(recounted)).toEqual(treeImports(recounted, main, compare, decisions));
  });

  it("leaves every candidate away from the change as it was", () => {
    const main = dataset(MAIN);
    const compare = dataset(COMPARE);
    const listed = annotateCounts(PAIRS, main, compare, undefined).individuals;
    expect(recountCandidates(listed, [], main, compare, new Map(), undefined).size).toBe(0);
    expect(recountCandidates(listed, ["@I3@"], main, compare, new Map(), undefined).size).toBe(0);
    expect(withCounts(listed, new Map())).toBe(listed);
  });
});

describe("redecidedPeople", () => {
  it("names the people whose status changed, in either direction", () => {
    const confirmed: CandidateDecision = { status: "confirmed", fields: {} };
    const before = new Map([[FATHER, confirmed]]);
    expect([...redecidedPeople(new Map(), before)]).toEqual(["@I1@"]);
    expect([...redecidedPeople(before, new Map())]).toEqual(["@I1@"]);
    expect([...redecidedPeople(before, new Map([[FATHER, { ...confirmed, fields: { name: "main" } }]]))]).toEqual([]);
  });
});
