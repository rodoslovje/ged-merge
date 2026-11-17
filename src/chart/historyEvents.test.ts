import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { en } from "../locales/en";
import { sl } from "../locales/sl";
import { HISTORY_EVENTS, historyCountries, historyKey, historyPresence, historyYears, pickHistoryEvents } from "./historyEvents";

function ds(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const FILE = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Janez /Novak/
1 BIRT
2 DATE 1840
2 PLAC Golnik
0 @I2@ INDI
1 NAME John /Novak/
1 BIRT
2 DATE 1870
2 PLAC Kranj, Slovenija
1 DEAT
2 DATE 1950
2 PLAC Cleveland, Ohio, USA
0 @I3@ INDI
1 NAME Nobody /Placeless/
0 TRLR
`;

const ids = (events: { id: string }[]) => events.map((e) => e.id);

describe("historyPresence", () => {
  it("reads countries from places, a bare place standing at home", () => {
    const d = ds(FILE);
    const rows = [
      { id: "@I1@", from: 1840, to: 1900 },
      { id: "@I2@", from: 1870, to: 1950 },
      { id: "@I3@" },
    ];
    const p = historyPresence(d, rows, "si");
    expect(p).toHaveLength(2);
    expect([...p[0].countries]).toEqual(["si"]);
    expect([...p[1].countries].sort()).toEqual(["si", "us"]);
    // Without a home country the bare village says nothing.
    expect([...historyPresence(d, rows, "")[0].countries]).toEqual([]);
  });
});

describe("pickHistoryEvents", () => {
  it("shows a country's events only while someone lived there", () => {
    const slovene = [{ countries: new Set(["si"]), from: 1840, to: 1900 }];
    const picked = ids(pickHistoryEvents(slovene, 1800, 1960));
    expect(picked).toContain("revolutions1848");
    expect(picked).toContain("ljubljanaQuake");
    expect(picked).toContain("ww1"); // world-wide, in range
    expect(picked).not.toContain("isonzo"); // nobody in Slovenia by then
    expect(picked).not.toContain("usCivilWar");

    const american = [{ countries: new Set(["us"]), from: 1850, to: 1930 }];
    const us = ids(pickHistoryEvents(american, 1800, 1960));
    expect(us).toContain("usCivilWar");
    expect(us).toContain("ellisIsland");
    expect(us).not.toContain("illyria");
    expect(us).not.toContain("revolutions1848");
  });

  it("names the countries of an enlargement the people lived in", () => {
    const family = [
      { countries: new Set(["si"]), from: 1950, to: 2026 },
      { countries: new Set(["at"]), from: 1930, to: 1990 },
    ];
    const eu = pickHistoryEvents(family, 1900, 2030).filter((e) => e.id === "euJoin");
    // Slovenia's 2004 only: the Austrian died before Austria's 1995.
    expect(eu.map((e) => e.from)).toEqual([2004]);
    expect(historyCountries(eu[0], family)).toEqual(["si"]);
    expect(historyKey(eu[0])).toBe("euJoin-2004");
  });

  it("keeps to the axis", () => {
    expect(ids(pickHistoryEvents([], 1900, 1950))).toEqual(["ww1", "spanishFlu", "depression", "ww2"]);
  });
});

describe("historyYears", () => {
  it("shortens a span within one century", () => {
    expect(historyYears({ id: "a", from: 1914, to: 1918, where: "world" })).toBe("1914–18");
    expect(historyYears({ id: "a", from: 1789, to: 1815, where: "world" })).toBe("1789–1815");
    expect(historyYears({ id: "a", from: 1848, where: "world" })).toBe("1848");
  });
});

describe("HISTORY_EVENTS", () => {
  it("is in year order with a label in both languages", () => {
    const years = HISTORY_EVENTS.map((e) => e.from);
    expect(years).toEqual([...years].sort((a, b) => a - b));
    for (const e of HISTORY_EVENTS) {
      expect(en[`history.${e.id}` as keyof typeof en], e.id).toBeTruthy();
      expect(sl[`history.${e.id}` as keyof typeof sl], e.id).toBeTruthy();
    }
  });
});
