import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { decisionKey, type CandidateDecision } from "../review/types";
import { mergeDecisions } from "./merge";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const tr = (key: string) => key;
const NO_MATCHES = { individuals: [], families: [] };

// The main cites @S9@, a source record it does not have; the incoming file has
// an unrelated @S9@ of its own.
const MAIN = wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 SOUR @S9@\n");
const COMPARE = wrap(
  "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n" +
  "1 DEAT\n2 DATE 1900\n2 SOUR @S9@\n" +
  "0 @S9@ SOUR\n1 TITL Mrliška knjiga Kranj\n",
);
const confirmed = (fields: CandidateDecision["fields"] = {}) => new Map<string, CandidateDecision>([
  [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields }],
]);

describe("a main pointer to a missing record is never bound to an incoming record", () => {
  it("does not import the incoming @S9@ for the main's dangling citation", () => {
    const { records } = mergeDecisions(dataset(MAIN), dataset(COMPARE), confirmed({ "DEAT.sources": "main" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 SOUR @S9@");
    expect(out).not.toContain("Mrliška knjiga");
  });

  it("imports the incoming source under its own xref when the merge cites it", () => {
    const { records } = mergeDecisions(dataset(MAIN), dataset(COMPARE), confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    const imported = /0 (@[^@]+@) SOUR\n1 TITL Mrliška knjiga Kranj/.exec(out);
    expect(imported).not.toBeNull();
    expect(imported![1]).not.toBe("@S9@");
    // The main's birth still cites the record it named, not the import.
    expect(out).toContain("1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n2 SOUR @S9@");
  });
});
