import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { decisionKey, type CandidateDecision } from "../review/types";
import { mergeDecisions } from "./merge";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const tr = (key: string) => key;

// The main has its own, unrelated @O1@; the incoming child's primary-photo
// vendor tag names the incoming file's @O1@.
const MAIN = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 OBJE @O1@\n" +
  "0 @O1@ OBJE\n1 FILE janez.jpg\n",
);
const COMPARE = wrap(
  "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G1@\n" +
  "0 @P4@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 OBJE @O1@\n1 _PHOTO @O1@\n1 FAMC @G1@\n" +
  "0 @G1@ FAM\n1 HUSB @P1@\n1 CHIL @P4@\n" +
  "0 @O1@ OBJE\n1 FILE tone.jpg\n",
);

describe("a vendor tag pointing at an incoming shared record follows it", () => {
  it("remaps an imported person's _PHOTO with the OBJE it names", () => {
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P4@"] }],
    ]);
    const { records } = mergeDecisions(dataset(MAIN), dataset(COMPARE), decisions, { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never, tr);
    const out = serializeGedcom(records);
    const tone = out.slice(out.indexOf("1 NAME Tone"), out.indexOf("0 @", out.indexOf("1 NAME Tone")));
    const objeRef = /1 OBJE (@[^@]+@)/.exec(tone)![1];
    expect(objeRef).not.toBe("@O1@");
    expect(tone).toContain(`1 _PHOTO ${objeRef}`);
    expect(out).toContain(`0 ${objeRef} OBJE\n1 FILE tone.jpg`);
  });

  it("imports a shared record named only by a vendor tag", () => {
    const compare = COMPARE.replace("1 OBJE @O1@\n1 _PHOTO", "1 _PHOTO");
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P4@"] }],
    ]);
    const { records } = mergeDecisions(dataset(MAIN), dataset(compare), decisions, { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never, tr);
    const out = serializeGedcom(records);
    const ref = /1 _PHOTO (@[^@]+@)/.exec(out)![1];
    expect(ref).not.toBe("@O1@");
    expect(out).toContain(`0 ${ref} OBJE\n1 FILE tone.jpg`);
  });
});
