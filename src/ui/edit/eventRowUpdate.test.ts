import { describe, expect, it } from "vitest";
import { eventRowUpdate, spellUpdateFor, type RowFields } from "./eventRowUpdate";
import { applyEventNodeUpdate, setEventFieldAtIndex } from "../../gedcom/edit";
import { validateConformance } from "../../tools/conformance/conformance";
import { parseGedcom } from "../../gedcom/parser";
import { buildDataset } from "../../gedcom/builder";
import { serializeGedcom } from "../../gedcom/serialize";

const field = (initial: string, value = initial, isMerge = false) => ({ initial, value, isMerge });

function fields(over: Partial<RowFields> = {}): RowFields {
  return {
    date: field("1 JAN 1900"), sortDate: field(""), value: field(""), place: field("Kranj"), address: field("Glavni trg 1"),
    note: field(""), agency: field(""), type: field(""), cause: field(""), temple: field(""), status: field(""),
    age: field(""), husbandAge: field(""), wifeAge: field(""), ...over,
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

  it("sends an age that changed, and an address part from its own panel", () => {
    expect(eventRowUpdate(fields({ age: field("", "25y") }), {}, false, undefined)).toEqual({ age: "25y" });
    expect(eventRowUpdate(fields(), { addressParts: { CITY: "Kranj" } }, false, undefined))
      .toEqual({ addressParts: { CITY: "Kranj" } });
    expect(eventRowUpdate(fields(), { phone: "" }, false, undefined)).toEqual({ phone: "" });
  });

  it("keeps a flag-only event's hidden value when its value field is emptied", () => {
    expect(eventRowUpdate(fields({ value: field("", "", true) }), {}, true, "Y")).toBeNull();
    expect(eventRowUpdate(fields({ value: field("", "Y es") }), {}, true, "Y")).toEqual({ value: "Y es" });
    expect(eventRowUpdate(fields({ value: field("", ""), place: field("Kranj", "Bled") }), {}, true, "Y")).toEqual({ place: "Bled" });
  });
});

describe("spellUpdateFor", () => {
  const file = (version: string) => buildDataset(parseGedcom(new TextEncoder().encode(
    `0 HEAD\n1 GEDC\n2 VERS ${version}\n0 @I1@ INDI\n1 NAME Ana /Novak/\n1 BAPL\n2 DATE 1 JAN 1980\n0 TRLR\n`).buffer));

  it.each([["5.5.1", "PRE-1970"], ["7.0", "PRE_1970"]] as const)(
    "writes a typed ordinance status as strict %s spells it, and leaves it nothing to find",
    (version, spelled) => {
      const ds = file(version);
      const before = validateConformance(ds);
      const update = eventRowUpdate(fields({ status: field("", "pre-1970") }), {}, false, undefined)!;
      spellUpdateFor(update, version);
      expect(update.status).toBe(spelled);
      const indi = ds.individuals.get("@I1@")!;
      const bapl = indi.raw.children.find((c) => c.tag === "BAPL")!;
      applyEventNodeUpdate(indi.raw, bapl, update);
      expect(serializeGedcom(ds.records)).toContain(`2 STAT ${spelled}\n3 DATE `);
      expect(validateConformance(ds)).toEqual(before);
    },
  );

  it("leaves a status neither standard has as typed", () => {
    const update = { status: "Pending" };
    spellUpdateFor(update, "7.0");
    expect(update.status).toBe("Pending");
  });
});

describe("an event's time", () => {
  const file = (version: string, time = "") => buildDataset(parseGedcom(new TextEncoder().encode(
    `0 HEAD\n1 GEDC\n2 VERS ${version}\n0 @I1@ INDI\n1 NAME Ana /Novak/\n1 BIRT\n2 DATE 5 MAR 1850\n${time}0 TRLR\n`).buffer));
  const typeTime = (ds: ReturnType<typeof file>, version: "5.5.1" | "7.0", time: string) => {
    const update = eventRowUpdate(fields({ date: field("5 MAR 1850", `5 MAR 1850 ${time}`) }), {}, false, undefined)!;
    update.date = "5 MAR 1850";
    update.time = time;
    spellUpdateFor(update, version);
    const indi = ds.individuals.get("@I1@")!;
    applyEventNodeUpdate(indi.raw, indi.raw.children.find((c) => c.tag === "BIRT")!, update);
  };

  it.each([["5.5.1", "_TIME"], ["7.0", "TIME"]] as const)(
    "goes on the line strict %s has for it, and leaves it nothing to find",
    (version, tag) => {
      const ds = file(version);
      const before = validateConformance(ds);
      typeTime(ds, version, "14:30");
      const out = serializeGedcom(ds.records);
      expect(out).toContain(`2 DATE 5 MAR 1850\n3 ${tag} 14:30\n`);
      expect(validateConformance(ds)).toEqual(before);
      // And reads back as the event's time.
      const back = buildDataset(parseGedcom(new TextEncoder().encode(out).buffer));
      expect(back.individuals.get("@I1@")!.events.find((e) => e.tag === "BIRT")?.time).toBe("14:30");
    },
  );

  it("moves a time on the other version's line when it is edited", () => {
    const ds = file("5.5.1", "3 TIME 9:00\n");
    typeTime(ds, "5.5.1", "14:30");
    const out = serializeGedcom(ds.records);
    expect(out).toContain("3 _TIME 14:30\n");
    expect(out).not.toContain("3 TIME");
  });
});
