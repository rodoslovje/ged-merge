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

describe("enrichEditReport — source citations", () => {
  it("shows an added record-level SOUR citation by its source title and page", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n"));
    const after = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SOUR @S1@\n2 PAGE 5\n0 @S1@ SOUR\n1 TITL Katarina Abdonec - WW2 - SIstory.si\n"),
    );
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const sources = report.changes.filter((c) => c.field === "field.sources");
    expect(sources).toHaveLength(1);
    expect(sources[0].to).toBe("Katarina Abdonec - WW2 - SIstory.si (5)");
    expect(sources[0].action).toBe("both");
  });

  it("shows a citation added to an event as that event's change", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 DEAT\n2 DATE 1944\n"));
    const after = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 DEAT\n2 DATE 1944\n2 SOUR @S1@\n0 @S1@ SOUR\n1 TITL Katarina Abdonec - WW2 - SIstory.si\n"),
    );
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const deat = report.changes.filter((c) => c.group === "event.DEAT");
    expect(deat).toHaveLength(1);
    expect(deat[0].segments).toEqual([
      { text: "1944", state: "same" },
      { text: "Katarina Abdonec - WW2 - SIstory.si", state: "changed" },
    ]);
  });
});

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

  it("shows a geocode write-back (MAP under an existing PLAC) as the event's changed coordinate", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1901\n2 PLAC Kranj\n"));
    const after = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1901\n2 PLAC Kranj\n3 MAP\n4 LATI N46.2389\n4 LONG E14.3556\n"),
    );
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const birt = report.changes.filter((c) => c.group === "event.BIRT");
    expect(birt).toHaveLength(1);
    expect(birt[0].segments).toEqual([
      { text: "1901", state: "same" },
      { text: "Kranj", state: "same" },
      { text: "46.2389, 14.3556", state: "changed" },
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

describe("enrichEditReport — event tags outside the canonical lists", () => {
  const famReport = (id: string): ChangeReport => ({
    ...baseReport(id),
    recordKinds: { [id]: "family" },
  });

  it("shows a geocode write on a CHRA (adult christening) not in the tag list", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 CHRA\n2 DATE 1920\n2 PLAC Kranj\n"));
    const after = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 CHRA\n2 DATE 1920\n2 PLAC Kranj\n3 MAP\n4 LATI N46.2389\n4 LONG E14.3556\n"),
    );
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const chra = report.changes.filter((c) => c.group === "event.CHRA");
    expect(chra).toHaveLength(1);
    expect(chra[0].segments).toContainEqual({ text: "46.2389, 14.3556", state: "changed" });
  });

  it("shows a place rename on a family MARB (banns) event", () => {
    const before = dataset(
      wrap("0 @F1@ FAM\n1 HUSB @I1@\n1 MARB\n2 DATE 1900\n2 PLAC Krupa 7,Semič,\n0 @I1@ INDI\n1 NAME Janez /Novak/\n1 FAMS @F1@\n"),
    );
    const after = dataset(
      wrap("0 @F1@ FAM\n1 HUSB @I1@\n1 MARB\n2 DATE 1900\n2 PLAC Krupa,Semič,Slovenia\n0 @I1@ INDI\n1 NAME Janez /Novak/\n1 FAMS @F1@\n"),
    );
    const snapshots = new Map([["@F1@", before.families.get("@F1@")!.raw]]);
    const report = enrichEditReport(famReport("@F1@"), after, new Map(), snapshots, tr);

    const marb = report.changes.filter((c) => c.group === "event.MARB");
    expect(marb).toHaveLength(1);
    expect(marb[0].segments).toContainEqual({ text: "Krupa,Semič,Slovenia", state: "changed" });
  });

  it("shows a date change on a vendor event tag with event substructure", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 _KRST\n2 DATE 1901\n2 PLAC Kranj\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 _KRST\n2 DATE 1902\n2 PLAC Kranj\n"));
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const ev = report.changes.filter((c) => c.group === "event._KRST");
    expect(ev).toHaveLength(1);
  });

  it("does not diff structureless value tags (_UID) as events", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 _UID AAAA\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 _UID BBBB\n"));
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    expect(report.changes.filter((c) => c.group === "event._UID")).toHaveLength(0);
  });
});
