import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { decisionKey, type CandidateDecision } from "../review/types";
import { individualFieldRows } from "../review/fields";
import { mergeDecisions, INDI_HANDLED } from "./merge";
import { snapshotMainValues } from "./applyFields";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const tr = (key: string) => key;
const NO_MATCHES = { individuals: [], families: [] };

const COUPLE = (marr: string) => wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
  "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 FAMS @F1@\n" +
  `0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 MARR\n2 DATE 1875\n${marr}`,
);
const COMPARE = wrap(
  "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G9@\n" +
  "0 @P2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 FAMS @G9@\n" +
  "0 @G9@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 MARR\n2 DATE 1875\n2 PLAC Kranj\n",
);

/** A confirmed I1↔P1 decision stamped against `atConfirm`, as App does. */
function confirmedAgainst(atConfirm: string): Map<string, CandidateDecision> {
  const main = dataset(atConfirm);
  const compare = dataset(COMPARE);
  const rows = individualFieldRows(tr, main.individuals.get("@I1@")!, compare.individuals.get("@P1@")!, main, compare);
  return new Map([[
    decisionKey("individual", "@I1@", "@P1@"),
    { status: "confirmed", fields: { "fam.@G9@.MARR.place": "incoming" }, mainFields: snapshotMainValues(rows, INDI_HANDLED) },
  ]]);
}

describe("an edit made after confirming wins on family rows too", () => {
  it("records the family event rows in the confirm-time snapshot", () => {
    const main = dataset(COUPLE("2 PLAC Bled\n"));
    const compare = dataset(COMPARE);
    const rows = individualFieldRows(tr, main.individuals.get("@I1@")!, compare.individuals.get("@P1@")!, main, compare);
    expect(snapshotMainValues(rows, INDI_HANDLED)["fam.@G9@.MARR.place"]).toBe("Bled");
  });

  it("keeps a marriage place typed in Edit after the match was confirmed", () => {
    // Confirmed while the main family had no marriage place; the user then
    // typed "Ljubljana" in Edit.
    const decisions = confirmedAgainst(COUPLE(""));
    const { records, report } = mergeDecisions(dataset(COUPLE("2 PLAC Ljubljana\n")), dataset(COMPARE), decisions, NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 PLAC Ljubljana");
    expect(out).not.toContain("Kranj");
    expect(report.deferred.some((d) => d.reason === "merge.reason.editedAfterConfirm")).toBe(true);
  });

  it("still takes the incoming marriage place when nothing was edited since", () => {
    const decisions = confirmedAgainst(COUPLE(""));
    const { records, report } = mergeDecisions(dataset(COUPLE("")), dataset(COMPARE), decisions, NO_MATCHES, tr);
    expect(serializeGedcom(records)).toContain("2 PLAC Kranj");
    expect(report.deferred).toEqual([]);
  });
});
