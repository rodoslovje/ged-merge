import { describe, expect, it } from "vitest";
import { buildDataset } from "./builder";
import { extractBranch } from "./branchExport";
import { parseGedcom } from "./parser";
import { serializeGedcom } from "./serialize";
import type { GedNode } from "./types";
import {
  dropResearchNotes, readResearchNotes, researchNoteNode, researchPointerNode, RESEARCH_TAG, type ResearchNote,
} from "./research";
import { mergeDecisions } from "../merge/merge";
import { decisionKey, type CandidateDecision } from "../review/types";
import { inferMainProfile } from "../normalize/profile";
import { normalizeDataset } from "../normalize/normalize";
import { outputOptions, prepareDownload } from "../save/outputFile";
import { validateConformance } from "../tools/conformance/conformance";
import { bulkNormalize } from "../tools/bulkNormalize";
import { defaultPrivacyOptions, privatizeDataset } from "../tools/privacy";
import { findDanglingXrefs } from "../tools/structure";

const parse = (text: string) => parseGedcom(new TextEncoder().encode(text).buffer);
const dataset = (text: string) => buildDataset(parse(text));

const head = (version: "5.5.1" | "7.0") =>
  version === "7.0"
    ? ["0 HEAD", "1 GEDC", "2 VERS 7.0", "1 SOUR TEST"]
    : ["0 HEAD", "1 SOUR TEST", "1 SUBM @U1@", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8", "0 @U1@ SUBM", "1 NAME Tester"];

/** Two people, a photo only a research note keeps, a note on a death, one on
 *  the person and one not filed. */
const file = (version: "5.5.1" | "7.0") =>
  [
    ...head(version),
    "0 @I1@ INDI",
    "1 NAME Franc /Novak/",
    "1 SEX M",
    "1 BIRT",
    "2 DATE 1 JAN 1850",
    "1 DEAT",
    "2 DATE ABT 1910",
    "2 _RESEARCH @RN1@",
    "1 _RESEARCH @RN2@",
    "0 @I2@ INDI",
    "1 NAME Ana /Novak/",
    "1 SEX F",
    "1 _RESEARCH @RN1@",
    "0 @M1@ OBJE",
    ...(version === "7.0" ? ["1 FILE scan.jpg", "2 FORM image/jpeg"] : ["1 FILE scan.jpg", "2 FORM jpg"]),
    "0 @RN1@ _RESEARCH",
    "1 TYPE QUESTION",
    "1 STAT OPEN",
    "1 DATE 23 NOV 2026",
    "1 NOTE Did he really die in America?",
    "2 CONT Check the passenger lists.",
    "1 WWW https://example.org/lists",
    "1 OBJE @M1@",
    "0 @RN2@ _RESEARCH",
    "1 TYPE TASK",
    "1 STAT DONE",
    "1 NOTE Find the baptism register.",
    "0 @RN3@ _RESEARCH",
    "1 TYPE FIND",
    "1 STAT OPEN",
    "1 NOTE A newspaper clipping, not placed yet.",
    "0 TRLR",
  ].join("\n") + "\n";

const hasResearch = (records: GedNode[]) => serializeGedcom(records).includes(RESEARCH_TAG);

describe("research notes — reading", () => {
  it("reads every note and where it is filed", () => {
    const { notes, refs } = readResearchNotes(parse(file("5.5.1")).records);
    expect(notes).toEqual<ResearchNote[]>([
      {
        id: "@RN1@", kind: "QUESTION", done: false, created: "23 NOV 2026",
        text: "Did he really die in America?\nCheck the passenger lists.",
        links: ["https://example.org/lists"], media: ["@M1@"],
      },
      { id: "@RN2@", kind: "TASK", done: true, created: undefined, text: "Find the baptism register.", links: [], media: [] },
      { id: "@RN3@", kind: "FIND", done: false, created: undefined, text: "A newspaper clipping, not placed yet.", links: [], media: [] },
    ]);
    expect(refs.get("@RN1@")).toEqual([
      { recordId: "@I1@", recordTag: "INDI", eventIndex: 3, eventTag: "DEAT" },
      { recordId: "@I2@", recordTag: "INDI" },
    ]);
    expect(refs.get("@RN2@")).toEqual([{ recordId: "@I1@", recordTag: "INDI" }]);
    // Not filed: nothing points at it.
    expect(refs.has("@RN3@")).toBe(false);
  });

  it("reads an unknown kind as an idea and any other status as open", () => {
    const { notes } = readResearchNotes(parse(["0 HEAD", "0 @RN1@ _RESEARCH", "1 TYPE whatever", "1 STAT later", "0 TRLR"].join("\n")).records);
    expect(notes[0]).toMatchObject({ kind: "IDEA", done: false, text: "" });
  });

  it("writes a note back as the record it was read from", () => {
    const records = parse(file("5.5.1")).records;
    const { notes } = readResearchNotes(records);
    expect(researchPointerNode("@RN1@", 2)).toEqual({ level: 2, tag: "_RESEARCH", value: "@RN1@", children: [] });
    expect(serializeGedcom([researchNoteNode(notes[0])]).trimEnd().split("\n")).toEqual([
      "0 @RN1@ _RESEARCH",
      "1 TYPE QUESTION",
      "1 STAT OPEN",
      "1 DATE 23 NOV 2026",
      "1 NOTE Did he really die in America?",
      "2 CONT Check the passenger lists.",
      "1 WWW https://example.org/lists",
      "1 OBJE @M1@",
    ]);
  });
});

describe("research notes — only Save writes them", () => {
  for (const version of ["5.5.1", "7.0"] as const) {
    it(`Save keeps them in a valid ${version} file`, () => {
      const ds = parse(file(version));
      prepareDownload(ds.records, ds, version, undefined, undefined, true);
      expect(validateConformance({ records: ds.records })).toEqual([]);
      expect(findDanglingXrefs(ds.records)).toEqual([]);
      const reread = parse(serializeGedcom(ds.records, outputOptions(ds, version)));
      expect(readResearchNotes(reread.records)).toEqual(readResearchNotes(parse(file(version)).records));
    });

    it(`survives a conversion from ${version} to the other version`, () => {
      const other = version === "7.0" ? "5.5.1" : "7.0";
      const ds = parse(file(version));
      prepareDownload(ds.records, ds, other, undefined, undefined, true);
      expect(validateConformance({ records: ds.records })).toEqual([]);
      const reread = parse(serializeGedcom(ds.records, outputOptions(ds, other)));
      expect(readResearchNotes(reread.records)).toEqual(readResearchNotes(parse(file(version)).records));
    });
  }

  it("declares the tag in a 7.0 header, at the app's own terms page", () => {
    const ds = parse(file("7.0"));
    prepareDownload(ds.records, ds, "7.0", undefined, undefined, true);
    expect(serializeGedcom(ds.records)).toContain("2 TAG _RESEARCH https://gedmerge.com/terms/gedmerge/_RESEARCH");
  });

  it("any other download leaves them out", () => {
    const ds = parse(file("5.5.1"));
    prepareDownload(ds.records, ds);
    expect(hasResearch(ds.records)).toBe(false);
    expect(validateConformance({ records: ds.records })).toEqual([]);
  });

  it("a branch export leaves out the notes and the media only a note keeps", () => {
    const ds = dataset(file("5.5.1"));
    const { records } = extractBranch(ds, ["@I1@", "@I2@"]);
    expect(hasResearch(records)).toBe(false);
    expect(records.some((r) => r.tag === "OBJE")).toBe(false);
    // The main file is not touched.
    expect(readResearchNotes(ds.records).notes).toHaveLength(3);
  });

  it("the privacy export leaves out the notes and the media only a note keeps", () => {
    const ds = dataset(file("5.5.1"));
    const { records } = privatizeDataset(ds, defaultPrivacyOptions(), 2026);
    expect(hasResearch(records)).toBe(false);
    expect(records.some((r) => r.tag === "OBJE")).toBe(false);
    expect(readResearchNotes(ds.records).notes).toHaveLength(3);
  });
});

describe("research notes — an incoming file's are not merged", () => {
  it("drops them when the compare file is reshaped to the main", () => {
    const main = dataset([...head("5.5.1"), "0 @I1@ INDI", "1 NAME Jože /Kranjc/", "0 TRLR"].join("\n"));
    const compare = dataset(file("5.5.1"));
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(main));
    expect(hasResearch(out.records)).toBe(false);
    // The input is a copy's source, left as loaded.
    expect(readResearchNotes(compare.records).notes).toHaveLength(3);
  });

  it("keeps them when one's own file is normalized", () => {
    const ds = dataset(file("5.5.1"));
    const { dataset: out } = bulkNormalize(ds);
    expect(readResearchNotes(out.records)).toEqual(readResearchNotes(ds.records));
  });
});

