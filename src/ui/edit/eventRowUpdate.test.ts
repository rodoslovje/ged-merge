import { describe, expect, it } from "vitest";
import { eventRowUpdate, type RowFields } from "./eventRowUpdate";
import { setEventFieldAtIndex } from "../../gedcom/edit";
import { parseGedcom } from "../../gedcom/parser";
import { buildDataset } from "../../gedcom/builder";
import { serializeGedcom } from "../../gedcom/serialize";

const field = (initial: string, value = initial, isMerge = false) => ({ initial, value, isMerge });

function fields(over: Partial<RowFields> = {}): RowFields {
  return {
    date: field("1 JAN 1900"), value: field(""), place: field("Kranj"), address: field("Glavni trg 1"),
    note: field(""), agency: field(""), type: field(""), cause: field(""), temple: field(""), status: field(""), ...over,
  };
}

// Regression: every commit re-sent all of the row's fields, and each is
// written as one line per tag — editing the place dropped an event's second
// `2 DATE` and second `2 ADDR`, and trimmed the spaces of untouched values.
describe("eventRowUpdate", () => {
  it("sends only the fields that changed", () => {
    expect(eventRowUpdate(fields({ place: field("Kranj", "Kranj, Slovenija") }), {}, false, undefined))
      .toEqual({ place: "Kranj, Slovenija" });
  });

  it("an edited place leaves duplicate lines and spacing of other fields alone", () => {
    const text = [
      "0 HEAD", "0 @I1@ INDI", "1 BIRT", "2 DATE 1 JAN 1900", "2 DATE ABT 1900", "2 PLAC Kranj",
      "2 ADDR Glavni trg 1  ", "2 ADDR Glavni trg 2", "0 TRLR",
    ].join("\n");
    const ds = buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
    const update = eventRowUpdate(fields({ place: field("Kranj", "Škofja Loka") }), {}, false, undefined)!;
    setEventFieldAtIndex(ds.individuals.get("@I1@")!, 0, update);
    const out = serializeGedcom(ds.records);
    expect(out).toContain("2 DATE 1 JAN 1900\n2 DATE ABT 1900\n2 PLAC Škofja Loka\n2 ADDR Glavni trg 1  \n2 ADDR Glavni trg 2");
  });

  it("still sends an untouched merge suggestion, and nothing at all when nothing changed", () => {
    expect(eventRowUpdate(fields({ date: field("1900", "1900", true) }), { note: "x" }, false, undefined))
      .toEqual({ date: "1900", note: "x" });
    expect(eventRowUpdate(fields(), {}, false, undefined)).toBeNull();
    expect(eventRowUpdate(fields(), { coord: null }, false, undefined)).toEqual({ coord: null });
  });

  it("keeps a flag-only event's hidden value when its value field is emptied", () => {
    expect(eventRowUpdate(fields({ value: field("", "", true) }), {}, true, "Y")).toBeNull();
    expect(eventRowUpdate(fields({ value: field("", "Y es") }), {}, true, "Y")).toEqual({ value: "Y es" });
    expect(eventRowUpdate(fields({ value: field("", ""), place: field("Kranj", "Bled") }), {}, true, "Y")).toEqual({ place: "Bled" });
  });
});
