import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { Translate } from "../locales/i18n";
import { createKinshipResolver, kinshipLabel } from "./kinship";
import { bloodLineage } from "./relationshipPath";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

// A bare translator: kinship.* keys map to their English-ish leaf word so the
// ×N suffixes are easy to assert on.
const labels: Record<string, string> = {
  "kinship.uncle": "Uncle",
  "kinship.aunt": "Aunt",
  "kinship.greatUncle": "Great-uncle",
  "kinship.greatAunt": "Great-aunt",
  "kinship.nephew": "Nephew",
  "kinship.grandNephew": "Grand-nephew",
  "kinship.grandNiece": "Grand-niece",
};
const t: Translate = (key) => labels[key] ?? key;

// Single-parent ancestor chain off I1: I5 is the great-great-grandparent
// (named outright), I20 above him the first ×N generation.
//   I1 ← I2 ← I3 ← I4 ← I5 ← I20
// Siblings hung off the chain give each great-uncle degree:
//   I8  = sibling of grandparent I3  → great-uncle      (hg 3, tg 1)
//   I6/I7 = siblings of g-grandparent I4 → great-uncle ×2 (hg 4, tg 1)
// A descent under I6 gives the long-leg cousins (all via the I5 apex):
//   I9 (hg 4, tg 2), I10 (hg 4, tg 3), I11 (hg 4, tg 4 → 3rd cousin)
const TREE = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ego /Test/
1 SEX M
1 FAMC @F1@
0 @I2@ INDI
1 NAME Father /Test/
1 SEX M
1 FAMC @F2@
1 FAMS @F1@
0 @I3@ INDI
1 NAME Grandfather /Test/
1 SEX M
1 FAMC @F3@
1 FAMS @F2@
0 @I4@ INDI
1 NAME GreatGrandfather /Test/
1 SEX M
1 FAMC @F4@
1 FAMS @F3@
0 @I5@ INDI
1 NAME Apex /Test/
1 SEX M
1 FAMC @F8@
1 FAMS @F4@
0 @I6@ INDI
1 NAME GreatGreatUncle /Test/
1 SEX M
1 FAMC @F4@
1 FAMS @F5@
0 @I7@ INDI
1 NAME GreatGreatAunt /Test/
1 SEX F
1 FAMC @F4@
0 @I8@ INDI
1 NAME GreatUncle /Test/
1 SEX M
1 FAMC @F3@
0 @I9@ INDI
1 NAME FirstCousinTwiceRemoved /Test/
1 SEX M
1 FAMC @F5@
1 FAMS @F6@
0 @I10@ INDI
1 NAME SecondCousinOnceRemoved /Test/
1 SEX M
1 FAMC @F6@
1 FAMS @F7@
0 @I11@ INDI
1 NAME ThirdCousin /Test/
1 SEX M
1 FAMC @F7@
0 @I20@ INDI
1 NAME ApexFather /Test/
1 SEX M
1 FAMS @F8@
0 @F1@ FAM
1 HUSB @I2@
1 CHIL @I1@
0 @F2@ FAM
1 HUSB @I3@
1 CHIL @I2@
0 @F3@ FAM
1 HUSB @I4@
1 CHIL @I3@
1 CHIL @I8@
0 @F4@ FAM
1 HUSB @I5@
1 CHIL @I4@
1 CHIL @I6@
1 CHIL @I7@
0 @F5@ FAM
1 HUSB @I6@
1 CHIL @I9@
0 @F6@ FAM
1 HUSB @I9@
1 CHIL @I10@
0 @F7@ FAM
1 HUSB @I10@
1 CHIL @I11@
0 @F8@ FAM
1 HUSB @I20@
1 CHIL @I5@
0 TRLR
`;

describe("kinshipLabel great-uncle / grand-nephew degrees", () => {
  const ds = dataset(TREE);

  it("labels a grandparent's sibling as great-uncle (no ×)", () => {
    expect(kinshipLabel(ds, "@I1@", "@I8@", t)).toBe("Great-uncle");
  });

  it("labels a great-grandparent's sibling as great-uncle ×2", () => {
    expect(kinshipLabel(ds, "@I1@", "@I6@", t)).toBe("Great-uncle ×2");
    expect(kinshipLabel(ds, "@I1@", "@I7@", t)).toBe("Great-aunt ×2");
  });

  it("labels the symmetric descendant as grand-nephew ×2", () => {
    expect(kinshipLabel(ds, "@I6@", "@I1@", t)).toBe("Grand-nephew ×2");
  });
});

describe("kinshipLabel direct line", () => {
  const ds = dataset(TREE);

  it("names the 4th generation outright as great-great", () => {
    expect(kinshipLabel(ds, "@I1@", "@I5@", t)).toBe("kinship.greatGrandfather2");
    expect(kinshipLabel(ds, "@I5@", "@I1@", t)).toBe("kinship.greatGrandson2");
  });

  it("falls back to ×N from the 5th generation on", () => {
    expect(kinshipLabel(ds, "@I1@", "@I20@", t)).toBe("kinship.greatGrandfather ×3");
    expect(kinshipLabel(ds, "@I20@", "@I1@", t)).toBe("kinship.greatGrandson ×3");
  });
});

describe("kinshipLabel deep cousins", () => {
  const ds = dataset(TREE);

  it("labels a long-leg cousin by the shorter leg plus the removal", () => {
    expect(kinshipLabel(ds, "@I1@", "@I9@", t)).toBe("kinship.cousin1_M +2");
    expect(kinshipLabel(ds, "@I1@", "@I10@", t)).toBe("kinship.cousin2_M +1");
  });

  it("gives a 3rd cousin its own key instead of a bare ordinal", () => {
    expect(kinshipLabel(ds, "@I1@", "@I11@", t)).toBe("kinship.cousin3_M");
  });
});

// Ego I1 (child of father I2 + mother I3, full brother I10, wife I6).
// The father remarried I4 (step-mother): their son I5 is a half-brother.
// The step-mother's daughter I7 from her earlier union is a step-sister.
// The wife's son I8 from her earlier union is a step-son.
const STEP_TREE = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ego /Test/
1 SEX M
1 FAMC @F1@
1 FAMS @F5@
0 @I2@ INDI
1 NAME Father /Test/
1 SEX M
1 FAMS @F1@
1 FAMS @F2@
0 @I3@ INDI
1 NAME Mother /Test/
1 SEX F
1 FAMS @F1@
0 @I4@ INDI
1 NAME Stepmother /Test/
1 SEX F
1 FAMS @F2@
1 FAMS @F3@
0 @I5@ INDI
1 NAME HalfBrother /Test/
1 SEX M
1 FAMC @F2@
0 @I7@ INDI
1 NAME StepSister /Test/
1 SEX F
1 FAMC @F3@
0 @I6@ INDI
1 NAME Wife /Test/
1 SEX F
1 FAMS @F5@
1 FAMS @F4@
0 @I8@ INDI
1 NAME StepSon /Test/
1 SEX M
1 FAMC @F4@
0 @I10@ INDI
1 NAME Brother /Test/
1 SEX M
1 FAMC @F1@
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I3@
1 CHIL @I1@
1 CHIL @I10@
0 @F2@ FAM
1 HUSB @I2@
1 WIFE @I4@
1 CHIL @I5@
0 @F3@ FAM
1 WIFE @I4@
1 CHIL @I7@
0 @F4@ FAM
1 WIFE @I6@
1 CHIL @I8@
0 @F5@ FAM
1 HUSB @I1@
1 WIFE @I6@
0 TRLR
`;

