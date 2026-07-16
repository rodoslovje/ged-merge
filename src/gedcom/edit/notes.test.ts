import { describe, expect, it } from "vitest";
import { parseGedcom } from "../parser";
import { buildDataset } from "../builder";
import { serializeGedcom } from "../serialize";
import {
  applyEventNodeUpdate, applyNoteRefs, countNoteRefs, noteCtx,
  rebuildNoteReferrers, setMediaInfo, setNotes, updateSourceCitation,
} from "../edit";
import { INDI_CHILD_ORDER } from "./shared";
import { firstChild } from "../node";

function buildFromText(lines: string[]) {
  const buf = new TextEncoder().encode(lines.join("\n"));
  return buildDataset(parseGedcom(buf.buffer));
}

/** MacFamilyTree-style file: every note is a shared record + pointer; the
 *  shared record carries sub-structure (PRIV) that must survive edits. */
const SHARED = [
  "0 HEAD",
  "1 GEDC",
  "2 VERS 5.5.1",
  "0 @I1@ INDI",
  "1 NAME Ana /Novak/",
  "1 NOTE @N1@",
  "1 BIRT",
  "2 DATE 1 JAN 1900",
  "2 NOTE @N2@",
  "0 @I2@ INDI",
  "1 NAME Ivan /Novak/",
  "1 NOTE @N1@",
  "0 @N1@ NOTE Shared family story",
  "1 PRIV Y",
  "0 @N2@ NOTE Baptism register remark",
  "0 TRLR",
];

describe("builder noteRefs", () => {
  it("collects pointer and inline notes with identity, including URL-only ones", () => {
    const ds = buildFromText([
      "0 HEAD",
      "0 @I1@ INDI",
      "1 NOTE @N1@",
      "1 NOTE plain inline note",
      "1 NOTE https://example.com/only-a-url",
      "0 @N1@ NOTE shared text",
      "0 TRLR",
    ]);
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.noteRefs).toEqual([
      { xref: "@N1@", text: "shared text" },
      { text: "plain inline note" },
      { text: "https://example.com/only-a-url" },
    ]);
    // The display list still hides the URL-only note (it surfaces as a link).
    expect(indi.notes).toEqual(["shared text", "plain inline note"]);
  });

  it("keeps a dangling pointer as a ref and flags event pointer notes", () => {
    const ds = buildFromText([
      "0 HEAD",
      "0 @I1@ INDI",
      "1 NOTE @NGONE@",
      "1 BIRT",
      "2 NOTE @N2@",
      "0 @N2@ NOTE event note",
      "0 TRLR",
    ]);
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.noteRefs).toEqual([{ xref: "@NGONE@", text: "" }]);
    expect(indi.events.find((e) => e.tag === "BIRT")?.noteXref).toBe("@N2@");
  });
});

describe("applyNoteRefs (record-level notes)", () => {
  it("edits a pointer note inside the shared record, keeping the pointer", () => {
    const ds = buildFromText(SHARED);
    const indi = ds.individuals.get("@I1@")!;
    const ctx = noteCtx(ds.records);
    setNotes(ctx, indi, [{ xref: "@N1@", text: "Corrected family story" }]);

    const out = serializeGedcom(ds.records);
    expect(out).toContain("1 NOTE @N1@");
    expect(out).toContain("0 @N1@ NOTE Corrected family story");
    expect(out).toContain("1 PRIV Y"); // record sub-structure survives
    expect(ctx.changes).toHaveLength(1);
    expect(ctx.changes[0].xref).toBe("@N1@");
    expect(ctx.changes[0].after?.value).toBe("Corrected family story");
    // The other referrer sees the edit through the shared record.
    rebuildNoteReferrers(ds, ctx.changes, indi.id);
    expect(ds.individuals.get("@I2@")!.notes).toEqual(["Corrected family story"]);
  });

  it("does not touch the record when the text is unchanged", () => {
    const ds = buildFromText(SHARED);
    const indi = ds.individuals.get("@I1@")!;
    const ctx = noteCtx(ds.records);
    setNotes(ctx, indi, [{ xref: "@N1@", text: "Shared family story" }]);
    expect(ctx.changes).toHaveLength(0);
  });

  it("keeps the shared record when another referrer still uses it", () => {
    const ds = buildFromText(SHARED);
    const indi = ds.individuals.get("@I1@")!;
    const ctx = noteCtx(ds.records);
    setNotes(ctx, indi, []); // remove @I1@'s reference

    const out = serializeGedcom(ds.records);
    expect(out).toContain("0 @N1@ NOTE Shared family story"); // @I2@ still points at it
    expect(countNoteRefs(ds.records, "@N1@")).toBe(1);
    expect(ctx.changes).toHaveLength(0);
  });

  it("deletes the shared record when the last reference is removed", () => {
    const ds = buildFromText(SHARED);
    const ctx = noteCtx(ds.records);
    setNotes(ctx, ds.individuals.get("@I1@")!, []);
    setNotes(ctx, ds.individuals.get("@I2@")!, []);

    const out = serializeGedcom(ds.records);
    expect(out).not.toContain("@N1@");
    const removal = ctx.changes.find((c) => c.after === null);
    expect(removal?.xref).toBe("@N1@");
    expect(removal?.index).toBeTypeOf("number");
  });

  it("round-trips a mix of pointer, inline and hidden URL-only notes", () => {
    const ds = buildFromText([
      "0 HEAD",
      "0 @I1@ INDI",
      "1 NOTE @N1@",
      "1 NOTE https://example.com/x",
      "0 @N1@ NOTE ptr text",
      "0 TRLR",
    ]);
    const indi = ds.individuals.get("@I1@")!;
    // Simulates the editor committing: hidden URL-only ref passes through
    // untouched, an inline note is added.
    const ctx = noteCtx(ds.records);
    applyNoteRefs(ctx, indi.raw, [
      { xref: "@N1@", text: "ptr text" },
      { text: "https://example.com/x" },
      { text: "brand new note" },
    ], INDI_CHILD_ORDER);

    const out = serializeGedcom(ds.records);
    expect(out).toContain("1 NOTE @N1@");
    expect(out).toContain("1 NOTE https://example.com/x");
    expect(out).toContain("1 NOTE brand new note");
    expect(ctx.changes).toHaveLength(0);
  });
});

