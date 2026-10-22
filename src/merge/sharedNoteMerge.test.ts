import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { decisionKey, type CandidateDecision } from "../review/types";
import { mergeDecisions } from "./merge";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap7 = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 7.0\n${body}0 TRLR\n`;
const tr = (key: string) => key;
const NO_MATCHES = { individuals: [], families: [] };
const confirmed = (fields: CandidateDecision["fields"] = {}) => new Map<string, CandidateDecision>([
  [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields }],
]);

describe("a person's shared notes (SNOTE) merge like inline notes", () => {
  it("brings the incoming SNOTE pointer and its record across", () => {
    const main = dataset(wrap7("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n"));
    const compare = dataset(wrap7(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 SNOTE @N1@\n" +
      "0 @N1@ SNOTE Kmet na Gorenjskem\n",
    ));
    const { records, report } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toMatch(/0 @I1@ INDI\n1 NAME Janez \/Novak\/\n1 SEX M\n1 SNOTE @N1@\n/);
    expect(out).toContain("0 @N1@ SNOTE Kmet na Gorenjskem");
    expect(report.changes.some((c) => c.field === "field.notes")).toBe(true);
  });

  it("replaces the main's shared note when the incoming one is chosen", () => {
    const main = dataset(wrap7(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 SNOTE @N5@\n" +
      "0 @N5@ SNOTE Mlinar\n",
    ));
    const compare = dataset(wrap7(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 NOTE Kmet\n",
    ));
    const { records } = mergeDecisions(main, compare, confirmed({ notes: "incoming" }), NO_MATCHES, tr);
    const i1 = serializeGedcom(records).split("0 @N5@")[0];
    expect(i1).toContain("1 NOTE Kmet");
    expect(i1).not.toContain("1 SNOTE @N5@");
  });
});
