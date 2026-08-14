import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { captureBaseline } from "../gedcom/fingerprint";
import type { Dataset, GedNode } from "../gedcom/types";
import { reportTotals, type ChangeReport } from "../merge/merge";
import { auditAgainstBaseline } from "./auditReport";

const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));

const FILE = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850\n" +
  "0 @I2@ INDI\n1 NAME Ana /Kos/\n" +
  "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n",
);

function emptyReport(): ChangeReport {
  return {
    changes: [],
    deferred: [],
    graftJoins: [],
    recordsChanged: 0,
    newPersons: 0,
    newFamilies: 0,
    recordLabels: {},
    recordKinds: {},
    familySpouses: {},
    customTags: {},
  };
}

function baselineOf(ds: Dataset) {
  return captureBaseline(
    ds,
    (id) => (id === "@I1@" ? "Janez Novak" : "Ana Kos"),
    () => "Janez Novak + Ana Kos",
  );
}

const outgoing = (ds: Dataset): GedNode[] => ds.records;

describe("auditAgainstBaseline", () => {
  it("says nothing when the file goes out as it came in", () => {
    const ds = dataset(FILE);
    const report = emptyReport();
    auditAgainstBaseline(outgoing(ds), baselineOf(ds), report);
    expect(report.changes).toEqual([]);
  });

  // The case that made a save delete a thousand people in silence: the records
  // are gone from the output and change tracking never heard about it.
  it("reports a record the save will not write, by the name it had", () => {
    const ds = dataset(FILE);
    const baseline = baselineOf(ds);
    const report = emptyReport();
    const records = outgoing(ds).filter((r) => r.xref !== "@I2@");

    auditAgainstBaseline(records, baseline, report);

    const removed = report.changes.filter((c) => c.removedRecord);
    expect(removed.map((c) => c.recordId)).toEqual(["@I2@"]);
    expect(report.recordLabels["@I2@"]).toBe("Ana Kos");
    expect(report.recordKinds["@I2@"]).toBe("individual");
    expect(reportTotals(report).removedRecords).toBe(1);
  });

  it("reports a record that leaves changed with nothing said about it", () => {
    const ds = dataset(FILE);
    const baseline = baselineOf(ds);
    const report = emptyReport();
    ds.records.find((r) => r.xref === "@I1@")!.children.push({ level: 1, tag: "SEX", value: "M", children: [] });

    auditAgainstBaseline(outgoing(ds), baseline, report);

    expect(report.changes.map((c) => [c.recordId, c.undescribed])).toEqual([["@I1@", true]]);
    expect(reportTotals(report).undescribedRecords).toBe(1);
  });

  it("leaves a record the report already itemizes alone", () => {
    const ds = dataset(FILE);
    const baseline = baselineOf(ds);
    const report = emptyReport();
    report.changes.push({ recordId: "@I1@", field: "Birth", from: "1850", to: "1851", action: "incoming" });
    report.recordKinds["@I1@"] = "individual";
    ds.records.find((r) => r.xref === "@I1@")!.children[1].children[0].value = "1851";

    auditAgainstBaseline(outgoing(ds), baseline, report);

    expect(report.changes).toHaveLength(1);
    expect(reportTotals(report).undescribedRecords).toBe(0);
  });

  // A deleted person is named all over the report — by the relatives they were
  // unlinked from. That reads as a link change; only this says they are gone.
  it("marks the removal of a record the report merely mentions", () => {
    const ds = dataset(FILE);
    const baseline = baselineOf(ds);
    const report = emptyReport();
    report.changes.push({ recordId: "@I2@", field: "Spouse in", from: "Janez Novak + Ana Kos", to: "", action: "incoming" });
    report.recordKinds["@I2@"] = "individual";

    auditAgainstBaseline(outgoing(ds).filter((r) => r.xref !== "@I2@"), baseline, report);

    expect(report.changes.filter((c) => c.removedRecord && c.recordId === "@I2@")).toHaveLength(1);
    // It was described, so it is not counted among the records with no detail.
    expect(reportTotals(report).undescribedRecords).toBe(0);
  });

  it("reports a record that arrives from nowhere", () => {
    const ds = dataset(FILE);
    const baseline = baselineOf(ds);
    const report = emptyReport();
    const records = [...outgoing(ds), { level: 0, xref: "@I9@", tag: "INDI", children: [] }];

    auditAgainstBaseline(records, baseline, report);

    expect(report.changes.map((c) => [c.recordId, c.newRecord])).toEqual([["@I9@", true]]);
    expect(report.newPersons).toBe(1);
    expect(reportTotals(report).newRecords).toBe(1);
  });

  // Without a baseline there is nothing to audit against, and treating every
  // record as new would bury a real report in noise.
  it("does nothing without a baseline", () => {
    const ds = dataset(FILE);
    const report = emptyReport();
    auditAgainstBaseline(outgoing(ds), new Map(), report);
    expect(report.changes).toEqual([]);
  });
});
