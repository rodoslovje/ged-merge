import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { INDI_CHILD_ORDER } from "../gedcom/edit/shared";
import type { FieldChoice } from "../review/types";
import { materializeRecordField, type RecordField } from "./applyFields";
import { familyMergePreview, personMergePreview } from "./recordPreview";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 7.0\n1 CHAR UTF-8\n${body}0 TRLR\n`;

const MAIN = wrap(
  "0 @I1@ INDI\n1 NAME Marija /Zaletel/\n2 NICK Mica\n1 SEX F\n1 NOTE Own note\n1 _FID AAAA-111\n" +
    "0 @F1@ FAM\n1 WIFE @I1@\n1 NOTE Own family note\n",
);
const INCOMING = wrap(
  "0 @P1@ INDI\n1 NAME Marina /Zaletel/\n2 NICK Mina\n2 TRAN Maria /Saletel/\n3 LANG la\n1 SEX M\n1 RESN PRIVACY\n" +
    "1 NOTE Register note\n1 _FID BBBB-222\n1 EXID 12345\n2 TYPE https://example.org/p/\n1 NO CHR\n" +
    "0 @G1@ FAM\n1 WIFE @P1@\n1 NOTE Family note\n1 NO DIV\n1 RESN PRIVACY\n",
);

const pick = (choices: Record<string, FieldChoice>) => (field: string) => choices[field];

describe("personMergePreview", () => {
  const main = dataset(MAIN);
  const compare = dataset(INCOMING);
  const person = main.individuals.get("@I1@")!;
  const incoming = compare.individuals.get("@P1@")!;

  it("previews nothing for rows held at main", () => {
    expect(personMergePreview(person, incoming, () => undefined)).toEqual({});
  });

  it("names each value the save writes and what it replaces", () => {
    const p = personMergePreview(person, incoming, pick({
      sex: "incoming", nickname: "incoming", nameTranslations: "incoming", fsid: "incoming",
      exid: "incoming", noEvents: "incoming", notes: "incoming", private: "incoming",
    }));
    expect(p.sex).toBe("M");
    expect(p.nickname).toBe("Mina");
    expect(p.translations?.map((tr) => tr.full)).toEqual(["Maria Saletel"]);
    expect(p.fsids).toEqual({ ids: ["BBBB-222"], replacesFirst: true });
    expect(p.exids?.map((x) => x.id)).toEqual(["12345"]);
    expect(p.noEvents?.map((a) => a.tag)).toEqual(["CHR"]);
    expect(p.notes?.notes.map((n) => n.text)).toEqual(["Register note"]);
    expect(p.notes?.replaces).toBe(true);
    expect(p.private).toBe(true);
  });

  it("keeps the person's own notes and ids beside the incoming ones under \"both\"", () => {
    const p = personMergePreview(person, incoming, pick({ notes: "both", fsid: "both" }));
    expect(p.notes?.replaces).toBe(false);
    expect(p.fsids?.replacesFirst).toBe(false);
  });

  // The preview is only worth showing if it is what the save writes: take each
  // row over with the save's own code and read the record back.
  it.each<[RecordField, FieldChoice]>([
    ["notes", "incoming"], ["notes", "both"], ["fsid", "incoming"], ["fsid", "both"],
    ["nickname", "incoming"], ["sex", "incoming"], ["exid", "incoming"], ["noEvents", "incoming"],
    ["nameTranslations", "incoming"], ["private", "incoming"],
  ])("matches what the save writes for %s (%s)", (field, choice) => {
    const target = dataset(MAIN);
    const before = target.individuals.get("@I1@")!;
    const p = personMergePreview(before, incoming, pick({ [field]: choice }));
    materializeRecordField(target, compare, before.raw, incoming.raw, field, choice, INDI_CHILD_ORDER);
    const after = dataset(serializeGedcom(target.records)).individuals.get("@I1@")!;
    switch (field) {
      case "notes": {
        const own = p.notes!.replaces ? [] : (before.noteRefs ?? []).map((n) => n.text);
        expect(after.noteRefs?.map((n) => n.text)).toEqual([...own, ...p.notes!.notes.map((n) => n.text)]);
        break;
      }
      case "fsid": {
        const own = before.fsids ?? [];
        const kept = p.fsids!.replacesFirst ? own.slice(1) : own;
        expect([...(after.fsids ?? [])].sort()).toEqual([...kept, ...p.fsids!.ids].sort());
        break;
      }
      case "nickname": expect(after.names[0].nickname).toBe(p.nickname); break;
      case "sex": expect(after.sex).toBe(p.sex); break;
      case "exid": expect(after.exids).toEqual([...(before.exids ?? []), ...p.exids!].map((x) => ({ ...x }))); break;
      case "noEvents": expect(after.noEvents?.map((a) => a.tag)).toEqual(p.noEvents!.map((a) => a.tag)); break;
      case "nameTranslations": expect(after.names[0].translations?.map((tr) => tr.full)).toEqual(p.translations!.map((tr) => tr.full)); break;
      case "private": expect(after.private).toBe(p.private); break;
    }
  });
});

describe("familyMergePreview", () => {
  it("previews a family's note, private flag and \"did not happen\" statements", () => {
    const main = dataset(MAIN).families.get("@F1@")!;
    const incoming = dataset(INCOMING).families.get("@G1@")!;
    const p = familyMergePreview(main, incoming, pick({ notes: "both", private: "incoming", noEvents: "incoming" }));
    expect(p.notes).toEqual({ notes: [expect.objectContaining({ text: "Family note" })], replaces: false });
    expect(p.private).toBe(true);
    expect(p.noEvents?.map((a) => a.tag)).toEqual(["DIV"]);
  });
});
