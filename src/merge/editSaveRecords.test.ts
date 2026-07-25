import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { buildEditSaveRecords } from "./editSaveRecords";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// @I1@'s events are deliberately out of chronological order, so a sort is
// observable; @I2@'s are too, but it is never eligible.
const MAIN = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
    "1 DEAT\n2 DATE 1920\n1 BIRT\n2 DATE 1850\n" +
    "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n" +
    "1 DEAT\n2 DATE 1930\n1 BIRT\n2 DATE 1855\n",
);

const eventTags = (record: { children: { tag: string }[] }) =>
  record.children.map((c) => c.tag).filter((tag) => tag === "BIRT" || tag === "DEAT");

const all = () => true;
const none = () => false;

describe("buildEditSaveRecords", () => {
  it("never mutates the records it is given", () => {
    const ds = dataset(MAIN);
    const before = serializeGedcom(ds.records, { eol: ds.eol, finalNewline: ds.finalNewline });

    buildEditSaveRecords(ds.records, all);

    const after = serializeGedcom(ds.records, { eol: ds.eol, finalNewline: ds.finalNewline });
    expect(after).toBe(before);
  });

  it("returns records that share no node identity with the input", () => {
    const ds = dataset(MAIN);
    const out = buildEditSaveRecords(ds.records, all);

    expect(out).toHaveLength(ds.records.length);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).not.toBe(ds.records[i]);
      for (let j = 0; j < out[i].children.length; j++) {
        expect(out[i].children[j]).not.toBe(ds.records[i].children[j]);
      }
    }
  });

  it("mutating the returned records leaves the live dataset untouched", () => {
    const ds = dataset(MAIN);
    const before = serializeGedcom(ds.records, { eol: ds.eol, finalNewline: ds.finalNewline });

    const out = buildEditSaveRecords(ds.records, all);
    // Stand in for the in-place edits the save pipeline applies after this
    // point (stampChanCrea / ensureUtf8Charset).
    for (const r of out) r.children.push({ level: 1, tag: "NOTE", value: "touched", children: [] });

    expect(serializeGedcom(ds.records, { eol: ds.eol, finalNewline: ds.finalNewline })).toBe(before);
  });

  it("sorts an eligible individual's events into canonical order", () => {
    const ds = dataset(MAIN);
    const out = buildEditSaveRecords(ds.records, (xref) => xref === "@I1@");

    const i1 = out.find((r) => r.xref === "@I1@")!;
    expect(eventTags(i1)).toEqual(["BIRT", "DEAT"]);
  });

  it("leaves an ineligible individual's event order exactly as it was", () => {
    const ds = dataset(MAIN);
    const out = buildEditSaveRecords(ds.records, (xref) => xref === "@I1@");

    // @I2@ is not eligible: a bulk operation (e.g. a place rename) must not
    // silently reorder events that were already in a non-canonical position.
    const i2 = out.find((r) => r.xref === "@I2@")!;
    expect(eventTags(i2)).toEqual(["DEAT", "BIRT"]);
  });

  it("clones without reordering when nothing is eligible", () => {
    const ds = dataset(MAIN);
    const out = buildEditSaveRecords(ds.records, none);

    for (const r of out) expect(eventTags(r)).toEqual(eventTags(ds.records.find((x) => x.xref === r.xref) ?? r));
  });

  it("handles an empty record list", () => {
    expect(buildEditSaveRecords([], all)).toEqual([]);
  });
});
