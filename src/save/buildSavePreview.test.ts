import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import type { Dataset, GedNode } from "../gedcom/types";
import { decisionKey, type CandidateDecision } from "../review/types";
import { buildSavePreview, type SavePreviewInput } from "./buildSavePreview";
import { cloneNode } from "../gedcom/node";
import { captureBaseline } from "../gedcom/fingerprint";
import { isItemizedChange, reportTotals } from "../merge/merge";

/** The pre-edit baseline of a record that has since been edited. A snapshot
 *  identical to the record means nothing was actually changed, and the report
 *  passes over it — so a test about a *changed* record needs the two to differ. */
function editedFrom(ds: Dataset, id: string): GedNode {
  const raw = cloneNode(ds.individuals.get(id)!.raw);
  raw.children.push({ level: 1, tag: "NOTE", value: "since removed", children: [] });
  return raw;
}

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const tr = (key: string) => key;
const NOW = new Date("2026-07-26T10:00:00Z");

const MAIN = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 DEAT\n2 DATE 1920\n1 BIRT\n2 DATE 1850\n" +
    "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1855\n",
);
const COMPARE = wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n");

const serialize = (ds: Dataset) => serializeGedcom(ds.records, { eol: ds.eol, finalNewline: ds.finalNewline });

/** A no-edits, no-decisions baseline; each test overrides just what it needs. */
function input(main: Dataset, over: Partial<SavePreviewInput> = {}): SavePreviewInput {
  return {
    main,
    mainFileName: "rodovnik.ged",
    // The file as it stands is what a save is audited against; a test that
    // wants the audit to bite passes a baseline of its own.
    baseline: captureBaseline(main, () => undefined, () => undefined),
    compare: undefined,
    decisions: new Map(),
    matches: null,
    importRequests: [],
    confirmedCount: 0,
    importCount: 0,
    changedPersonIds: new Set(),
    changedFamilyIds: new Set(),
    changedRecordIds: new Set(),
    loadedPersonIds: new Set(["@I1@", "@I2@"]),
    loadedFamilyIds: new Set(),
    personSnapshots: new Map(),
    familySnapshots: new Map(),
    recordSnapshots: new Map(),
    isSortEligible: () => false,
    isSubstantive: () => true,
    now: NOW,
    t: tr,
    ...over,
  };
}

