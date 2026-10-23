import { describe, expect, it } from "vitest";
import { buildDataset } from "./builder";
import { parseGedcom } from "./parser";
import { serializeDataset, serializeGedcom } from "./serialize";
import { setName } from "./edit";
import { migrateVersion } from "../normalize/migrate";
import { nameSearchText } from "../match/relatives";
import { mergeDecisions } from "../merge/merge";
import { individualFieldRows } from "../review/fields";
import { decisionKey, type CandidateDecision } from "../review/types";

const tr = (key: string) => key;

function load(version: string, body: string) {
  const text = `0 HEAD\n1 GEDC\n2 VERS ${version}\n${body}0 TRLR\n`;
  return { text, ds: buildDataset(parseGedcom(new TextEncoder().encode(text).buffer)) };
}

const BODY =
  "0 @I1@ INDI\n1 NAME Ivan /Novak/\n2 TRAN Иван /Новак/\n3 LANG ru\n" +
  "1 BIRT\n2 PLAC Ljubljana\n3 TRAN Laibach\n4 LANG de\n" +
  "1 NOTE Rojen doma\n2 TRAN Born at home\n3 LANG en\n";

describe("TRAN (translations)", () => {
  it("reads translations of a name, a place and a note", () => {
    const { ds } = load("7.0", BODY);
    const p = ds.individuals.get("@I1@")!;
    expect(p.names[0].translations).toEqual([{ full: "Иван Новак", given: "Иван", surname: "Новак", lang: "ru" }]);
    expect(p.events[0].place?.translations).toEqual([{ value: "Laibach", lang: "de" }]);
    expect(p.noteRefs?.[0].translations).toEqual([{ value: "Born at home", lang: "en" }]);
  });

  it("saves an untouched file byte for byte, and keeps translations through a name edit", () => {
    const { text, ds } = load("7.0", BODY);
    expect(serializeDataset(ds).replace(/\r\n/g, "\n")).toBe(text);
    const p = ds.individuals.get("@I1@")!;
    setName(p, { given: "Janez", surname: "Novak" });
    expect(serializeGedcom([p.raw])).toContain("1 NAME Janez /Novak/\n2 TRAN Иван /Новак/\n3 LANG ru");
  });

  it("lets search find the person by a translated name", () => {
    const { ds } = load("7.0", BODY);
    expect(nameSearchText(ds.individuals.get("@I1@")!)).toContain("иван новак");
  });

  it("round-trips through the 5.5.1 ⇄ 7.0 migration, the note's translation included", () => {
    const { ds } = load("7.0", BODY);
    migrateVersion(ds.records, "7.0", "5.5.1", () => {});
    const down = serializeGedcom(ds.records);
    expect(down).toContain("2 _TRAN Born at home");
    migrateVersion(ds.records, "5.5.1", "7.0", () => {});
    const up = serializeGedcom(ds.records);
    expect(up).toContain("1 NOTE Rojen doma\n2 TRAN Born at home\n3 LANG en");
    expect(up).toContain("2 TRAN Иван /Новак/\n3 LANG");
  });

  it("is compared and imported in Merge", () => {
    const main = load("7.0", "0 @I1@ INDI\n1 NAME Ivan /Novak/\n").ds;
    const compare = load("7.0", "0 @P1@ INDI\n1 NAME Ivan /Novak/\n2 TRAN Иван /Новак/\n3 LANG ru\n").ds;
    const row = individualFieldRows(tr, main.individuals.get("@I1@"), compare.individuals.get("@P1@")).find((r) => r.key === "nameTranslations")!;
    expect(row.incoming).toBe("Иван Новак (ru)");
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
    ]);
    const out = serializeGedcom(mergeDecisions(main, compare, decisions, { individuals: [] }, tr).records);
    expect(out).toContain("1 NAME Ivan /Novak/\n2 TRAN Иван /Новак/\n3 LANG ru");
  });
});
