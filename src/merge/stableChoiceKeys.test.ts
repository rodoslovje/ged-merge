import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { decisionKey, type CandidateDecision } from "../review/types";
import { individualFieldRows } from "../review/fields";
import type { Dataset } from "../gedcom/types";
import { mergeDecisions, INDI_HANDLED } from "./merge";
import { stampConfirmedDecision } from "./applyFields";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const tr = (key: string) => key;
const NO_MATCHES = { individuals: [], families: [] };

const MAIN_ONE = wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 OCCU kmet\n");
const MAIN_TWO = wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 OCCU kmet\n1 OCCU mlinar\n");
const COMPARE = wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 OCCU kmet\n2 PLAC Kranj\n");

function rowsOf(main: Dataset, compare: Dataset) {
  return individualFieldRows(tr, main.individuals.get("@I1@")!, compare.individuals.get("@P1@")!, main, compare);
}

/** Confirm I1↔P1 with `fields`, stamped against `atConfirm` as App does. */
function confirmedAgainst(atConfirm: Dataset, compare: Dataset, fields: CandidateDecision["fields"]): Map<string, CandidateDecision> {
  const next: CandidateDecision = { status: "confirmed", fields };
  return new Map([[decisionKey("individual", "@I1@", "@P1@"), stampConfirmedDecision(next, undefined, rowsOf(atConfirm, compare), INDI_HANDLED)]]);
}

describe("a field choice follows its incoming event when Edit changes the event count", () => {
  it("still declines the incoming place after the main gains a second occupation", () => {
    const compare = dataset(COMPARE);
    const main = dataset(MAIN_ONE);
    expect(rowsOf(main, compare).some((r) => r.key === "OCCU.place")).toBe(true);
    const decisions = confirmedAgainst(main, compare, { "OCCU.place": "main" });
    // A second OCCU added in Edit re-keys the paired rows to "OCCU.<n>.place".
    const edited = dataset(MAIN_TWO);
    expect(rowsOf(edited, compare).some((r) => r.key === "OCCU.place")).toBe(false);
    const { records } = mergeDecisions(edited, compare, decisions, NO_MATCHES, tr);
    expect(serializeGedcom(records)).not.toContain("Kranj");
  });

  it("re-keys the stored choices to the rows on the next update", () => {
    const compare = dataset(COMPARE);
    const decisions = confirmedAgainst(dataset(MAIN_ONE), compare, { "OCCU.place": "main" });
    const prev = [...decisions.values()][0];
    const edited = dataset(MAIN_TWO);
    const rows = rowsOf(edited, compare);
    const placeRow = rows.find((r) => r.key.startsWith("OCCU.") && r.key.endsWith(".place") && r.eventCompareIdx === 0)!;
    // An unrelated toggle restamps the decision against the edited file.
    const next = stampConfirmedDecision({ ...prev, fields: { ...prev.fields, given: "main" } }, prev, rows, INDI_HANDLED);
    expect(next.fields[placeRow.key]).toBe("main");
    expect(next.fields["OCCU.place"]).toBeUndefined();
  });

  it("leaves decisions without anchors (older sessions) as they were", () => {
    const compare = dataset(COMPARE);
    const decisions = new Map<string, CandidateDecision>([[
      decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: { "OCCU.place": "main" } },
    ]]);
    const { records } = mergeDecisions(dataset(MAIN_ONE), compare, decisions, NO_MATCHES, tr);
    expect(serializeGedcom(records)).not.toContain("Kranj");
  });
});
