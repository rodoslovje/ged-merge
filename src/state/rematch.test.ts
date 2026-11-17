import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { MatchCandidate } from "../match/types";
import { decisionKey, type CandidateDecision } from "../review/types";
import { rematchedCandidates } from "./rematch";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const people = (...ids: string[]) => dataset(wrap(ids.map((id) => `0 ${id} INDI\n1 NAME X /Y/\n`).join("")));
const pair = (mainId: string, compareId: string, score = 90) => ({ mainId, compareId, score }) as MatchCandidate;
const ids = (list: MatchCandidate[]) => list.map((c) => `${c.mainId}|${c.compareId}`);

describe("rematchedCandidates", () => {
  const main = people("@I1@", "@I2@", "@I3@", "@I9@");
  const compare = people("@P1@", "@P2@", "@P3@");

  it("keeps every decided pair the new scores dropped, and only those", () => {
    const old = [pair("@I1@", "@P1@"), pair("@I2@", "@P2@"), pair("@I3@", "@P3@")];
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
      [decisionKey("individual", "@I2@", "@P2@"), { status: "rejected", fields: {} }],
      [decisionKey("individual", "@I3@", "@P3@"), { status: "undecided", fields: {} }],
    ]);
    const out = rematchedCandidates([pair("@I1@", "@P1@", 95)], old, decisions, main, compare);
    expect(ids(out)).toEqual(["@I1@|@P1@", "@I2@|@P2@"]);
    expect(out[0].score).toBe(95); // the fresh row wins where both have it
  });

  it("does not bring back a decided pair whose person was deleted", () => {
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I7@", "@P1@"), { status: "deferred", fields: {} }],
    ]);
    expect(rematchedCandidates([], [pair("@I7@", "@P1@")], decisions, main, compare)).toEqual([]);
  });

  it("drops the pair of an added person with their own incoming record", () => {
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, added: { "@P2@": "@I9@" } }],
    ]);
    const out = rematchedCandidates([pair("@I1@", "@P1@"), pair("@I9@", "@P2@", 100), pair("@I2@", "@P2@")], [], decisions, main, compare);
    expect(ids(out)).toEqual(["@I1@|@P1@", "@I2@|@P2@"]);
  });
});
