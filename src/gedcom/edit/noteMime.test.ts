import { describe, expect, it } from "vitest";
import { parseGedcom } from "../parser";
import { buildDataset } from "../builder";
import { serializeGedcom } from "../serialize";
import { noteCtx, setNotes } from "../edit";

function buildFromText(lines: string[]) {
  const buf = new TextEncoder().encode(lines.join("\n"));
  return buildDataset(parseGedcom(buf.buffer));
}

const file = (vers: string, note: string) => [
  "0 HEAD",
  "1 GEDC",
  `2 VERS ${vers}`,
  "0 @I1@ INDI",
  "1 NAME Ana /Novak/",
  `1 NOTE ${note}`,
  "0 TRLR",
];

describe("a rich-text note's MIME line", () => {
  it("is written under an HTML note in a GEDCOM 7 file, and dropped when the note goes plain", () => {
    const ds = buildFromText(file("7.0", "plain"));
    const indi = ds.individuals.get("@I1@")!;
    setNotes(noteCtx(ds.records), indi, [{ text: "<p>Rodil se je <b>doma</b>.</p>" }]);
    expect(serializeGedcom(ds.records)).toContain("1 NOTE <p>Rodil se je <b>doma</b>.</p>\n2 MIME text/html");

    setNotes(noteCtx(ds.records), indi, [{ text: "doma" }]);
    const out = serializeGedcom(ds.records);
    expect(out).toContain("1 NOTE doma");
    expect(out).not.toContain("MIME");
  });

  it("is never written into a 5.5.1 file, which has no such line", () => {
    const ds = buildFromText(file("5.5.1", "plain"));
    const indi = ds.individuals.get("@I1@")!;
    setNotes(noteCtx(ds.records), indi, [{ text: "<p>Rodil se je <b>doma</b>.</p>" }]);
    const out = serializeGedcom(ds.records);
    expect(out).toContain("1 NOTE <p>Rodil se je <b>doma</b>.</p>");
    expect(out).not.toContain("MIME");
  });
});
