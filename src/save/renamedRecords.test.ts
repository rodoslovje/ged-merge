import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { captureBaseline } from "../gedcom/fingerprint";
import { parseGedcom } from "../gedcom/parser";
import { reportTotals } from "../merge/merge";
import { renameXref } from "../tools/recordRewrite";
import { buildSavePreview, type SavePreviewInput } from "./buildSavePreview";
import { diffRecord } from "./recordDiff";

const FILE =
  "0 HEAD\n1 GEDC\n2 VERS 7.0\n" +
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850\n2 SOUR @S_VojMKK3@\n" +
  "0 @S_VojMKK3@ SOUR\n1 TITL Krstna knjiga\n" +
  "0 @S2@ SOUR\n1 TITL Poročna knjiga\n" +
  "0 TRLR\n";

function dataset() {
  return buildDataset(parseGedcom(new TextEncoder().encode(FILE).buffer));
}

/** The preview of a session whose only act was the rename of `@S_VojMKK3@`,
 *  with the tracking state its patches leave behind. */
function previewAfterRename(edit?: (main: ReturnType<typeof dataset>) => void) {
  const main = dataset();
  const baseline = captureBaseline(main, () => undefined, () => undefined);
  const patches = renameXref(main, "@S_VojMKK3@", true);
  edit?.(main);
  const input: SavePreviewInput = {
    main,
    mainFileName: "rodovnik.ged",
    baseline,
    compare: undefined,
    decisions: new Map(),
    matches: null,
    importRequests: [],
    confirmedCount: 0,
    importCount: 0,
    changedPersonIds: new Set(patches.filter((p) => p.type === "individual").map((p) => p.id)),
    changedFamilyIds: new Set(),
    changedRecordIds: new Set(patches.filter((p) => p.type === "record").map((p) => p.id)),
    loadedPersonIds: new Set(["@I1@"]),
    loadedFamilyIds: new Set(),
    personSnapshots: new Map(patches.filter((p) => p.type === "individual" && p.before).map((p) => [p.id, p.before!])),
    familySnapshots: new Map(),
    recordSnapshots: new Map(patches.filter((p) => p.type === "record" && p.before).map((p) => [p.id, { value: p.before! }])),
    isSortEligible: () => false,
    isSubstantive: () => true,
    now: new Date("2026-11-27T10:00:00Z"),
    t: (key: string) => key,
  };
  return buildSavePreview(input)!;
}

describe("a renamed record in the save preview", () => {
  it("is one edited record with a Record ID row, not a removed and a new one", () => {
    const preview = previewAfterRename();
    const { report } = preview;
    expect(report.changes.some((c) => c.recordId === "@S_VojMKK3@")).toBe(false);
    expect(report.recordLabels["@S_VojMKK3@"]).toBeUndefined();
    expect(report.changes.filter((c) => c.recordId === "@S_VOJMKK3@")).toEqual([
      { recordId: "@S_VOJMKK3@", field: "", from: "", to: "", action: "incoming" },
      { recordId: "@S_VOJMKK3@", field: "preview.field.recordId", from: "S_VojMKK3", to: "S_VOJMKK3", action: "incoming" },
    ]);
    const totals = reportTotals(report);
    expect(totals.newRecords).toBe(0);
    expect(totals.removedRecords).toBe(0);
    // The source and the person citing it.
    expect(totals.recordsChanged).toBe(2);
  });

  it("diffs as the record line alone", () => {
    const preview = previewAfterRename();
    const after = preview.records.find((r) => r.xref === "@S_VOJMKK3@");
    const diff = diffRecord(preview.beforeRecords.get("@S_VOJMKK3@"), after, {});
    expect(diff.lines.filter((l) => l.kind !== "same")).toEqual([
      { kind: "del", text: "0 @S_VojMKK3@ SOUR" },
      { kind: "add", text: "0 @S_VOJMKK3@ SOUR" },
    ]);
  });

  it("stays removed and new when the record was also edited", () => {
    const preview = previewAfterRename((main) => {
      main.records.find((r) => r.xref === "@S_VOJMKK3@")!.children[0].value = "Krstna knjiga III";
    });
    const totals = reportTotals(preview.report);
    expect(totals.newRecords).toBe(1);
    expect(totals.removedRecords).toBe(1);
  });
});
