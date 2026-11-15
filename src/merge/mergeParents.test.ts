import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { Dataset, GedNode } from "../gedcom/types";
import { decisionKey, type CandidateDecision } from "../review/types";
import { incomingParentIds, individualFieldRows } from "../review/fields";
import { mergeDecisions } from "./merge";
import { wantedAdds } from "./materialize";

// The merge must link exactly the parents the review's Parents rows offer —
// the same people, in the same slots.

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const tr = (key: string) => key;
const NO_MATCHES = { individuals: [], families: [] };
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const decide = (): Map<string, CandidateDecision> =>
  new Map([[decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }]]);

/** The main child's parents after the merge, by name: [father, mother] per family. */
function parentsAfter(main: Dataset, compare: Dataset): string[][] {
  const { records } = mergeDecisions(main, compare, decide(), NO_MATCHES, tr);
  const byId = new Map(records.filter((r) => r.xref).map((r) => [r.xref!, r]));
  const name = (id: string | undefined) =>
    id ? byId.get(id)?.children.find((c) => c.tag === "NAME")?.value ?? id : "";
  const child = byId.get("@I1@")!;
  return child.children
    .filter((c) => c.tag === "FAMC")
    .map((c) => byId.get(c.value!) as GedNode)
    .map((fam) => [
      name(fam.children.find((c) => c.tag === "HUSB")?.value),
      name(fam.children.find((c) => c.tag === "WIFE")?.value),
    ]);
}

function reviewParents(main: Dataset, compare: Dataset): { father?: string; mother?: string } {
  const rows = individualFieldRows(tr, main.individuals.get("@I1@"), compare.individuals.get("@P1@"), main, compare);
  const text = (key: string) => rows.find((r) => r.key === key)?.incoming || undefined;
  return { father: text("father"), mother: text("mother") };
}

describe("merging parents the way the review shows them", () => {
  it("reads crossed parents crossed: no duplicate father as the mother", () => {
    // The incoming file records no sex and has the couple the other way round.
    const main = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Peter /Novak/\n1 BIRT\n2 DATE 1880\n1 FAMC @F1@\n" +
        "0 @I2@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @F1@\n" +
        "0 @F1@ FAM\n1 HUSB @I2@\n1 CHIL @I1@\n",
    ));
    const compare = dataset(wrap(
      "0 @P1@ INDI\n1 NAME Peter /Novak/\n1 BIRT\n2 DATE 1880\n1 FAMC @G1@\n" +
        "0 @P2@ INDI\n1 NAME Marija /Kos/\n1 BIRT\n2 DATE 1855\n1 FAMS @G1@\n" +
        "0 @P3@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850\n1 FAMS @G1@\n" +
        "0 @G1@ FAM\n1 HUSB @P2@\n1 WIFE @P3@\n1 CHIL @P1@\n",
    ));
    expect(incomingParentIds(main.individuals.get("@I1@"), compare.individuals.get("@P1@")!, main, compare, undefined))
      .toEqual({ father: "@P3@", mother: "@P2@" });
    expect(reviewParents(main, compare).mother).toContain("Marija");
    expect(parentsAfter(main, compare)).toEqual([["Janez /Novak/", "Marija /Kos/"]]);
  });

  it("finds each parent in whichever child family holds them, and joins them", () => {
    // The incoming person is a child in two families: one names only the
    // mother, the other only the father.
    const main = dataset(wrap("0 @I1@ INDI\n1 NAME Peter /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n"));
    const compare = dataset(wrap(
      "0 @P1@ INDI\n1 NAME Peter /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n1 FAMC @G1@\n1 FAMC @G2@\n" +
        "0 @P2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @G1@\n" +
        "0 @P3@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G2@\n" +
        "0 @G1@ FAM\n1 WIFE @P2@\n1 CHIL @P1@\n" +
        "0 @G2@ FAM\n1 HUSB @P3@\n1 CHIL @P1@\n",
    ));
    const review = reviewParents(main, compare);
    expect(review.father).toContain("Janez");
    expect(review.mother).toContain("Marija");
    expect([...wantedAdds(decide(), main, compare)].sort()).toEqual(["@P2@", "@P3@"]);
    expect(parentsAfter(main, compare)).toEqual([["Janez /Novak/", "Marija /Kos/"]]);
  });
});
