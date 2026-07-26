import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import type { Dataset, GedNode } from "../gedcom/types";
import { decisionKey, type CandidateDecision } from "../review/types";
import { buildSavePreview, type SavePreviewInput } from "./buildSavePreview";

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
    compare: undefined,
    decisions: new Map(),
    matches: null,
    importRequests: [],
    confirmedCount: 0,
    importCount: 0,
    changedPersonIds: new Set(),
    changedFamilyIds: new Set(),
    loadedPersonIds: new Set(["@I1@", "@I2@"]),
    loadedFamilyIds: new Set(),
    personSnapshots: new Map(),
    familySnapshots: new Map(),
    isSortEligible: () => false,
    now: NOW,
    t: tr,
    nameOf: () => "Janez Novak",
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
    expect(out.mainRecordCount).toBeUndefined();
    expect(out.editRecordIds).toEqual(new Set(["@I1@"]));
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
});

describe("download names", () => {
  it("derives both names from the main's stem and one shared timestamp", () => {
    const out = buildSavePreview(input(dataset(MAIN), { changedPersonIds: new Set(["@I1@"]) }))!;
    expect(out.base).toBe("rodovnik");
    expect(out.files).toHaveLength(2);
    expect(out.files[0]).toMatch(/^rodovnik.*\.ged$/);
    expect(out.files[1]).toMatch(/^rodovnik.*\.report\.txt$/);
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

  it("is flagged as a merge and reports the main record count", () => {
    const main = dataset(MAIN);
    const out = buildSavePreview({ ...mergeInput(), main })!;
    expect(out.isMerge).toBe(true);
    expect(out.mainRecordCount).toBe(main.individuals.size + main.families.size);
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
      personSnapshots: new Map([["@I2@", dataset(MAIN).individuals.get("@I2@")!.raw]]),
    })!;
    expect(Object.keys(out.report.recordKinds)).toContain("@I2@");
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

  it("warns when a confirmed decision's fingerprint no longer matches the record", () => {
    const main = dataset(MAIN);
    const out = buildSavePreview(
      input(main, {
        compare: dataset(COMPARE),
        confirmedCount: 1,
        matches: { individuals: [] },
        decisions: new Map([
          [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, mainFp: "stale-fingerprint" }],
        ]),
      }),
    )!;
    expect(out.integrityWarnings.some((w) => w.includes("staleDecision"))).toBe(true);
  });

  it("does not raise a stale-fingerprint warning on an edit-only save", () => {
    // Without a merge there are no field choices to have gone stale.
    const out = buildSavePreview(
      input(dataset(MAIN), {
        changedPersonIds: new Set(["@I2@"]),
        decisions: new Map([
          [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, mainFp: "stale-fingerprint" }],
        ]),
      }),
    )!;
    expect(out.integrityWarnings.some((w) => w.includes("staleDecision"))).toBe(false);
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
        personSnapshots: new Map([["@I1@", dataset(MAIN).individuals.get("@I1@")!.raw]]),
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
