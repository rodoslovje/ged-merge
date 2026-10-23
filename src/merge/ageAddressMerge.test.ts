import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { decisionKey, type CandidateDecision } from "../review/types";
import { individualFieldRows } from "../review/fields";
import { mergeDecisions } from "./merge";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const tr = (key: string) => key;
const NO_MATCHES = { individuals: [], families: [] };

const person = (id: string, fam: string, events: string) =>
  `0 ${id} INDI\n1 NAME Janez /Novak/\n1 SEX M\n${events}1 FAMS ${fam}\n`;
const wife = (id: string, fam: string) => `0 ${id} INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 FAMS ${fam}\n`;
const family = (id: string, h: string, w: string, marr: string) =>
  `0 ${id} FAM\n1 HUSB ${h}\n1 WIFE ${w}\n1 MARR\n2 DATE 1875\n${marr}`;

const MAIN = wrap(
  person("@I1@", "@F1@", "1 DEAT\n2 DATE 1890\n1 RESI\n2 ADDR Dunajska 5\n") +
    wife("@I2@", "@F1@") +
    family("@F1@", "@I1@", "@I2@", ""),
);
const COMPARE = wrap(
  person("@P1@", "@G1@", "1 DEAT\n2 DATE 1890\n2 AGE 62y\n1 RESI\n2 ADDR Dunajska 5\n3 CITY Ljubljana\n3 POST 1000\n2 PHON 01 234\n") +
    wife("@P2@", "@G1@") +
    family("@G1@", "@P1@", "@P2@", "2 HUSB\n3 AGE 27y\n2 WIFE\n3 AGE 19y\n"),
);

describe("merge: stated ages and structured addresses", () => {
  const main = dataset(MAIN);
  const compare = dataset(COMPARE);
  const rows = individualFieldRows(tr, main.individuals.get("@I1@")!, compare.individuals.get("@P1@")!, main, compare);
  const row = (key: string) => rows.find((r) => r.key === key);

  it("offers the incoming age, each spouse's age, and an address that differs only below its line", () => {
    expect(row("DEAT.age")).toMatchObject({ main: "", incoming: "62y" });
    expect(row("fam.@G1@.MARR.husbage")).toMatchObject({ main: "", incoming: "27y" });
    expect(row("fam.@G1@.MARR.wifeage")).toMatchObject({ main: "", incoming: "19y" });
    expect(row("RESI.addr")).toMatchObject({ main: "Dunajska 5", incoming: "Dunajska 5, Ljubljana, 1000, 01 234" });
    expect(row("RESI.addr")?.state).not.toBe("agree");
  });

  it("writes them into the main file when taken", () => {
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: { "RESI.addr": "incoming" } }],
    ]);
    const { records } = mergeDecisions(main, compare, decisions, NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 DEAT\n2 DATE 1890\n2 AGE 62y\n");
    expect(out).toContain("1 RESI\n2 ADDR Dunajska 5\n3 CITY Ljubljana\n3 POST 1000\n2 PHON 01 234\n");
    expect(out).toContain("1 MARR\n2 HUSB\n3 AGE 27y\n2 WIFE\n3 AGE 19y\n2 DATE 1875\n");
    // The family's own spouse pointers are untouched.
    expect(out).toContain("1 HUSB @I1@\n1 WIFE @I2@\n");
  });
});
