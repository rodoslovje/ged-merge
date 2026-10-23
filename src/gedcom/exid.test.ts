import { describe, expect, it } from "vitest";
import { buildDataset } from "./builder";
import { parseGedcom } from "./parser";
import { serializeDataset, serializeGedcom } from "./serialize";
import { preferredFsIdTag, setFsIds } from "./edit";
import { exidIdentityKey, exidTypeLabel } from "./exid";
import { migrateVersion } from "../normalize/migrate";
import { matchDatasets } from "../match/engine";
import { mergeDecisions } from "../merge/merge";
import { individualFieldRows } from "../review/fields";
import { decisionKey, type CandidateDecision } from "../review/types";

const tr = (key: string) => key;
const FS = "https://www.familysearch.org/tree/person/";
const WT = "https://www.wikitree.com/wiki/";

function load(version: string, body: string) {
  const text = `0 HEAD\n1 GEDC\n2 VERS ${version}\n${body}0 TRLR\n`;
  return { text, ds: buildDataset(parseGedcom(new TextEncoder().encode(text).buffer)) };
}

describe("EXID", () => {
  it("reads a FamilySearch EXID as a FamilySearch id, and keeps the others", () => {
    const { ds } = load("7.0", `0 @I1@ INDI\n1 EXID GPZG-CXL\n2 TYPE ${FS}\n1 EXID Novak-12\n2 TYPE ${WT}\n`);
    const p = ds.individuals.get("@I1@")!;
    expect(p.fsids).toEqual(["GPZG-CXL"]);
    expect(p.exids).toEqual([{ id: "Novak-12", type: WT }]);
    // The type URI is a vocabulary term, not a link of the person's.
    expect(p.links).toBeUndefined();
  });

  it("saves an untouched file byte for byte", () => {
    const { text, ds } = load("7.0", `0 @I1@ INDI\n1 NAME Ana /Novak/\n1 EXID Novak-12\n2 TYPE ${WT}\n`);
    expect(serializeDataset(ds).replace(/\r\n/g, "\n")).toBe(text);
  });

  it("writes a new FamilySearch id as an EXID in a 7.0 file", () => {
    const { ds } = load("7.0", "0 @I1@ INDI\n1 NAME Ana /Novak/\n");
    expect(preferredFsIdTag(ds)).toBe("EXID");
    const p = ds.individuals.get("@I1@")!;
    setFsIds(p, ["gpzg-cxl"], "EXID");
    expect(serializeGedcom([p.raw])).toContain(`1 EXID GPZG-CXL\n2 TYPE ${FS}`);
  });

  it("round-trips through the 5.5.1 ⇄ 7.0 migration", () => {
    const { ds } = load("7.0", `0 @I1@ INDI\n1 EXID GPZG-CXL\n2 TYPE ${FS}\n1 EXID Novak-12\n2 TYPE ${WT}\n`);
    migrateVersion(ds.records, "7.0", "5.5.1", () => {});
    const down = serializeGedcom(ds.records);
    expect(down).toContain("1 _FSFTID GPZG-CXL");
    expect(down).toContain(`1 REFN Novak-12\n2 TYPE ${WT}`);
    migrateVersion(ds.records, "5.5.1", "7.0", () => {});
    const up = serializeGedcom(ds.records);
    expect(up).toContain(`1 EXID GPZG-CXL\n2 TYPE ${FS}`);
    expect(up).toContain(`1 EXID Novak-12\n2 TYPE ${WT}`);
  });

  it("pairs records sharing a typed EXID, but never on a file-local one", () => {
    expect(exidIdentityKey({ id: "17", type: "https://gedcom.io/terms/v7/RIN" })).toBeUndefined();
    expect(exidIdentityKey({ id: "Novak-12" })).toBeUndefined();
    expect(exidTypeLabel(WT)).toBe("wikitree.com/wiki");
    const main = load("7.0", `0 @I1@ INDI\n1 NAME Ana /Novak/\n1 EXID Novak-12\n2 TYPE ${WT}\n0 @I2@ INDI\n1 NAME Ana /Novak/\n`).ds;
    const compare = load("7.0", `0 @P9@ INDI\n1 NAME Marija /Kos/\n1 EXID Novak-12\n2 TYPE ${WT}\n`).ds;
    const result = matchDatasets(main, compare);
    const best = result.individuals.find((c) => c.compareId === "@P9@");
    expect(best?.mainId).toBe("@I1@");
  });

  it("is compared and imported in Merge", () => {
    const main = load("7.0", "0 @I1@ INDI\n1 NAME Ana /Novak/\n").ds;
    const compare = load("7.0", `0 @P1@ INDI\n1 NAME Ana /Novak/\n1 EXID Novak-12\n2 TYPE ${WT}\n`).ds;
    const row = individualFieldRows(tr, main.individuals.get("@I1@"), compare.individuals.get("@P1@")).find((r) => r.key === "exid")!;
    expect(row.incoming).toBe("Novak-12 (wikitree.com/wiki)");
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
    ]);
    const out = serializeGedcom(mergeDecisions(main, compare, decisions, { individuals: [] }, tr).records);
    expect(out).toContain(`1 EXID Novak-12\n2 TYPE ${WT}`);
  });
});