describe("kinshipLabel half and step relations", () => {
  const ds = dataset(STEP_TREE);

  it("keeps a both-parents sibling a plain sibling", () => {
    expect(kinshipLabel(ds, "@I1@", "@I10@", t)).toBe("kinship.brother");
  });

  it("labels a one-shared-parent sibling as half-brother (both directions)", () => {
    expect(kinshipLabel(ds, "@I1@", "@I5@", t)).toBe("kinship.halfBrother");
    expect(kinshipLabel(ds, "@I5@", "@I1@", t)).toBe("kinship.halfBrother");
  });

  it("labels a parent's other spouse as step-mother, and inversely step-son", () => {
    expect(kinshipLabel(ds, "@I1@", "@I4@", t)).toBe("kinship.stepMother");
    expect(kinshipLabel(ds, "@I4@", "@I1@", t)).toBe("kinship.stepSon");
  });

  it("labels a spouse's child from another union as step-son", () => {
    expect(kinshipLabel(ds, "@I1@", "@I8@", t)).toBe("kinship.stepSon");
  });

  it("labels a step-parent's child from another union as step-sister", () => {
    expect(kinshipLabel(ds, "@I1@", "@I7@", t)).toBe("kinship.stepSister");
  });

  it("still finds nothing for genuinely unrelated people", () => {
    // The wife's earlier child vs the step-mother's earlier child: no blood,
    // no marriage connecting their parents.
    expect(kinshipLabel(ds, "@I8@", "@I7@", t)).toBeUndefined();
  });
});

