import { describe, expect, it } from "vitest";
import { parseGedcom } from "../parser";
import { buildDataset } from "../builder";
import { serializeGedcom } from "../serialize";
import { applyEventNodeUpdate, noteCtx } from "../edit";
import { firstChild } from "../node";

function build(lines: string[]) {
  return buildDataset(parseGedcom(new TextEncoder().encode(lines.join("\n")).buffer));
}

/** An event carrying three notes: one inline, one shared, one private inline. */
const THREE = [
  "0 HEAD",
  "1 GEDC",
  "2 VERS 5.5.1",
  "0 @I1@ INDI",
  "1 NAME Janez /Novak/",
  "1 BIRT",
  "2 DATE 1900",
  "2 NOTE first note",
  "2 NOTE @N1@",
  "2 NOTE https://web.facebook.com/someone",
  "3 PRIV",
  "0 @N1@ NOTE a shared remark",
  "0 TRLR",
  "",
];

describe("an event's notes", () => {
  it("are all lifted, not just the first", () => {
    const ds = build(THREE);
    const birt = ds.individuals.get("@I1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birt.noteRefs?.map((r) => r.text)).toEqual([
      "first note",
      "a shared remark",
      "https://web.facebook.com/someone",
    ]);
    // The shared one keeps its identity, the private one its flag.
    expect(birt.noteRefs?.[1].xref).toBe("@N1@");
    expect(birt.noteRefs?.[2].private).toBe(true);
    // `note` stays the first, for everything that shows one note.
    expect(birt.note).toBe("first note");
  });

  it("survive an edit to the first one", () => {
    // `setOrRemoveValue` keeps one node per tag, so routing a note through it
    // deleted every sibling note as collateral of editing the first.
    const ds = build(THREE);
    const indi = ds.individuals.get("@I1@")!;
    const eventNode = firstChild(indi.raw, "BIRT")!;
    applyEventNodeUpdate(indi.raw, eventNode, { note: "first note, corrected" }, noteCtx(ds.records));

    const out = serializeGedcom(ds.records);
    expect(out).toContain("2 NOTE first note, corrected");
    expect(out).toContain("2 NOTE @N1@");
    expect(out).toContain("2 NOTE https://web.facebook.com/someone");
  });

  it("survive an edit to another field entirely", () => {
    const ds = build(THREE);
    const indi = ds.individuals.get("@I1@")!;
    const eventNode = firstChild(indi.raw, "BIRT")!;
    applyEventNodeUpdate(indi.raw, eventNode, { date: "1901" }, noteCtx(ds.records));

    const out = serializeGedcom(ds.records);
    expect(out).toContain("2 DATE 1901");
    expect((out.match(/^2 NOTE /gm) ?? [])).toHaveLength(3);
  });

  it("are replaced as a list, keeping pointers and flags", () => {
    const ds = build(THREE);
    const indi = ds.individuals.get("@I1@")!;
    const birt = indi.events.find((e) => e.tag === "BIRT")!;
    const eventNode = firstChild(indi.raw, "BIRT")!;
    const ctx = noteCtx(ds.records);
    applyEventNodeUpdate(indi.raw, eventNode, {
      noteRefs: [
        ...birt.noteRefs!,
        { text: "a fourth note", private: true },
      ],
    }, ctx);

    const out = serializeGedcom(ds.records);
    expect((out.match(/^2 NOTE /gm) ?? [])).toHaveLength(4);
    expect(out).toContain("2 NOTE @N1@"); // the pointer survived as a pointer
    expect(out).toMatch(/2 NOTE a fourth note\n3 RESN privacy/);
    // The shared record is untouched — its text was not edited.
    expect(out).toContain("0 @N1@ NOTE a shared remark");
  });

  it("release a shared record when its last reference is dropped", () => {
    const ds = build(THREE);
    const indi = ds.individuals.get("@I1@")!;
    const birt = indi.events.find((e) => e.tag === "BIRT")!;
    const eventNode = firstChild(indi.raw, "BIRT")!;
    applyEventNodeUpdate(indi.raw, eventNode, {
      noteRefs: birt.noteRefs!.filter((r) => !r.xref),
    }, noteCtx(ds.records));

    const out = serializeGedcom(ds.records);
    expect(out).not.toContain("@N1@");
    expect((out.match(/^2 NOTE /gm) ?? [])).toHaveLength(2);
  });
});