describe("private notes", () => {
  const PRIVATE_FILE = [
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NOTE @N1@",
    "1 NOTE inline note https://example.com/public",
    "0 @N1@ NOTE",
    "1 CONT https://www.facebook.com/annik.alvarado",
    "1 PRIV",
    // A second private record keeps the file's dialect detectable even while
    // @N1@'s flag is toggled off.
    "0 @N2@ NOTE another private remark",
    "1 PRIV",
    "0 TRLR",
  ];

  it("builder flags private notes and keeps their URLs out of links", () => {
    const ds = buildFromText(PRIVATE_FILE);
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.noteRefs?.map((r) => !!r.private)).toEqual([true, false]);
    expect(indi.links).toEqual(["https://example.com/public"]); // facebook URL stays private
  });

  it("toggling a pointer note's private flag writes the file's dialect into the record", () => {
    const ds = buildFromText(PRIVATE_FILE);
    const indi = ds.individuals.get("@I1@")!;
    const n1 = ds.records.find((r) => r.xref === "@N1@")!;
    const ctx = noteCtx(ds.records);
    setNotes(ctx, indi, indi.noteRefs!.map((r) => (r.xref === "@N1@" ? { ...r, private: false } : r)));
    expect(n1.children.some((c) => c.tag === "PRIV")).toBe(false);
    expect(ctx.changes.map((c) => c.xref)).toEqual(["@N1@"]);

    // Toggle back on: the file's dialect (bare PRIV) is what gets written.
    const ctx2 = noteCtx(ds.records);
    setNotes(ctx2, indi, indi.noteRefs!.map((r) => (r.xref === "@N1@" ? { ...r, private: true } : r)));
    expect(n1.children.some((c) => c.tag === "PRIV" && c.value === undefined)).toBe(true);
  });

  it("an inline note's private flag is written as a marker child", () => {
    const ds = buildFromText(PRIVATE_FILE);
    const indi = ds.individuals.get("@I1@")!;
    const ctx = noteCtx(ds.records);
    setNotes(ctx, indi, indi.noteRefs!.map((r) => (r.xref ? r : { ...r, private: true })));
    const out = serializeGedcom(ds.records);
    expect(out).toContain("1 NOTE inline note https://example.com/public");
    expect(out).toMatch(/1 NOTE inline note[^\n]*\n2 PRIV/);
  });

  it("person and family records project their private flag", () => {
    const ds = buildFromText([
      "0 HEAD",
      "0 @I1@ INDI",
      "1 _PRIV Y",
      "0 @I2@ INDI",
      "0 @F1@ FAM",
      "1 RESN confidential",
      "0 TRLR",
    ]);
    expect(ds.individuals.get("@I1@")!.private).toBe(true);
    expect(ds.individuals.get("@I2@")!.private).toBeUndefined();
    expect(ds.families.get("@F1@")!.private).toBe(true);
  });
});

