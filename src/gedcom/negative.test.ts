import { describe, expect, it } from "vitest";
import { buildDataset } from "./builder";
import { parseGedcom } from "./parser";
import { serializeDataset, serializeGedcom } from "./serialize";
import { addNegativeAssertion, contradicts, removeNegativeAssertion } from "./negative";
import { migrateVersion } from "../normalize/migrate";
import { validateDataset } from "../tools/validate";
import { mergeDecisions } from "../merge/merge";
import { individualFieldRows } from "../review/fields";
import { decisionKey, type CandidateDecision } from "../review/types";

const tr = (key: string) => key;

function load(version: string, body: string) {
  const text = `0 HEAD\n1 GEDC\n2 VERS ${version}\n${body}0 TRLR\n`;
  return { text, ds: buildDataset(parseGedcom(new TextEncoder().encode(text).buffer)) };
}

describe("NO (negative assertions)", () => {
  it("reads NO on a person and a family, with its period and note", () => {
    const { ds } = load(
      "7.0",
      "0 @I1@ INDI\n1 NO CHR\n2 DATE FROM 1700 TO 1720\n2 NOTE Parish books checked\n1 FAMS @F1@\n" +
        "0 @F1@ FAM\n1 HUSB @I1@\n1 NO MARR\n",
    );
    const [a] = ds.individuals.get("@I1@")!.noEvents!;
    expect(a.tag).toBe("CHR");
    expect(a.date?.year).toBe(1700);
    expect(a.note).toBe("Parish books checked");
    expect(ds.families.get("@F1@")!.noEvents!.map((n) => n.tag)).toEqual(["MARR"]);
    // Not an event, so no event row for it.
    expect(ds.individuals.get("@I1@")!.events).toEqual([]);
  });

  it("reads the 5.5.1 stand-in _NO alike", () => {
    const { ds } = load("5.5.1", "0 @F1@ FAM\n1 _NO MARR\n");
    expect(ds.families.get("@F1@")!.noEvents!.map((n) => n.tag)).toEqual(["MARR"]);
  });

  it("saves an untouched file byte for byte", () => {
    const { text, ds } = load("7.0", "0 @I1@ INDI\n1 NAME Ana /Novak/\n1 NO MARR\n2 DATE BEF 1900\n2 SOUR @S1@\n0 @S1@ SOUR\n1 TITL Book\n");
    expect(serializeDataset(ds).replace(/\r\n/g, "\n")).toBe(text);
  });

  it("adds in the file's own spelling, beside the events, and removes", () => {
    const { ds } = load("7.0", "0 @I1@ INDI\n1 NAME Ana /Novak/\n1 BIRT\n2 DATE 1850\n1 FAMC @F1@\n1 NOTE x\n");
    const raw = ds.individuals.get("@I1@")!.raw;
    addNegativeAssertion(raw, "MARR", "7.0");
    addNegativeAssertion(raw, "MARR", "7.0"); // already stated — no second line
    expect(raw.children.map((c) => c.tag)).toEqual(["NAME", "BIRT", "NO", "FAMC", "NOTE"]);
    removeNegativeAssertion(raw, "MARR");
    expect(raw.children.map((c) => c.tag)).toEqual(["NAME", "BIRT", "FAMC", "NOTE"]);

    const { ds: ds5 } = load("5.5.1", "0 @F1@ FAM\n");
    const fam = ds5.families.get("@F1@")!.raw;
    addNegativeAssertion(fam, "MARR", "5.5.1");
    expect(serializeGedcom([fam])).toContain("1 _NO MARR");
  });

  it("round-trips through the 5.5.1 ⇄ 7.0 migration", () => {
    const { ds } = load("7.0", "0 @I1@ INDI\n1 NO MARR\n2 DATE BEF 1900\n");
    migrateVersion(ds.records, "7.0", "5.5.1", () => {});
    expect(serializeGedcom(ds.records)).toContain("1 _NO MARR\n2 DATE BEF 1900");
    migrateVersion(ds.records, "5.5.1", "7.0", () => {});
    expect(serializeGedcom(ds.records)).toContain("1 NO MARR\n2 DATE BEF 1900");
  });

  it("is contradicted only by the same event inside its period", () => {
    const { ds } = load(
      "7.0",
      "0 @I1@ INDI\n1 NO CHR\n2 DATE FROM 1700 TO 1720\n1 CHR\n2 DATE 1750\n" +
        "0 @I2@ INDI\n1 NO CHR\n1 CHR\n" +
        "0 @F1@ FAM\n1 HUSB @I1@\n1 NO MARR\n1 MARR\n2 DATE 1745\n",
    );
    const [a1] = ds.individuals.get("@I1@")!.noEvents!;
    expect(contradicts(a1, ds.individuals.get("@I1@")!.events[0])).toBe(false);
    const report = validateDataset(ds, 2026);
    const found = report.issues.filter((i) => i.category === "noEventConflict").map((i) => i.id);
    expect(found.sort()).toEqual(["@F1@", "@I2@"]);
  });

  it("is compared and imported in Merge, never removed from the main", () => {
    const main = load("7.0", "0 @I1@ INDI\n1 NAME Ana /Novak/\n1 NO CHR\n").ds;
    const compare = load("7.0", "0 @P1@ INDI\n1 NAME Ana /Novak/\n1 NO MARR\n2 NOTE Never married\n").ds;
    const rows = individualFieldRows(tr, main.individuals.get("@I1@"), compare.individuals.get("@P1@"));
    const row = rows.find((r) => r.key === "noEvents")!;
    expect(row.main).toBe("event.CHR");
    expect(row.incoming).toBe("event.MARR");

    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: { noEvents: "incoming" } }],
    ]);
    const { records } = mergeDecisions(main, compare, decisions, { individuals: [] }, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 NO CHR\n1 NO MARR\n2 NOTE Never married");
  });
});
