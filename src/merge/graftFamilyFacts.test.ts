import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { decisionKey, type CandidateDecision } from "../review/types";
import { mergeDecisions, type ImportBranchRequest } from "./merge";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// Jože is in both files; the incoming one knows his parents' marriage and his
// son Tone's.
const MAIN = wrap("0 @I1@ INDI\n1 NAME Jože /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n");
const COMPARE = wrap(
  "0 @P1@ INDI\n1 NAME Jože /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @G1@\n1 FAMC @G0@\n" +
  "0 @P2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @G1@\n" +
  "0 @P3@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 FAMC @G1@\n1 FAMS @G2@\n" +
  "0 @P4@ INDI\n1 NAME Peter /Novak/\n1 SEX M\n1 FAMS @G0@\n" +
  "0 @P5@ INDI\n1 NAME Neža /Zupan/\n1 SEX F\n1 FAMS @G0@\n" +
  "0 @P6@ INDI\n1 NAME Ana /Bizjak/\n1 SEX F\n1 FAMS @G2@\n" +
  "0 @G0@ FAM\n1 HUSB @P4@\n1 WIFE @P5@\n1 CHIL @P1@\n1 MARR\n2 DATE 1840\n2 SOUR @S1@\n" +
  "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 CHIL @P3@\n" +
  "0 @G2@ FAM\n1 HUSB @P3@\n1 WIFE @P6@\n1 MARR\n2 DATE 1905\n1 NOTE Poročila sta se v Kranju.\n" +
  "0 @S1@ SOUR\n1 TITL Poročna knjiga\n",
);

function graft(requests: ImportBranchRequest[]): string {
  const decisions = new Map<string, CandidateDecision>([[decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }]]);
  const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never;
  const { records } = mergeDecisions(dataset(MAIN), dataset(COMPARE), decisions, matches, (k) => k, requests);
  return serializeGedcom(records);
}

describe("a grafted branch brings its families' own facts", () => {
  it("ancestors: the parents' marriage and its source", () => {
    const out = graft([{ incomingId: "@P1@", direction: "ancestors" }]);
    expect(out).toMatch(/1 MARR\n2 DATE 1840\n2 SOUR @S1@/);
    expect(out).toContain("1 TITL Poročna knjiga");
  });

  it("descendants: a son's marriage and its note", () => {
    const out = graft([{ incomingId: "@P1@", direction: "descendants" }]);
    expect(out).toMatch(/1 MARR\n2 DATE 1905/);
    expect(out).toContain("Poročila sta se v Kranju.");
  });
});
