import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { headRegion, mergeFinds, overlap, tiles } from "./faceDetect";
import { closeFamily, nameCandidates } from "./faceNaming";

// Edvard ⚭ Cvetka with a son Luka; Edvard's parents Franc and Alojzija and
// brother Jože; Cvetka's brother Peter; and an unrelated Jožef.
const GED = `0 HEAD
1 GEDC
2 VERS 7.0
0 @E@ INDI
1 NAME Edvard /Renko/
1 FAMC @F1@
1 FAMS @F2@
0 @C@ INDI
1 NAME Cvetka /Jekovec/
1 FAMC @F3@
1 FAMS @F2@
0 @L@ INDI
1 NAME Luka /Renko/
1 FAMC @F2@
0 @FR@ INDI
1 NAME Franc /Renko/
1 FAMS @F1@
0 @A@ INDI
1 NAME Alojzija /Rakar/
1 FAMS @F1@
0 @J@ INDI
1 NAME Jože /Renko/
1 FAMC @F1@
0 @P@ INDI
1 NAME Peter /Jekovec/
1 FAMC @F3@
0 @X@ INDI
1 NAME Jožef /Rakar/
0 @F1@ FAM
1 HUSB @FR@
1 WIFE @A@
1 CHIL @J@
1 CHIL @E@
0 @F2@ FAM
1 HUSB @E@
1 WIFE @C@
1 CHIL @L@
0 @F3@ FAM
1 CHIL @P@
1 CHIL @C@
0 TRLR
`;
const ds = buildDataset(parseGedcom(new TextEncoder().encode(GED).buffer));

describe("closeFamily", () => {
  it("lists the person, spouse, children, parents, siblings, then the spouse's family", () => {
    expect(closeFamily(ds, "@E@")).toEqual(["@E@", "@C@", "@L@", "@FR@", "@A@", "@J@", "@P@"]);
  });
});

describe("nameCandidates", () => {
  it("offers close family when nothing is typed, minus those already marked", () => {
    expect(nameCandidates(ds, "@E@", "", 8, ["@E@"]).map((i) => i.id)).toEqual(["@C@", "@L@", "@FR@", "@A@", "@J@", "@P@"]);
  });
  it("matches word starts, accents optional, close family first", () => {
    expect(nameCandidates(ds, "@E@", "joz").map((i) => i.id)).toEqual(["@J@", "@X@"]);
    expect(nameCandidates(ds, "@E@", "peter jek").map((i) => i.id)).toEqual(["@P@"]);
    expect(nameCandidates(ds, "@E@", "zzz")).toEqual([]);
  });
});

describe("face geometry", () => {
  it("overlap is the shared area over the smaller box", () => {
    expect(overlap({ left: 0, top: 0, width: 10, height: 10 }, { left: 5, top: 5, width: 10, height: 10 })).toBeCloseTo(0.25);
    expect(overlap({ left: 0, top: 0, width: 100, height: 100 }, { left: 10, top: 10, width: 10, height: 10 })).toBe(1);
    expect(overlap({ left: 0, top: 0, width: 10, height: 10 }, { left: 20, top: 0, width: 10, height: 10 })).toBe(0);
  });
  it("merges finds of the same face, keeping the surest, left to right", () => {
    const a = { left: 100, top: 100, width: 50, height: 50 };
    const a2 = { left: 104, top: 98, width: 48, height: 52 };
    const b = { left: 10, top: 10, width: 40, height: 40 };
    expect(mergeFinds([{ box: a, score: 0.7 }, { box: a2, score: 0.9 }, { box: b, score: 0.8 }])).toEqual([b, a2]);
  });
  it("widens a face to the head and keeps it on the photo", () => {
    expect(headRegion({ left: 100, top: 100, width: 100, height: 100 }, 1000, 1000)).toEqual({ left: 70, top: 55, width: 160, height: 170 });
    expect(headRegion({ left: 0, top: 0, width: 100, height: 100 }, 120, 1000)).toEqual({ left: 0, top: 0, width: 120, height: 125 });
  });
  it("examines the whole photo and overlapping tiles inside it", () => {
    const small = tiles(800, 600);
    expect(small).toHaveLength(1 + 4);
    const large = tiles(3000, 4000);
    expect(large).toHaveLength(1 + 4 + 9);
    for (const t of large) {
      expect(t.left).toBeGreaterThanOrEqual(0);
      expect(t.top).toBeGreaterThanOrEqual(0);
      expect(t.left + t.width).toBeLessThanOrEqual(3000);
      expect(t.top + t.height).toBeLessThanOrEqual(4000);
    }
  });
});
