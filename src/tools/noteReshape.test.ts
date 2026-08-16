import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { detectNoteShapes, reshapeNotes, sharedNotesUsedTwice } from "./noteReshape";

const parse = (lines: string[]) => parseGedcom(new TextEncoder().encode(lines.join("\n")).buffer).records;
const out = (lines: string[], ...args: Parameters<typeof reshapeNotes> extends [unknown, ...infer R] ? R : never) => {
  const records = parse(lines);
  const result = reshapeNotes(records, ...args);
  return { text: serializeGedcom(records), ...result };
};

const MIXED = [
  "0 HEAD",
  "1 GEDC",
  "2 VERS 5.5.1",
  "0 @I1@ INDI",
  "1 NAME Janez /Novak/",
  "1 NOTE a record note",
  "2 PRIV",
  "1 BIRT",
  "2 DATE 1900",
  "2 NOTE an event note",
  "0 @I2@ INDI",
  "1 NAME Ana /Kos/",
  "1 NOTE @N1@",
  "0 @N1@ NOTE a shared note",
  "1 PRIV",
  "0 TRLR",
  "",
];

describe("reshapeNotes — inline to shared", () => {
  it("lifts an inline note into a record and leaves a pointer", () => {
    const { text, changed } = out(MIXED, "shared");
    expect(changed).toBe(2); // the record note and the event note
    expect(text).toMatch(/1 NOTE @N\d+@\n1 BIRT/);
    expect(text).toContain("0 @N2@ NOTE a record note");
    expect(text).toContain("0 @N3@ NOTE an event note");
  });

  it("takes the note's privacy marker with it", () => {
    // The flag belongs to the note, and on a pointer note the note is the
    // record — so it has to move to the record or it is lost.
    const { text } = out(MIXED, "shared");
    expect(text).toMatch(/0 @N2@ NOTE a record note\n1 PRIV/);
    expect(text).not.toMatch(/1 NOTE @N2@\n2 PRIV/);
  });

  it("leaves notes already shared alone", () => {
    const { text } = out(MIXED, "shared");
    expect(text).toContain("0 @N1@ NOTE a shared note");
    expect(text).toContain("1 NOTE @N1@");
  });

  it("honours the scope, so one level can be converted without the other", () => {
    const { text, changed } = out(MIXED, "shared", { record: true, event: false });
    expect(changed).toBe(1);
    expect(text).toContain("2 NOTE an event note"); // the event's note untouched
    expect(text).toContain("0 @N2@ NOTE a record note");
  });
});

describe("reshapeNotes — shared to inline", () => {
  it("copies the text back and deletes the record nothing points at", () => {
    const { text, changed } = out(MIXED, "inline");
    expect(changed).toBe(1);
    expect(text).toContain("1 NOTE a shared note");
    expect(text).not.toContain("0 @N1@ NOTE");
  });

  it("carries the record's privacy flag onto the note it becomes", () => {
    const { text } = out(MIXED, "inline");
    expect(text).toMatch(/1 NOTE a shared note\n2 PRIV/);
  });

  it("drops the record's own CHAN/CREA rather than hanging it on a note", () => {
    // Those stamps are the *record's* history; once the record is gone they
    // describe nothing, and copying them onto a note would claim the note was
    // edited when it was not.
    const { text } = out([
      "0 HEAD",
      "0 @I1@ INDI",
      "1 NOTE @N1@",
      "0 @N1@ NOTE a shared note",
      "1 CHAN",
      "2 DATE 20 DEC 2025",
      "0 TRLR",
      "",
    ], "inline");
    expect(text).toContain("1 NOTE a shared note");
    expect(text).not.toContain("CHAN");
  });

  it("starts the text on the NOTE line even when the record started it on a CONT", () => {
    // MacFamilyTree writes "0 @N1@ NOTE" + "1 CONT text", so the record's value
    // begins with a newline. Carried over verbatim that flattens to a bare
    // "1 NOTE" with the text on a CONT beneath — the record's layout, not the
    // note's content.
    const { text } = out([
      "0 HEAD",
      "0 @I1@ INDI",
      "1 NOTE @N1@",
      "0 @N1@ NOTE",
      "1 CONT https://example.com/x",
      "0 TRLR",
      "",
    ], "inline");
    expect(text).toContain("1 NOTE https://example.com/x");
    expect(text).not.toMatch(/^1 NOTE$/m);
  });

  it("keeps the record while another referrer still points at it", () => {
    // Flattening only one of two referrers must not delete the record the
    // other one still needs.
    const records = parse([
      "0 HEAD",
      "0 @I1@ INDI",
      "1 NOTE @N1@",
      "0 @I2@ INDI",
      "1 NOTE @N1@",
      "0 @N1@ NOTE shared by two",
      "0 TRLR",
      "",
    ]);
    const { changed } = reshapeNotes(records, "inline");
    const text = serializeGedcom(records);
    expect(changed).toBe(2);
    // Both referrers flattened, so the record really is orphaned and goes.
    expect(text).not.toContain("0 @N1@ NOTE");
    expect(text.match(/1 NOTE shared by two/g)).toHaveLength(2);
  });

  it("leaves a dangling pointer alone rather than inventing text for it", () => {
    const { text, changed } = out([
      "0 HEAD",
      "0 @I1@ INDI",
      "1 NOTE @NOPE@",
      "0 TRLR",
      "",
    ], "inline");
    expect(changed).toBe(0);
    expect(text).toContain("1 NOTE @NOPE@");
  });
});

describe("detectNoteShapes", () => {
  it("reads the two levels separately", () => {
    // The shape of the user's own file: records shared, events inline.
    expect(detectNoteShapes(parse([
      "0 HEAD",
      "0 @I1@ INDI",
      "1 NOTE @N1@",
      "1 NOTE @N2@",
      "1 BIRT",
      "2 NOTE an event note",
      "0 @N1@ NOTE one",
      "0 @N2@ NOTE two",
      "0 TRLR",
      "",
    ]))).toEqual({ record: "shared", event: "inline" });
  });

  it("calls a file with no notes at all inline", () => {
    expect(detectNoteShapes(parse(["0 HEAD", "0 @I1@ INDI", "0 TRLR", ""])))
      .toEqual({ record: "inline", event: "inline" });
  });
});

describe("sharedNotesUsedTwice", () => {
  it("counts the notes more than one record points at", () => {
    expect(sharedNotesUsedTwice(parse([
      "0 HEAD",
      "0 @I1@ INDI",
      "1 NOTE @N1@",
      "0 @I2@ INDI",
      "1 NOTE @N1@",
      "1 NOTE @N2@",
      "0 @N1@ NOTE shared by two",
      "0 @N2@ NOTE used once",
      "0 TRLR",
      "",
    ]))).toBe(1);
  });
});
