import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { applyDistanceRanking, computeDistances } from "./distance";
import type { IndividualCandidate, MatchResult } from "./types";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

// Home person @I1@; @I2@ spouse (1), @I3@ child (1), @I4@ grandchild (2),
// @I5@ parent (1), @I6@ sibling (2 via shared parents).
const TREE = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Home /Person/
1 FAMS @F1@
1 FAMC @F2@
0 @I2@ INDI
1 NAME Spouse /Person/
1 FAMS @F1@
0 @I3@ INDI
1 NAME Child /Person/
1 FAMC @F1@
1 FAMS @F3@
0 @I4@ INDI
1 NAME Grand /Person/
1 FAMC @F3@
0 @I5@ INDI
1 NAME Parent /Person/
1 FAMS @F2@
0 @I6@ INDI
1 NAME Sibling /Person/
1 FAMC @F2@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
0 @F2@ FAM
1 HUSB @I5@
1 CHIL @I1@
1 CHIL @I6@
0 @F3@ FAM
1 HUSB @I3@
1 CHIL @I4@
0 TRLR
`;

describe("computeDistances", () => {
  const ds = dataset(TREE);
  const d = computeDistances(ds, "@I1@");

  it("measures parent/child/spouse as one hop", () => {
    expect(d.get("@I1@")).toBe(0);
    expect(d.get("@I2@")).toBe(1); // spouse
    expect(d.get("@I3@")).toBe(1); // child
    expect(d.get("@I5@")).toBe(1); // parent
  });

  it("measures grandchild and sibling as two hops", () => {
    expect(d.get("@I4@")).toBe(2); // grandchild
    expect(d.get("@I6@")).toBe(2); // sibling (via shared parent)
  });

  it("returns empty for an unknown home id", () => {
    expect(computeDistances(ds, "@NOPE@").size).toBe(0);
  });
});

describe("applyDistanceRanking", () => {
  it("sorts by distance ascending, then score descending", () => {
    const ds = dataset(TREE);
    const cand = (masterId: string, score: number): IndividualCandidate => ({
      masterId,
      compareId: `c-${masterId}`,
      score,
      category: "probable",
      components: [],
      title: masterId,
      name: masterId,
      sex: "U",
    });
    // Intentionally unsorted, mixing distances and scores.
    const result: MatchResult = {
      individuals: [cand("@I4@", 99), cand("@I3@", 50), cand("@I1@", 10), cand("@I2@", 90)],
    };

    const ranked = applyDistanceRanking(result, ds, "@I1@");
    expect(ranked.individuals.map((c) => c.masterId)).toEqual([
      "@I1@", // dist 0
      "@I2@", // dist 1, score 90
      "@I3@", // dist 1, score 50
      "@I4@", // dist 2
    ]);
    expect(ranked.individuals[0].distance).toBe(0);
  });
});
