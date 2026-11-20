import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { individualFieldRows } from "../review/fields";
import { decisionKey, type CandidateDecision, type FieldChoice } from "../review/types";
import { validateConformance } from "../tools/conformance/conformance";
import { mergeDecisions } from "./merge";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const tr = (key: string) => key;
const NO_MATCHES = { individuals: [], families: [] };

describe("a shared record imported under an id the main's version does not take", () => {
  it("gets a conforming id, and its citation follows", () => {
    const main = dataset("0 HEAD\n1 GEDC\n2 VERS 7.0\n0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850\n0 TRLR\n");
    const compare = dataset(
      "0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n" +
        "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850\n2 SOUR @src-krstna.knjiga@\n3 PAGE 12\n" +
        "0 @src-krstna.knjiga@ SOUR\n1 TITL Krstna knjiga Kranj\n0 TRLR\n",
    );
    const rows = individualFieldRows(tr, main.individuals.get("@I1@")!, compare.individuals.get("@P1@")!, main, compare);
    const fields: Record<string, FieldChoice> = {};
    for (const row of rows) fields[row.key] = "incoming";
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields }],
    ]);
    const { records } = mergeDecisions(main, compare, decisions, NO_MATCHES, tr);

    const source = records.find((r) => r.tag === "SOUR")!;
    expect(source.xref).toBe("@SRC_KRSTNA_KNJIGA@");
    const birth = records.find((r) => r.xref === "@I1@")!.children.find((c) => c.tag === "BIRT")!;
    expect(birth.children.find((c) => c.tag === "SOUR")?.value).toBe("@SRC_KRSTNA_KNJIGA@");
    expect(validateConformance({ records }).filter((i) => i.category === "xrefShape")).toEqual([]);
  });
});
