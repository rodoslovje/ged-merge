import { describe, expect, it } from "vitest";
import { buildDataset } from "./builder";
import { parseGedcom } from "./parser";
import type { ChangeReport } from "../merge/merge";
import { enrichEditReport } from "./editReport";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const tr = (key: string) => key;
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

function baseReport(id: string): ChangeReport {
  return {
    changes: [],
    deferred: [],
    recordsChanged: 1,
    newPersons: 0,
    newFamilies: 0,
    recordLabels: { [id]: id },
    recordKinds: { [id]: "individual" },
    familySpouses: {},
    customTags: {},
  };
}

describe("enrichEditReport — event diffing", () => {
  it("marks an edited event's changed sub-field, leaving the rest in their normal color, with no new-event icon", () => {
    const before = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 RESI\n2 PLAC Kranj\n2 ADDR Main 1\n"),
    );
    const after = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 RESI\n2 DATE 1934\n2 PLAC Kranj\n2 ADDR Main 1\n"),
    );
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const resi = report.changes.filter((c) => c.group === "event.RESI");
    expect(resi).toHaveLength(1);
    expect(resi[0].segments).toEqual([
      { text: "1934", state: "changed" },
      { text: "Kranj", state: "same" },
      { text: "Main 1", state: "same" },
    ]);
  });

  it("renders a brand-new event as a plain addition (no segments)", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 OCCU Engineer\n2 DATE 1960\n"));
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const occu = report.changes.filter((c) => c.group === "event.OCCU");
    expect(occu).toHaveLength(1);
    expect(occu[0].segments).toBeUndefined();
    expect(occu[0].action).toBe("both");
    expect(occu[0].to).toBe("Engineer · 1960");
  });

  it("renders a fully removed event as a plain removal (no segments)", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 OCCU Engineer\n2 DATE 1960\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n"));
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const occu = report.changes.filter((c) => c.group === "event.OCCU");
    expect(occu).toHaveLength(1);
    expect(occu[0].segments).toBeUndefined();
    expect(occu[0].action).toBe("incoming");
    expect(occu[0].from).toBe("Engineer · 1960");
    expect(occu[0].to).toBe("");
  });

  it("does not pair two unrelated events of the same tag (no shared sub-field)", () => {
    // Different date AND place, so the events share no sub-field and aren't a
    // place-only edit — they must stay separate (a removal plus an addition).
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 RESI\n2 DATE 1900\n2 PLAC Kranj\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 RESI\n2 DATE 2000\n2 PLAC Maribor\n"));
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const resi = report.changes.filter((c) => c.group === "event.RESI");
    expect(resi).toHaveLength(2);
    expect(resi.every((c) => !c.segments)).toBe(true);
  });
});
