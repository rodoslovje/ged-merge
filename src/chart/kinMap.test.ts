import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { displayName, primaryName } from "../match/relatives";
import type { Individual } from "../gedcom/types";
import { collectKin } from "./kinshipWheel";
import { anchorPoint, placeKin } from "./kinMap";
import type { MapPoint } from "../geo/points";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const nameOf = (indi: Individual) => displayName(primaryName(indi));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

const KRANJ = { lat: 46.239, lon: 14.355 };
const DELNICE = { lat: 45.401, lon: 14.801 };
const LJUBLJANA = { lat: 46.05, lon: 14.51 };

function pt(tag: string, kind: MapPoint["kind"], coord: MapPoint["coord"], year?: number): MapPoint {
  return { personIds: ["@I1@"], tag, kind, place: tag, coord, ...(year !== undefined ? { year, dateKey: year * 10000 } : {}) };
}

describe("anchorPoint", () => {
  it("prefers the birth over anything dated earlier or later", () => {
    const birth = pt("BIRT", "birth", KRANJ, 1900);
    const resi = pt("RESI", "residence", DELNICE, 1890);
    expect(anchorPoint([resi, birth])).toBe(birth);
  });

  it("takes a christening when there is no birth, and the birth over it", () => {
    const chr = pt("CHR", "birth", KRANJ, 1900);
    const death = pt("DEAT", "death", DELNICE, 1970);
    expect(anchorPoint([death, chr])).toBe(chr);
    const birt = pt("BIRT", "birth", DELNICE);
    expect(anchorPoint([chr, birt])).toBe(birt);
  });

  it("falls back to the earliest dated event, then the death, then the burial", () => {
    const later = pt("RESI", "residence", DELNICE, 1930);
    const earlier = pt("MARR", "marriage", LJUBLJANA, 1925);
    const death = pt("DEAT", "death", KRANJ, 1970);
    const buri = pt("BURI", "burial", KRANJ, 1970);
    expect(anchorPoint([later, earlier, death])).toBe(earlier);
    expect(anchorPoint([death, buri])).toBe(death);
    expect(anchorPoint([buri])).toBe(buri);
  });

  it("uses an undated mid-life event only when nothing else is there", () => {
    const undated = pt("RESI", "residence", DELNICE);
    const death = pt("DEAT", "death", KRANJ, 1970);
    expect(anchorPoint([undated, death])).toBe(death);
    expect(anchorPoint([undated])).toBe(undated);
    expect(anchorPoint([])).toBeUndefined();
  });
});

describe("placeKin", () => {
  const MAP = (c: { lat: number; lon: number }) => `3 MAP\n4 LATI N${c.lat}\n4 LONG E${c.lon}\n`;
  // Root Ana: born in Kranj. Father Jožef: no birth place; the marriage in
  // Ljubljana — a family event, dated earlier than his death in Delnice — is
  // his anchor. Mother Marija: the marriage is her only coordinated event.
  // Brother Peter: a birth place, no coordinates. Sister Neža: no place at all.
  const TREE = wrap(
    `0 @I1@ INDI\n1 NAME Ana /Kovac/\n1 SEX F\n1 BIRT\n2 DATE 1900\n2 PLAC Kranj\n${MAP(KRANJ)}1 DEAT\n2 DATE 1975\n1 FAMC @F1@\n` +
      `0 @I2@ INDI\n1 NAME Jozef /Kovac/\n1 SEX M\n1 BIRT\n2 DATE 1870\n1 DEAT\n2 DATE 1940\n2 PLAC Delnice\n${MAP(DELNICE)}1 FAMS @F1@\n` +
      "0 @I3@ INDI\n1 NAME Marija /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1875\n1 DEAT\n2 DATE 1950\n1 FAMS @F1@\n" +
      "0 @I4@ INDI\n1 NAME Peter /Kovac/\n1 SEX M\n1 BIRT\n2 DATE 1902\n2 PLAC Delnice\n1 DEAT\n2 DATE 1960\n1 FAMC @F1@\n" +
      "0 @I5@ INDI\n1 NAME Neza /Kovac/\n1 SEX F\n1 BIRT\n2 DATE 1904\n1 DEAT\n2 DATE 1980\n1 FAMC @F1@\n" +
      `0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I1@\n1 CHIL @I4@\n1 CHIL @I5@\n1 MARR\n2 DATE 1898\n2 PLAC Ljubljana\n${MAP(LJUBLJANA)}`,
  );

  it("anchors each relative, and lists the rest by what they lack", () => {
    const ds = dataset(TREE);
    const people = collectKin({ ds, rootId: "@I1@", nameOf, now: 2026 });
    const { placed, noCoords, noPlace } = placeKin(ds, people);
    expect(placed.map((p) => [p.person.id, p.point.tag])).toEqual([
      ["@I1@", "BIRT"],
      ["@I2@", "MARR"],
      ["@I3@", "MARR"],
    ]);
    // The marriage is the family's event, but each spouse's dot is their own.
    expect(placed[1].point.personIds).toEqual(["@I2@"]);
    expect(placed[2].point.personIds).toEqual(["@I3@"]);
    expect(noCoords.map((p) => p.id)).toEqual(["@I4@"]);
    expect(noPlace.map((p) => p.id)).toEqual(["@I5@"]);
  });
});
