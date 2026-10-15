import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { decisionKey, type CandidateDecision } from "../review/types";
import { branchImportRecords } from "./branchSize";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const NO_DECISIONS = new Map<string, CandidateDecision>();

// Three generations above the anchor: parents P2 + P3, grandfather P4.
const COMPARE = dataset(
  wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMC @G1@\n" +
      "0 @P2@ INDI\n1 NAME Oce /Novak/\n1 SEX M\n1 FAMS @G1@\n1 FAMC @G2@\n" +
      "0 @P3@ INDI\n1 NAME Mati /Kos/\n1 SEX F\n1 FAMS @G1@\n" +
      "0 @P4@ INDI\n1 NAME Ded /Novak/\n1 SEX M\n1 FAMS @G2@\n" +
      "0 @G1@ FAM\n1 HUSB @P2@\n1 WIFE @P3@\n1 CHIL @P1@\n" +
      "0 @G2@ FAM\n1 HUSB @P4@\n1 CHIL @P2@\n",
  ),
);

describe("branchImportRecords", () => {
  it("counts every new person and family of an ancestral branch", () => {
    const main = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n"));
    const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never;
    const out = branchImportRecords([{ incomingId: "@P1@", direction: "ancestors" }], main, COMPARE, NO_DECISIONS, matches);
    expect([...out].sort()).toEqual(["F:@G1@", "F:@G2@", "I:@P2@", "I:@P3@", "I:@P4@"]);
  });

  it("does not count a matched ancestor, nor a rejected match as matched", () => {
    const main = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n0 @I2@ INDI\n1 NAME Oce /Novak/\n1 SEX M\n"),
    );
    const matches = {
      individuals: [
        { mainId: "@I1@", compareId: "@P1@" },
        { mainId: "@I2@", compareId: "@P2@" },
      ],
    } as never;
    const req = [{ incomingId: "@P1@", direction: "ancestors" as const }];
    expect(branchImportRecords(req, main, COMPARE, NO_DECISIONS, matches).has("I:@P2@")).toBe(false);
    const rejected = new Map([[decisionKey("individual", "@I2@", "@P2@"), { status: "rejected" } as CandidateDecision]]);
    expect(branchImportRecords(req, main, COMPARE, rejected, matches).has("I:@P2@")).toBe(true);
  });

  it("stops where the main file already records a different parent", () => {
    const main = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMC @F1@\n" +
          "0 @I2@ INDI\n1 NAME Stari /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
          "0 @F1@ FAM\n1 HUSB @I2@\n1 CHIL @I1@\n",
      ),
    );
    const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never;
    const out = branchImportRecords([{ incomingId: "@P1@", direction: "ancestors" }], main, COMPARE, NO_DECISIONS, matches);
    // The rival father and his line stay out; the empty mother slot is filled.
    expect([...out]).toEqual(["I:@P3@"]);
  });

  it("counts a descendant branch's spouses, children and their unions", () => {
    const main = dataset(wrap("0 @I1@ INDI\n1 NAME Ded /Novak/\n1 SEX M\n"));
    const matches = { individuals: [{ mainId: "@I1@", compareId: "@P4@" }] } as never;
    const out = branchImportRecords([{ incomingId: "@P4@", direction: "descendants" }], main, COMPARE, NO_DECISIONS, matches);
    expect([...out].sort()).toEqual(["F:@G1@", "F:@G2@", "I:@P1@", "I:@P2@", "I:@P3@"]);
  });
});
