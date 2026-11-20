import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { individualFieldRows } from "../review/fields";
import { decisionKey, type CandidateDecision, type FieldChoice } from "../review/types";
import { mergeDecisions } from "./merge";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const tr = (key: string) => key;
const NO_MATCHES = { individuals: [], families: [] };

describe("taking a partner into a slot the main already fills", () => {
  // Both files have Janez and his one marriage. The review reads his wife,
  // spelled Ana Kos here and Anna Koss there, as a conflict on one row; the
  // matcher has paired nobody with her, and the user takes the incoming side.
  const main = dataset(wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @F1@\n" +
      "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1830\n1 FAMS @F1@\n" +
      "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 MARR\n2 DATE 4 FEB 1876\n",
  ));
  const compare = dataset(wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @G1@\n" +
      "0 @P2@ INDI\n1 NAME Anna /Koss/\n1 SEX F\n1 BIRT\n2 DATE 1830\n1 FAMS @G1@\n" +
      "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 MARR\n2 DATE 4 FEB 1876\n",
  ));
  const rows = individualFieldRows(tr, main.individuals.get("@I1@")!, compare.individuals.get("@P1@")!, main, compare);
  const fields: Record<string, FieldChoice> = {};
  for (const row of rows) fields[row.key] = "incoming";
  const decisions = new Map<string, CandidateDecision>([
    [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields }],
  ]);
  const { records } = mergeDecisions(main, compare, decisions, NO_MATCHES, tr);
  const people = records.filter((r) => r.tag === "INDI");

  it("leaves nobody in the file who belongs to no family", () => {
    const unlinked = people.filter((p) => !p.children.some((c) => c.tag === "FAMS" || c.tag === "FAMC"));
    expect(unlinked.map((p) => p.children.find((c) => c.tag === "NAME")?.value)).toEqual([]);
  });

  it("keeps the main's wife where she was", () => {
    const families = records.filter((r) => r.tag === "FAM");
    const f1 = families.find((r) => r.xref === "@F1@")!;
    expect(f1.children.find((c) => c.tag === "WIFE")?.value).toBe("@I2@");
  });
});
