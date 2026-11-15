import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { decisionKey, type CandidateDecision } from "../review/types";
import { mergeDecisions } from "./merge";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const tr = (key: string) => key;

describe("a confirmed pair outranks the matcher's other candidates", () => {
  // Two main Tones, both a candidate for the incoming child; the user
  // confirmed the first. The matcher lists the other one last.
  const main = dataset(wrap(
    "0 @I1@ INDI\n1 NAME Jože /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @F1@\n" +
    "0 @I2@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n" +
    "0 @I3@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n" +
    "0 @F1@ FAM\n1 HUSB @I1@\n",
  ));
  const compare = dataset(wrap(
    "0 @P1@ INDI\n1 NAME Jože /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @G1@\n" +
    "0 @P2@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n1 FAMC @G1@\n" +
    "0 @G1@ FAM\n1 HUSB @P1@\n1 CHIL @P2@\n",
  ));
  const matches = {
    individuals: [
      { mainId: "@I1@", compareId: "@P1@" },
      { mainId: "@I2@", compareId: "@P2@" },
      { mainId: "@I3@", compareId: "@P2@" },
    ],
  } as never;

  it("stitches the child the user confirmed, not the last candidate", () => {
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I2@", "@P2@"), { status: "confirmed", fields: {} }],
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P2@"] }],
    ]);
    const { records } = mergeDecisions(main, compare, decisions, matches, tr);
    const f1 = records.find((r) => r.xref === "@F1@")!;
    expect(f1.children.filter((c) => c.tag === "CHIL").map((c) => c.value)).toEqual(["@I2@"]);
  });
});