const confirmedDecisions = (fields: CandidateDecision["fields"] = {}) =>
  new Map([[decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed" as const, fields }]]);

describe("nothing to save", () => {
  it("returns null with no edits and no confirmed merge", () => {
    expect(buildSavePreview(input(dataset(MAIN)))).toBeNull();
  });

  it("returns null when decisions exist but no incoming file is loaded", () => {
    // A restored session can carry decisions whose compare failed to load.
    const out = buildSavePreview(
      input(dataset(MAIN), { decisions: confirmedDecisions(), confirmedCount: 1, compare: undefined }),
    );
    expect(out).toBeNull();
  });
});

describe("edit-only save", () => {
  const editInput = (main: Dataset, over: Partial<SavePreviewInput> = {}) =>
    input(main, {
      changedPersonIds: new Set(["@I1@"]),
      personSnapshots: new Map([["@I1@", dataset(MAIN).individuals.get("@I1@")!.raw]]),
      ...over,
    });

  it("produces a preview flagged as not-a-merge", () => {
    const out = buildSavePreview(editInput(dataset(MAIN)))!;
    expect(out.isMerge).toBe(false);
    expect(out.editRecordIds).toEqual(new Set(["@I1@"]));
  });

  // The preview is checked against the file it started from, so a record that
  // slipped past change tracking still reaches the reader. Both halves matter:
  // the deleted person is named, and the summary counts them.
  it("reports a record that vanished without change tracking noticing", () => {
    const ds = dataset(MAIN);
    const baseline = captureBaseline(ds, () => "Ana Kos", () => undefined);
    ds.records = ds.records.filter((r) => r.xref !== "@I2@");
    ds.individuals.delete("@I2@");

    const out = buildSavePreview(editInput(ds, { baseline }))!;

    expect(out.report.recordLabels["@I2@"]).toBe("Ana Kos");
    expect(out.report.changes.some((c) => c.recordId === "@I2@" && c.removedRecord)).toBe(true);
    expect(reportTotals(out.report).removedRecords).toBe(1);
    expect(out.records.some((r) => r.xref === "@I2@")).toBe(false);
  });

  // Every number at the head of the downloaded report counts lines the report
  // itself goes on to print — the two used to disagree by one per record.
  it("counts as many fields as the report has itemized lines", () => {
    const ds = dataset(MAIN);
    const out = buildSavePreview(editInput(ds))!;
    const totals = reportTotals(out.report);
    expect(totals.fields).toBe(out.report.changes.filter(isItemizedChange).length);
    expect(totals.recordsChanged).toBe(new Set(out.report.changes.map((c) => c.recordId)).size);
  });

  // The reason this builder is pure: the preview is constructed before the user
  // agrees to anything, and its edits are recorded in no RecordPatch.
  it("never mutates the dataset it was given", () => {
    const ds = dataset(MAIN);
    const before = serialize(ds);
    buildSavePreview(editInput(ds, { isSortEligible: () => true }));
    expect(serialize(ds)).toBe(before);
  });

  it("returns records that share no node identity with the live dataset", () => {
    const ds = dataset(MAIN);
    const out = buildSavePreview(editInput(ds))!;
    for (let i = 0; i < out.records.length; i++) {
      expect(out.records[i]).not.toBe(ds.records[i]);
    }
  });

  it("sorts an eligible person's events but leaves others alone", () => {
    const ds = dataset(MAIN);
    const out = buildSavePreview(editInput(ds, { isSortEligible: (x) => x === "@I1@" }))!;
    const tags = out.records.find((r) => r.xref === "@I1@")!.children.map((c) => c.tag);
    expect(tags.filter((t) => t === "BIRT" || t === "DEAT")).toEqual(["BIRT", "DEAT"]);
  });

  it("leaves event order untouched when nothing is sort-eligible", () => {
    const ds = dataset(MAIN);
    const out = buildSavePreview(editInput(ds))!;
    const tags = out.records.find((r) => r.xref === "@I1@")!.children.map((c) => c.tag);
    expect(tags.filter((t) => t === "BIRT" || t === "DEAT")).toEqual(["DEAT", "BIRT"]);
  });

  // A Tools fix can touch only shared records (repairing the DATE on a batch of
  // SOUR records, say). Those are still unsaved changes: the save must be
  // offered, and the report must name what changed.
  it("offers a save for shared-record edits alone", () => {
    const SOURCED = wrap("0 @S1@ SOUR\n1 TITL Krstna knjiga\n1 DATA\n2 DATE Apr 12, 1979\n");
    const ds = dataset(SOURCED);
    const snapshot = dataset(SOURCED).records.find((r) => r.xref === "@S1@")!;
    ds.records.find((r) => r.xref === "@S1@")!.children[1].children[0].value = "12 APR 1979";

    const out = buildSavePreview(
      input(ds, {
        changedRecordIds: new Set(["@S1@"]),
        recordSnapshots: new Map([["@S1@", { value: snapshot }]]),
        loadedPersonIds: new Set(),
      }),
    )!;
    expect(out).not.toBeNull();
    expect(out.report.recordKinds["@S1@"]).toBe("record");
    expect(out.report.recordLabels["@S1@"]).toBe("📖 Krstna knjiga");
    expect(out.report.changes).toContainEqual({
      recordId: "@S1@", field: "DATA.DATE", from: "Apr 12, 1979", to: "12 APR 1979", action: "incoming",
    });
    // The repaired value reaches the file that would be written.
    expect(serializeGedcom(out.records)).toContain("12 APR 1979");
  });

  // A restored session: the source and repository an Add Source created before
  // the reload are in the re-baselined file, so the audit has nothing to catch
  // — only their (hydrated) dirty flags still say they are new and unsaved.
  it("keeps a created source and repository in the preview after a restore", () => {
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SOUR @S9@\n" +
      "0 @S9@ SOUR\n1 TITL Chicago records\n1 REPO @R9@\n" +
      "0 @R9@ REPO\n1 NAME FamilySearch.org - Chicago records\n1 WWW https://www.familysearch.org/\n",
    ));
    const out = buildSavePreview(
      input(ds, {
        // Snapshot-less and in the baseline — exactly how hydrate leaves them.
        changedRecordIds: new Set(["@S9@", "@R9@"]),
        loadedPersonIds: new Set(["@I1@"]),
      }),
    )!;
    expect(out.report.recordLabels["@R9@"]).toBe("🏛 FamilySearch.org - Chicago records");
    expect(out.report.changes.some((c) => c.recordId === "@R9@" && c.newRecord)).toBe(true);
    // Each card spells out what the new record holds, not just its title.
    expect(out.report.changes.some((c) => c.recordId === "@R9@" && c.segments?.some((s) => s.text.includes("familysearch")))).toBe(true);
    expect(out.report.changes.some((c) => c.recordId === "@S9@" && c.newRecord)).toBe(true);
  });
});

describe("download names", () => {
  it("derives both names from the main's stem and one shared timestamp", () => {
    const out = buildSavePreview(input(dataset(MAIN), { changedPersonIds: new Set(["@I1@"]) }))!;
    expect(out.base).toBe("rodovnik");
    expect(out.files).toHaveLength(2);
    expect(out.files[0]).toMatch(/^rodovnik.*\.ged$/);
    expect(out.files[1]).toMatch(/^rodovnik.*\.report\.txt$/);
  });

  // A tree started from nothing is called `new-tree` until it is saved; the
  // download takes the name of the family in it instead.
  it("names a still-unnamed tree after its home person", () => {
    const edited = { changedPersonIds: new Set(["@I1@"]), mainFileName: "new-tree.ged" };
    const out = buildSavePreview(input(dataset(MAIN), edited))!;
    expect(out.base).toBe("Novak");
    expect(out.files[0]).toMatch(/^Novak\..*\.ged$/);

    const home = buildSavePreview(input(dataset(MAIN), { ...edited, homeId: "@I2@" }))!;
    expect(home.base).toBe("Kos");
  });

  it("keeps the placeholder when no surname is on offer", () => {
    const noSurname = wrap("0 @I1@ INDI\n1 NAME Janez\n");
    const out = buildSavePreview(input(dataset(noSurname), {
      changedPersonIds: new Set(["@I1@"]),
      mainFileName: "new-tree.ged",
    }))!;
    expect(out.base).toBe("new-tree");
  });

  it("leaves a real file name alone, whoever the home person is", () => {
    const out = buildSavePreview(input(dataset(MAIN), {
      changedPersonIds: new Set(["@I1@"]),
      homeId: "@I2@",
    }))!;
    expect(out.base).toBe("rodovnik");
  });

  it("is reproducible for a fixed `now`", () => {
    const a = buildSavePreview(input(dataset(MAIN), { changedPersonIds: new Set(["@I1@"]) }))!;
    const b = buildSavePreview(input(dataset(MAIN), { changedPersonIds: new Set(["@I1@"]) }))!;
    expect(a.files).toEqual(b.files);
  });
});

describe("merge save", () => {
  const mergeInput = (over: Partial<SavePreviewInput> = {}) =>
    input(dataset(MAIN), {
      compare: dataset(COMPARE),
      decisions: confirmedDecisions(),
      confirmedCount: 1,
      matches: { individuals: [] },
      ...over,
    });

  it("is flagged as a merge", () => {
    const main = dataset(MAIN);
    const out = buildSavePreview({ ...mergeInput(), main })!;
    expect(out.isMerge).toBe(true);
  });

  it("does not mutate the live main", () => {
    const main = dataset(MAIN);
    const before = serialize(main);
    buildSavePreview({ ...mergeInput(), main });
    expect(serialize(main)).toBe(before);
  });

  it("takes the incoming birth place into the output", () => {
    const out = buildSavePreview(mergeInput())!;
    expect(serializeGedcom(out.records)).toContain("Kranj");
  });

  it("combines the edit report with the merge report when both apply", () => {
    const main = dataset(MAIN);
    const out = buildSavePreview({
      ...mergeInput(),
      main,
      changedPersonIds: new Set(["@I2@"]),
      personSnapshots: new Map([["@I2@", editedFrom(dataset(MAIN), "@I2@")]]),
    })!;
    expect(Object.keys(out.report.recordKinds)).toContain("@I2@");
  });
});

// ── which records the save stamps ──────────────────────────────────────────
// A record changed only by a maintenance pass keeps the change date the file
// gave it; hand edits and everything the merge touched get a fresh stamp.

describe("stampRecordIds", () => {
  it("keeps substantively edited records and drops mechanical-only ones", () => {
    const ds = dataset(MAIN);
    const out = buildSavePreview(
      input(ds, {
        changedPersonIds: new Set(["@I1@", "@I2@"]),
        personSnapshots: new Map([
          ["@I1@", editedFrom(ds, "@I1@")],
          ["@I2@", editedFrom(ds, "@I2@")],
        ]),
        isSubstantive: (id) => id === "@I1@",
      }),
    )!;
    expect(out.stampRecordIds.has("@I1@")).toBe(true);
    expect(out.stampRecordIds.has("@I2@")).toBe(false);
    // The record still saves and still shows in the preview — only its stamp stays.
    expect(out.editRecordIds.has("@I2@")).toBe(true);
    expect(Object.keys(out.report.recordKinds)).toContain("@I2@");
  });

  it("always stamps what the merge touched, whatever the edit tracking says", () => {
    const out = buildSavePreview(
      input(dataset(MAIN), {
        compare: dataset(COMPARE),
        decisions: confirmedDecisions(),
        confirmedCount: 1,
        matches: { individuals: [] },
        isSubstantive: () => false,
      }),
    )!;
    expect(out.stampRecordIds.has("@I1@")).toBe(true);
  });
});

describe("integrity warnings", () => {
  it("reports a dangling pointer in the output", () => {
    const broken = dataset(wrap("0 @I1@ INDI\n1 NAME A /B/\n1 FAMS @FMISSING@\n"));
    const out = buildSavePreview(
      input(broken, { changedPersonIds: new Set(["@I1@"]), loadedPersonIds: new Set(["@I1@"]) }),
    )!;
    expect(out.integrityWarnings.some((w) => w.includes("dangling"))).toBe(true);
  });

  it("has no warnings for a clean edit-only save", () => {
    const out = buildSavePreview(input(dataset(MAIN), { changedPersonIds: new Set(["@I1@"]) }))!;
    expect(out.integrityWarnings).toEqual([]);
  });

  it("warns about a confirmed decision whose main person was deleted", () => {
    const out = buildSavePreview(
      input(dataset(MAIN), {
        changedPersonIds: new Set(["@I2@"]),
        decisions: new Map([
          [decisionKey("individual", "@GONE@", "@P1@"), { status: "confirmed", fields: {} }],
        ]),
      }),
    )!;
    expect(out.integrityWarnings.some((w) => w.includes("orphanedDecision"))).toBe(true);
  });

  it("does not warn about a field edited after its match was confirmed", () => {
    // That case is no longer a warning: the merge stands down and keeps the
    // edit, reporting it per field in the deferred list instead.
    const out = buildSavePreview(
      input(dataset(MAIN), {
        compare: dataset(COMPARE),
        confirmedCount: 1,
        matches: { individuals: [] },
        decisions: new Map([
          [
            decisionKey("individual", "@I1@", "@P1@"),
            { status: "confirmed", fields: {}, mainFields: { "BIRT.date": "an older value" } },
          ],
        ]),
      }),
    )!;
    expect(out.integrityWarnings).toEqual([]);
  });

  it("ignores decisions that are not confirmed", () => {
    const out = buildSavePreview(
      input(dataset(MAIN), {
        changedPersonIds: new Set(["@I2@"]),
        decisions: new Map([
          [decisionKey("individual", "@GONE@", "@P1@"), { status: "rejected", fields: {} }],
        ]),
      }),
    )!;
    expect(out.integrityWarnings).toEqual([]);
  });

  it("caps a flood of dangling pointers and says how many more there were", () => {
    // 12 individuals, each pointing at its own missing family.
    const body = Array.from({ length: 12 }, (_, i) => `0 @I${i}@ INDI\n1 NAME A /B/\n1 FAMS @FX${i}@\n`).join("");
    const broken = dataset(wrap(body));
    const ids = new Set(Array.from({ length: 12 }, (_, i) => `@I${i}@`));
    const out = buildSavePreview(input(broken, { changedPersonIds: ids, loadedPersonIds: ids }))!;

    const dangling = out.integrityWarnings.filter((w) => w === "save.preview.dangling");
    expect(dangling).toHaveLength(8);
    expect(out.integrityWarnings).toContain("save.preview.danglingMore");
  });
});

describe("the report", () => {
  it("labels the changed record and marks it as neither new nor removed", () => {
    const out = buildSavePreview(
      input(dataset(MAIN), {
        changedPersonIds: new Set(["@I1@"]),
        personSnapshots: new Map([["@I1@", editedFrom(dataset(MAIN), "@I1@")]]),
      }),
    )!;
    expect(out.report.recordLabels["@I1@"]).toBe("Janez Novak");
    expect(out.report.changes.find((c) => c.recordId === "@I1@")?.newRecord).toBe(false);
  });

  it("counts a person absent from the loaded set as newly added", () => {
    const out = buildSavePreview(
      input(dataset(MAIN), { changedPersonIds: new Set(["@I1@"]), loadedPersonIds: new Set() }),
    )!;
    expect(out.report.newPersons).toBe(1);
  });
});

describe("record independence", () => {
  it("lets the caller mutate the returned records without touching the dataset", () => {
    const ds = dataset(MAIN);
    const before = serialize(ds);
    const out = buildSavePreview(input(ds, { changedPersonIds: new Set(["@I1@"]) }))!;
    // Stands in for stampChanCrea / ensureUtf8Charset, applied on confirm.
    for (const r of out.records) {
      (r.children as GedNode[]).push({ level: 1, tag: "NOTE", value: "touched", children: [] });
    }
    expect(serialize(ds)).toBe(before);
  });
});