describe("dropResearchNotes", () => {
  it("removes the records and every pointer, in place, and counts the records", () => {
    const records = parse(file("5.5.1")).records;
    const before = records.length;
    expect(dropResearchNotes(records)).toBe(3);
    expect(records).toHaveLength(before - 3);
    expect(hasResearch(records)).toBe(false);
    // Another program's line of the same name that points nowhere is its own.
    const other = parse(["0 HEAD", "0 @I1@ INDI", "1 _RESEARCH see the archive", "0 TRLR"].join("\n")).records;
    dropResearchNotes(other);
    expect(hasResearch(other)).toBe(true);
  });
});

describe("research notes — the main's own survive a merge", () => {
  it("keeps the main's notes where they were filed when a match is merged in", () => {
    const wrap = (body: string[]) => [...head("5.5.1"), ...body, "0 TRLR"].join("\n") + "\n";
    const main = dataset(wrap([
      "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1850", "2 _RESEARCH @RN1@", "1 _RESEARCH @RN1@",
      "0 @RN1@ _RESEARCH", "1 TYPE QUESTION", "1 STAT OPEN", "1 NOTE Born in Kranj?",
    ]));
    // The incoming file carries a note of its own under the same xref.
    const incoming = dataset(wrap([
      "0 @P1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1850", "2 PLAC Kranj", "2 _RESEARCH @RN1@",
      "0 @RN1@ _RESEARCH", "1 TYPE IDEA", "1 STAT OPEN", "1 NOTE The other owner's.",
    ]));
    const { dataset: compare } = normalizeDataset(incoming, inferMainProfile(main));
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
    ]);
    const { records } = mergeDecisions(main, compare, decisions, { individuals: [] }, (key) => key);
    expect(serializeGedcom(records)).toContain("2 PLAC Kranj");
    const { notes, refs } = readResearchNotes(records);
    expect(notes.map((n) => n.text)).toEqual(["Born in Kranj?"]);
    expect(refs.get("@RN1@")).toEqual([
      { recordId: "@I1@", recordTag: "INDI", eventIndex: expect.any(Number), eventTag: "BIRT" },
      { recordId: "@I1@", recordTag: "INDI" },
    ]);
  });
});
