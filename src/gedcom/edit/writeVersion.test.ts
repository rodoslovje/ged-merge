import { describe, expect, it } from "vitest";
import { parseGedcom } from "../parser";
import { buildDataset } from "../builder";
import { serializeGedcom } from "../serialize";
import { noteCtx, setNotes } from "../edit";
import { setPrivateFlag } from "../private";
import { reshapeNotes } from "../../tools/noteReshape";
import { validateConformance } from "../../tools/conformance/conformance";

/**
 * The note and privacy writers take the version they write in from the
 * target, never from the file's header: a 5.5.1 file set to strict 7.0 stays
 * 5.5.1 while it is edited, and the save converts it.
 */

const file = (vers: string, ...body: string[]) =>
  buildDataset(parseGedcom(new TextEncoder().encode(["0 HEAD", "1 GEDC", `2 VERS ${vers}`, ...body, "0 TRLR", ""].join("\n")).buffer));

/** A file whose notes are shared records, so a new note is one too. */
const SHARED_NOTES = ["0 @I1@ INDI", "1 NAME Ana /Novak/", "1 NOTE @N1@", "1 BIRT", "2 DATE 1900", "0 @N1@ NOTE Old story"];

describe("the version notes are written in", () => {
  it("is the target's, whatever the header says", () => {
    const ds = file("5.5.1", ...SHARED_NOTES.map((l) => l.replace("NOTE @N1@", "SNOTE @N1@").replace("@N1@ NOTE", "@N1@ SNOTE")));
    const indi = ds.individuals.get("@I1@")!;
    setNotes(noteCtx(ds.records, "7.0"), indi, [...indi.noteRefs!, { text: "<p>New</p>" }]);
    const out = serializeGedcom(ds.records);
    expect(out).toContain("0 @N2@ SNOTE <p>New</p>\n1 MIME text/html");

    const ds2 = file("7.0", ...SHARED_NOTES);
    const indi2 = ds2.individuals.get("@I1@")!;
    setNotes(noteCtx(ds2.records, "5.5.1"), indi2, [...indi2.noteRefs!, { text: "<p>New</p>" }]);
    const out2 = serializeGedcom(ds2.records);
    expect(out2).toContain("0 @N2@ NOTE <p>New</p>");
    expect(out2).not.toContain("MIME");
  });

  it.each(["5.5.1", "7.0"] as const)("leaves a strict %s file nothing to find", (version) => {
    const tagged = version === "7.0"
      ? SHARED_NOTES.map((l) => l.replace("NOTE @N1@", "SNOTE @N1@").replace("@N1@ NOTE", "@N1@ SNOTE"))
      : SHARED_NOTES;
    const ds = file(version, ...tagged);
    const before = validateConformance(ds);
    const indi = ds.individuals.get("@I1@")!;
    setNotes(noteCtx(ds.records, version, "RESN"), indi, [...indi.noteRefs!, { text: "<p>Rich</p>" }]);
    const birt = indi.raw.children.find((c) => c.tag === "BIRT")!;
    setPrivateFlag(birt, true, "RESN", version);
    expect(validateConformance(ds)).toEqual(before);
  });
});

describe("the version a privacy marker is written in", () => {
  it("is the one given, not the header's", () => {
    const ds = file("5.5.1", "0 @I1@ INDI", "1 NAME Ana /Novak/");
    const raw = ds.individuals.get("@I1@")!.raw;
    setPrivateFlag(raw, true, "RESN", "7.0");
    expect(raw.children.find((c) => c.tag === "RESN")?.value).toBe("PRIVACY");
  });
});

describe("the version Normalize lifts a note in", () => {
  it.each(["5.5.1", "7.0"] as const)("is the target's: strict %s finds nothing in it", (version) => {
    const ds = file(version, "0 @I1@ INDI", "1 NAME Ana /Novak/", "1 NOTE An inline note");
    const before = validateConformance(ds);
    expect(reshapeNotes(ds.records, "shared", version).changed).toBe(1);
    const out = serializeGedcom(ds.records);
    expect(out).toContain(version === "7.0" ? "1 SNOTE @N1@" : "1 NOTE @N1@");
    expect(validateConformance(ds)).toEqual(before);
  });

  it("does not read the header", () => {
    const ds = file("5.5.1", "0 @I1@ INDI", "1 NAME Ana /Novak/", "1 NOTE An inline note");
    reshapeNotes(ds.records, "shared", "7.0");
    expect(serializeGedcom(ds.records)).toContain("0 @N1@ SNOTE An inline note");
  });
});
