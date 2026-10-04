import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { placeAddrKey } from "./geocode";
import { buildPlaceAddrUses, personsOfRecord } from "./places";

function dataset(body: string) {
  const text = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

/** Two neighbours at one house, a third at the same place without an address,
 *  and the couple's marriage on the family record — the four shapes the
 *  coordinate panel's list has to tell apart. */
const NEIGHBOURS = dataset(
  `0 @I1@ INDI\n1 NAME Franciska /Renka/\n1 BIRT\n2 PLAC Ravna Gora, Croatia\n2 ADDR Ravna Gora 227\n` +
    `1 DEAT\n2 PLAC Ravna Gora, Croatia\n2 ADDR Ravna Gora 227\n` +
    `0 @I2@ INDI\n1 NAME Josip /Renko/\n1 BIRT\n2 PLAC Ravna Gora, Croatia\n2 ADDR Ravna Gora 227\n` +
    `1 FAMS @F1@\n` +
    `0 @I3@ INDI\n1 NAME Ana /Renko/\n1 BIRT\n2 PLAC Ravna Gora, Croatia\n` +
    `0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I1@\n1 MARR\n2 PLAC Ravna Gora, Croatia\n2 ADDR Ravna Gora 227\n`,
);

const at = (place: string, addr: string) => buildPlaceAddrUses(NEIGHBOURS).get(placeAddrKey(place, addr));

describe("who the file puts at a place and address", () => {
  it("lists every record at the pair, once each, however many events it writes there", () => {
    const uses = at("Ravna Gora, Croatia", "Ravna Gora 227");
    // Two events for @I1@, one each for @I2@ and the family.
    expect(uses?.events).toBe(4);
    expect(uses?.records.map((r) => r.id)).toEqual(["@I1@", "@I2@", "@F1@"]);
  });

  it("keeps every kind of event a record writes at the pair", () => {
    const uses = at("Ravna Gora, Croatia", "Ravna Gora 227");
    // Born and died at the house: one line, both marks.
    expect(uses?.records[0].eventTags).toEqual(["BIRT", "DEAT"]);
    expect(uses?.records[1].eventTags).toEqual(["BIRT"]);
    expect(uses?.records[2].eventTags).toEqual(["MARR"]);
  });

  it("keeps an event without an address apart from the house's own", () => {
    expect(at("Ravna Gora, Croatia", "")?.records.map((r) => r.id)).toEqual(["@I3@"]);
  });

  it("answers nothing for a pair the file never writes", () => {
    expect(at("Ravna Gora, Croatia", "Ravna Gora 1")).toBeUndefined();
  });

  it("lists every record at the pair, however many a village holds", () => {
    const many = dataset(
      Array.from({ length: 200 }, (_, i) => `0 @I${i}@ INDI\n1 BIRT\n2 PLAC Kranj\n`).join(""),
    );
    const uses = buildPlaceAddrUses(many).get(placeAddrKey("Kranj", ""));
    expect(uses?.records).toHaveLength(200);
    expect(uses?.records[199].id).toBe("@I199@");
  });
});

describe("the people a record is listed as", () => {
  it("is the person themselves for an individual", () => {
    expect(personsOfRecord(NEIGHBOURS, "@I1@").map((p) => p.id)).toEqual(["@I1@"]);
  });

  it("is both spouses for a family", () => {
    expect(personsOfRecord(NEIGHBOURS, "@F1@").map((p) => p.id)).toEqual(["@I2@", "@I1@"]);
  });

  it("is nobody for a record that is neither", () => {
    expect(personsOfRecord(NEIGHBOURS, "@S1@")).toEqual([]);
  });
});
