import { describe, expect, it } from "vitest";
import { parseGedcom } from "../parser";
import { buildDataset } from "../builder";
import { serializeGedcom } from "../serialize";
import {
  applyEventNodeUpdate, applyNoteRefs, countNoteRefs, noteCtx,
  rebuildNoteReferrers, setNotes,
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