// Ego I1 with cousins of both sexes at each degree:
//   I7 (g-grandfather) ─┬─ I5 (grandfather) ─┬─ I2 ── I1 (ego)
//                       │                    └─ I3 ─┬─ I4 (m) ── I10 (m)
//                       │                           └─ I6 (f)
//                       └─ I11 ── I12 ─┬─ I8 (m)
//                                      └─ I9 (f)
// I4/I6 are 1st cousins, I10 a 1st cousin once removed, I8/I9 2nd cousins.
const COUSIN_TREE = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ego /Test/
1 SEX M
1 FAMC @F1@
0 @I2@ INDI
1 NAME Father /Test/
1 SEX M
1 FAMC @F3@
1 FAMS @F1@
0 @I3@ INDI
1 NAME Uncle /Test/
1 SEX M
1 FAMC @F3@
1 FAMS @F2@
0 @I5@ INDI
1 NAME Grandfather /Test/
1 SEX M
1 FAMC @F5@
1 FAMS @F3@
0 @I7@ INDI
1 NAME GreatGrandfather /Test/
1 SEX M
1 FAMS @F5@
0 @I11@ INDI
1 NAME GreatUncle /Test/
1 SEX M
1 FAMC @F5@
1 FAMS @F6@
0 @I12@ INDI
1 NAME FirstCousinOnceRemovedUp /Test/
1 SEX M
1 FAMC @F6@
1 FAMS @F7@
0 @I4@ INDI
1 NAME MaleCousin /Test/
1 SEX M
1 FAMC @F2@
1 FAMS @F4@
0 @I6@ INDI
1 NAME FemaleCousin /Test/
1 SEX F
1 FAMC @F2@
0 @I10@ INDI
1 NAME CousinsSon /Test/
1 SEX M
1 FAMC @F4@
0 @I8@ INDI
1 NAME MaleSecondCousin /Test/
1 SEX M
1 FAMC @F7@
0 @I9@ INDI
1 NAME FemaleSecondCousin /Test/
1 SEX F
1 FAMC @F7@
0 @F1@ FAM
1 HUSB @I2@
1 CHIL @I1@
0 @F2@ FAM
1 HUSB @I3@
1 CHIL @I4@
1 CHIL @I6@
0 @F3@ FAM
1 HUSB @I5@
1 CHIL @I2@
1 CHIL @I3@
0 @F4@ FAM
1 HUSB @I4@
1 CHIL @I10@
0 @F5@ FAM
1 HUSB @I7@
1 CHIL @I5@
1 CHIL @I11@
0 @F6@ FAM
1 HUSB @I11@
1 CHIL @I12@
0 @F7@ FAM
1 HUSB @I12@
1 CHIL @I8@
1 CHIL @I9@
0 TRLR
`;

describe("kinshipLabel cousins", () => {
  const ds = dataset(COUSIN_TREE);

  it("names a cousin by sex rather than a combined label", () => {
    expect(kinshipLabel(ds, "@I1@", "@I4@", t)).toBe("kinship.cousin1_M");
    expect(kinshipLabel(ds, "@I1@", "@I6@", t)).toBe("kinship.cousin1_F");
  });

  it("does the same for second cousins", () => {
    expect(kinshipLabel(ds, "@I1@", "@I8@", t)).toBe("kinship.cousin2_M");
    expect(kinshipLabel(ds, "@I1@", "@I9@", t)).toBe("kinship.cousin2_F");
  });

  it("keeps the removed-degree suffix on the sexed label", () => {
    expect(kinshipLabel(ds, "@I1@", "@I10@", t)).toBe("kinship.cousin1_M +1");
  });
});

describe("createKinshipResolver", () => {
  // The resolver is a cached view over kinshipLabel/bloodLineage: for a fixed
  // start person it must agree with the direct functions on every target and
  // every relation shape — ancestor, sibling, spouse, step, self, unrelated.
  const trees = { TREE, STEP_TREE };

  for (const [name, text] of Object.entries(trees)) {
    it(`matches the direct functions on every pair (${name})`, () => {
      const ds = dataset(text);
      for (const startId of ds.individuals.keys()) {
        const resolver = createKinshipResolver(ds, startId, t);
        for (const targetId of ds.individuals.keys()) {
          // Twice, so the second read exercises the cache path.
          for (let round = 0; round < 2; round++) {
            expect(resolver.label(targetId)).toBe(kinshipLabel(ds, startId, targetId, t));
            expect(resolver.lineage(targetId)).toBe(bloodLineage(ds, startId, targetId));
          }
        }
      }
    });
  }

  it("handles an unknown start person", () => {
    const ds = dataset(TREE);
    const resolver = createKinshipResolver(ds, "@NOPE@", t);
    expect(resolver.label("@I1@")).toBeUndefined();
    expect(resolver.lineage("@I1@")).toBeUndefined();
  });
});