describe("event pointer notes", () => {
  it("edits an event's pointer note inside the shared record", () => {
    const ds = buildFromText(SHARED);
    const indi = ds.individuals.get("@I1@")!;
    const birt = firstChild(indi.raw, "BIRT")!;
    const ctx = noteCtx(ds.records);
    applyEventNodeUpdate(indi.raw, birt, { note: "Better remark" }, ctx);

    const out = serializeGedcom(ds.records);
    expect(out).toContain("2 NOTE @N2@");
    expect(out).toContain("0 @N2@ NOTE Better remark");
    expect(ctx.changes.map((c) => c.xref)).toEqual(["@N2@"]);
  });

  it("clearing an event's pointer note removes the pointer and the orphaned record", () => {
    const ds = buildFromText(SHARED);
    const indi = ds.individuals.get("@I1@")!;
    const birt = firstChild(indi.raw, "BIRT")!;
    const ctx = noteCtx(ds.records);
    applyEventNodeUpdate(indi.raw, birt, { note: "" }, ctx);

    const out = serializeGedcom(ds.records);
    expect(out).not.toContain("@N2@");
    expect(ctx.changes.find((c) => c.after === null)?.xref).toBe("@N2@");
  });

  it("clearing an event's pointer note keeps a still-shared record", () => {
    const ds = buildFromText([
      "0 HEAD",
      "0 @I1@ INDI",
      "1 BIRT",
      "2 NOTE @N1@",
      "0 @I2@ INDI",
      "1 NOTE @N1@",
      "0 @N1@ NOTE shared",
      "0 TRLR",
    ]);
    const indi = ds.individuals.get("@I1@")!;
    const birt = firstChild(indi.raw, "BIRT")!;
    const ctx = noteCtx(ds.records);
    applyEventNodeUpdate(indi.raw, birt, { note: "" }, ctx);

    const out = serializeGedcom(ds.records);
    expect(out).toContain("0 @N1@ NOTE shared");
    expect(out).toContain("1 NOTE @N1@");
    expect(firstChild(birt, "NOTE")).toBeUndefined();
  });

  it("source-record pointer notes edit inside the shared record via the Edit Source dialog path", () => {
    const ds = buildFromText([
      "0 HEAD",
      "0 @I1@ INDI",
      "1 SOUR @S1@",
      "2 PAGE p. 5",
      "0 @S1@ SOUR",
      "1 TITL Parish register",
      "1 NOTE @N1@",
      "0 @N1@ NOTE register remark",
      "0 TRLR",
    ]);
    const indi = ds.individuals.get("@I1@")!;
    const ctx = noteCtx(ds.records);
    updateSourceCitation(ds.records, indi.raw, 0, { title: "Parish register", page: "p. 5", note: "better remark" }, ctx);

    const out = serializeGedcom(ds.records);
    expect(out).toContain("1 NOTE @N1@");
    expect(out).toContain("0 @N1@ NOTE better remark");
    expect(ctx.changes.map((c) => c.xref)).toEqual(["@N1@"]);

    // Clearing the note releases the reference and removes the orphaned record.
    updateSourceCitation(ds.records, indi.raw, 0, { title: "Parish register", page: "p. 5", note: "" }, ctx);
    expect(serializeGedcom(ds.records)).not.toContain("@N1@");
  });

  it("setMediaInfo keeps a shared pointer note while migrating the description", () => {
    const ds = buildFromText([
      "0 HEAD",
      "0 @O1@ OBJE",
      "1 FILE photo.jpg",
      "1 NOTE @N1@",
      "1 NOTE old inline description",
      "0 @N1@ NOTE shared media note",
      "0 TRLR",
    ]);
    const obje = ds.records.find((r) => r.xref === "@O1@")!;
    setMediaInfo(obje, { description: "new description" });
    const out = serializeGedcom(ds.records);
    expect(out).toContain("1 NOTE @N1@"); // pointer survives
    expect(out).not.toContain("old inline description"); // inline NOTE migrated
    expect(out).toContain("1 _DSCR new description");
  });

  it("without a ctx, inline behavior is unchanged", () => {
    const ds = buildFromText([
      "0 HEAD",
      "0 @I1@ INDI",
      "1 BIRT",
      "2 NOTE plain note",
      "0 TRLR",
    ]);
    const indi = ds.individuals.get("@I1@")!;
    const birt = firstChild(indi.raw, "BIRT")!;
    applyEventNodeUpdate(indi.raw, birt, { note: "edited note" });
    expect(firstChild(birt, "NOTE")?.value).toBe("edited note");
  });

  it("whitespace-only differences don't rewrite the record (trimmed dialog prefill)", () => {
    const ds = buildFromText([
      "0 HEAD",
      "0 @I1@ INDI",
      "1 NOTE @N1@",
      "0 @N1@ NOTE",
      "1 CONT https://www.facebook.com/annik.alvarado",
      "0 TRLR",
    ]);
    // The record's text starts on a CONT line → verbatim value has a leading
    // newline; committing the trimmed form back must be a no-op.
    const ctx = noteCtx(ds.records);
    setNotes(ctx, ds.individuals.get("@I1@")!, [{ xref: "@N1@", text: "https://www.facebook.com/annik.alvarado" }]);
    expect(ctx.changes).toHaveLength(0);
    expect(serializeGedcom(ds.records)).toContain("1 CONT https://www.facebook.com/annik.alvarado");
  });

  it("multi-line pointer-note text serializes as CONT lines in the record", () => {
    const ds = buildFromText(SHARED);
    const indi = ds.individuals.get("@I1@")!;
    const ctx = noteCtx(ds.records);
    setNotes(ctx, indi, [{ xref: "@N1@", text: "line one\nline two" }]);
    const out = serializeGedcom(ds.records);
    expect(out).toContain("0 @N1@ NOTE line one");
    expect(out).toContain("1 CONT line two");
  });
});
