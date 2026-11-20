import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { individualFieldRows } from "../review/fields";
import { decisionKey, type CandidateDecision, type FieldChoice } from "../review/types";
import { mergeDecisions } from "./merge";

/**
 * MyHeritage writes its change stamp as an event line — `1 EVEN <time>` with
 * `2 TYPE _UPD` — that the typed events leave out. The review counts events
 * without it; the merge counted the raw lines with it, so every `EVEN` after
 * the stamp was addressed one line too early.
 */

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const tr = (key: string) => key;
const NO_MATCHES = { individuals: [], families: [] };
const STAMP = "1 EVEN 31 JAN 2020 13:12:03 GMT -0500\n2 TYPE _UPD\n";

/** Confirm @I1@ ← @P1@, taking the incoming side of every row. */
function merge(mainBody: string, compareBody: string): string {
  const main = dataset(wrap(mainBody));
  const compare = dataset(wrap(compareBody));
  const rows = individualFieldRows(tr, main.individuals.get("@I1@")!, compare.individuals.get("@P1@")!, main, compare);
  const fields: Record<string, FieldChoice> = {};
  for (const row of rows) fields[row.key] = "incoming";
  const decisions = new Map<string, CandidateDecision>([
    [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields }],
  ]);
  return serializeGedcom(mergeDecisions(main, compare, decisions, NO_MATCHES, tr).records);
}

describe("merging beside a MyHeritage change stamp", () => {
  it("writes an incoming place onto the main's event, not under its stamp", () => {
    const out = merge(
      `0 @I1@ INDI\n1 NAME Janez /Novak/\n${STAMP}1 EVEN Award\n2 TYPE Award\n2 DATE 1900\n`,
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 EVEN Award\n2 TYPE Award\n2 DATE 1900\n2 PLAC Kranj\n",
    );
    expect(out).toContain("1 EVEN Award\n2 TYPE Award\n2 DATE 1900\n2 PLAC Kranj\n");
    expect(out).toContain(STAMP);
    expect(out).not.toContain(`${STAMP.trimEnd()}\n2 PLAC`);
  });

  it("imports the incoming record's real event, not its stamp", () => {
    const out = merge(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n",
      `0 @P1@ INDI\n1 NAME Janez /Novak/\n${STAMP}1 EVEN Award\n2 TYPE Award\n2 DATE 1900\n2 PLAC Kranj\n`,
    );
    expect(out).toContain("1 EVEN Award\n2 TYPE Award\n2 DATE 1900\n2 PLAC Kranj\n");
    expect(out).not.toContain("_UPD");
  });
});
