import { describe, expect, it } from "vitest";
import { parseDate, dateRefines, dateToSortKey } from "./date";

describe("parseDate — Slovenian/German month words", () => {
  it("parses Slovenian months (nominative, genitive, abbreviations)", () => {
    expect(parseDate("5 maj 1989")).toMatchObject({ day: 5, month: 5, year: 1989 });
    expect(parseDate("21. marca 2011")).toMatchObject({ day: 21, month: 3, year: 2011 });
    expect(parseDate("avgust 1900")).toMatchObject({ month: 8, year: 1900 });
    expect(parseDate("5 okt 1850")).toMatchObject({ day: 5, month: 10, year: 1850 });
  });

  it("parses German months", () => {
    expect(parseDate("3 Mai 1900")).toMatchObject({ day: 3, month: 5, year: 1900 });
    expect(parseDate("12 Dez 1899")).toMatchObject({ day: 12, month: 12, year: 1899 });
  });

  it("parses month-first and hyphenated forms", () => {
    expect(parseDate("AVG 31 1897")).toMatchObject({ day: 31, month: 8, year: 1897 });
    expect(parseDate("okt 7 2019")).toMatchObject({ day: 7, month: 10, year: 2019 });
    expect(parseDate("10-JUL-2016")).toMatchObject({ day: 10, month: 7, year: 2016 });
  });
});

describe("parseDate — before/after operators and Slovenian qualifiers", () => {
  it("maps < and > to before/after", () => {
    expect(parseDate("<1901")).toMatchObject({ qualifier: "before", year: 1901 });
    expect(parseDate(">13 DEC 1949")).toMatchObject({
      qualifier: "after", day: 13, month: 12, year: 1949,
    });
  });

  it("understands Slovenian qualifier words", () => {
    expect(parseDate("OKOLI 1850")).toMatchObject({ qualifier: "about", year: 1850 });
    expect(parseDate("Približno 1880")).toMatchObject({ qualifier: "about", year: 1880 });
    expect(parseDate("PRED 1900")).toMatchObject({ qualifier: "before", year: 1900 });
  });
});

describe("parseDate — partial dates with placeholders", () => {
  it("keeps the year when day/month are unknown", () => {
    expect(parseDate(".__.1945")).toMatchObject({ qualifier: "exact", year: 1945 });
    expect(parseDate("__.__.1945")).toMatchObject({ year: 1945 });
    expect(parseDate("__.<>.1780")).toMatchObject({ year: 1780 });
  });

  it("keeps a known month with an unknown day", () => {
    expect(parseDate("_.9.1911")).toMatchObject({ month: 9, year: 1911 });
    expect(parseDate("--.7.2011")).toMatchObject({ month: 7, year: 2011 });
  });

  it("leaves fully-unknown placeholder dates as unknown", () => {
    expect(parseDate(".__.____").qualifier).toBe("unknown");
    expect(parseDate("____").qualifier).toBe("unknown");
    expect(parseDate(".__.19__").qualifier).toBe("unknown");
  });

  it("flags a structured all-unknown date so reshape can re-render it", () => {
    expect(parseDate(".__.____")).toMatchObject({ qualifier: "unknown", placeholder: true });
    expect(parseDate("__.__.____")).toMatchObject({ qualifier: "unknown", placeholder: true });
    // A lone token or a partly-known year is not a structured placeholder date.
    expect(parseDate("____").placeholder).toBeUndefined();
    expect(parseDate(".__.19__").placeholder).toBeUndefined();
  });
});

describe("parseDate — ranges, dual dating, parentheses", () => {
  it("treats a year–year span as a period", () => {
    expect(parseDate("1790-1803")).toMatchObject({
      qualifier: "between", year: 1790, year2: 1803,
    });
    expect(parseDate("1770/1785")).toMatchObject({
      qualifier: "between", year: 1770, year2: 1785,
    });
  });

  it("takes the first year of an old/new-style dual date", () => {
    expect(parseDate("2 FEB 1746/47")).toMatchObject({ day: 2, month: 2, year: 1746 });
    expect(parseDate("1850/83")).toMatchObject({ year: 1850 });
  });

  it("unwraps a date in parentheses", () => {
    expect(parseDate("(ABT 1810)")).toMatchObject({ qualifier: "about", year: 1810 });
    expect(parseDate("(okt 7 2019)")).toMatchObject({ day: 7, month: 10, year: 2019 });
  });

  it("still rejects genuine junk", () => {
    expect(parseDate("xxx-template").qualifier).toBe("unknown");
    expect(parseDate("Y").qualifier).toBe("unknown");
    expect(parseDate("BREZ IZOBRAZBE").qualifier).toBe("unknown");
  });
});

describe("parseDate — existing forms still work", () => {
  it("keeps English/numeric parsing intact", () => {
    expect(parseDate("12 FEB 1900")).toMatchObject({ day: 12, month: 2, year: 1900 });
    expect(parseDate("ABT 1900")).toMatchObject({ qualifier: "about", year: 1900 });
    expect(parseDate("20.02.1989", "DMY")).toMatchObject({ day: 20, month: 2, year: 1989 });
    expect(parseDate("BET 1900 AND 1905")).toMatchObject({
      qualifier: "between", year: 1900, year2: 1905,
    });
  });
});

describe("dateRefines — incoming is a more exact same date", () => {
  it("treats a full date as refining a year-only one", () => {
    expect(dateRefines("1949", "12 MAR 1949")).toBe(true);
    expect(dateRefines("1949", "MAR 1949")).toBe(true);
    expect(dateRefines("MAR 1949", "12 MAR 1949")).toBe(true);
    expect(dateRefines("ABT 1949", "12 MAR 1949")).toBe(true);
  });

  it("treats an exact assertion as refining the same about date", () => {
    expect(dateRefines("ABT 12 MAR 1949", "12 MAR 1949")).toBe(true);
  });

  it("does not refine when components contradict", () => {
    expect(dateRefines("12 MAR 1949", "13 MAR 1949")).toBe(false);
    expect(dateRefines("JAN 1949", "12 MAR 1949")).toBe(false);
    expect(dateRefines("1949", "12 MAR 1950")).toBe(false);
  });

  it("does not refine when incoming is equal or less precise", () => {
    expect(dateRefines("12 MAR 1949", "12 MAR 1949")).toBe(false);
    expect(dateRefines("12 MAR 1949", "1949")).toBe(false);
  });

  it("leaves ranges to the default", () => {
    expect(dateRefines("BET 1949 AND 1950", "12 MAR 1949")).toBe(false);
  });
});

describe("parseDate — calendar declarations", () => {
  it("reads a Julian date through either spelling of the declaration", () => {
    // 5.5.1 writes the escape, GEDCOM 7 the bare keyword; same date either way.
    expect(parseDate("@#DJULIAN@ 14 JAN 1700")).toMatchObject({
      qualifier: "exact", calendar: "JULIAN", day: 14, month: 1, year: 1700,
    });
    expect(parseDate("JULIAN 14 JAN 1700")).toMatchObject({
      qualifier: "exact", calendar: "JULIAN", day: 14, month: 1, year: 1700,
    });
  });

  it("accepts a declaration sitting after the qualifier", () => {
    expect(parseDate("ABT @#DJULIAN@ 1700")).toMatchObject({
      qualifier: "about", calendar: "JULIAN", year: 1700,
    });
  });

  it("keeps a Julian date's components as written, without shifting them", () => {
    // The file states a Julian date; the app shows that date, not the
    // Gregorian equivalent ten days later.
    const d = parseDate("@#DJULIAN@ 14 JAN 1700");
    expect({ day: d.day, month: d.month, year: d.year }).toEqual({ day: 14, month: 1, year: 1700 });
  });

  it("marks an explicitly Gregorian date without otherwise changing it", () => {
    expect(parseDate("@#DGREGORIAN@ 14 JAN 1700")).toMatchObject({
      qualifier: "exact", calendar: "GREGORIAN", day: 14, month: 1, year: 1700,
    });
  });

  it("records a foreign-epoch calendar but lifts no components from it", () => {
    // Tishrei 5760 and Vendemiaire an I count from another epoch: a year of
    // 5760 in the model would place the person three millennia in the future.
    const hebrew = parseDate("@#DHEBREW@ 5 TSH 5760");
    expect(hebrew).toMatchObject({ qualifier: "exact", calendar: "HEBREW" });
    expect(hebrew.year).toBeUndefined();
    expect(hebrew.month).toBeUndefined();
    expect(hebrew.day).toBeUndefined();

    const french = parseDate("@#DFRENCH R@ 1 VEND 1");
    expect(french).toMatchObject({ qualifier: "exact", calendar: "FRENCH_R" });
    expect(french.year).toBeUndefined();

    expect(parseDate("@#DUNKNOWN@ 1700")).toMatchObject({ calendar: "UNKNOWN" });
    expect(parseDate("@#DUNKNOWN@ 1700").year).toBeUndefined();
  });

  it("keeps the qualifier of a foreign-epoch date", () => {
    expect(parseDate("ABT @#DHEBREW@ 5760")).toMatchObject({
      qualifier: "about", calendar: "HEBREW",
    });
  });

  it("is not garbage: a declared date never reads as unparseable", () => {
    // The health check treats qualifier "unknown" with no year as broken data;
    // a valid Hebrew date must not land there.
    for (const raw of ["@#DHEBREW@ 5 TSH 5760", "@#DFRENCH R@ 1 VEND 1", "@#DJULIAN@ 14 JAN 1700"]) {
      expect(parseDate(raw).qualifier).not.toBe("unknown");
    }
  });

  it("leaves a value alone when the escape names no standard calendar", () => {
    expect(parseDate("@#DKLINGON@ 1700").calendar).toBeUndefined();
  });

  it("keeps the raw text on the parsed date", () => {
    expect(parseDate("@#DJULIAN@ 14 JAN 1700").raw).toBe("@#DJULIAN@ 14 JAN 1700");
  });
});

describe("parseDate — years before the common era", () => {
  it("negates the year so it orders against ordinary years", () => {
    expect(parseDate("44 BCE")).toMatchObject({ qualifier: "exact", year: -44 });
    expect(parseDate("44 BC")).toMatchObject({ qualifier: "exact", year: -44 });
    expect(parseDate("1500 B.C.E.")).toMatchObject({ qualifier: "exact", year: -1500 });
  });

  it("takes the year literally rather than expanding it to the 1900s", () => {
    expect(parseDate("1 JAN 44 B.C.")).toMatchObject({ day: 1, month: 1, year: -44 });
  });

  it("composes with a qualifier", () => {
    expect(parseDate("BEF 44 BCE")).toMatchObject({ qualifier: "before", year: -44 });
  });

  it("declines two-endpoint forms rather than taking the wrong year", () => {
    // Only the closing era is in hand here, so a range keeps its existing
    // behaviour: a between date with no components, never year -30.
    const d = parseDate("BET 44 BC AND 30 BC");
    expect(d.qualifier).toBe("between");
    expect(d.year).toBeUndefined();
    expect(d.year2).toBeUndefined();
  });

  it("does not read an era out of ordinary text", () => {
    expect(parseDate("DEC 1900")).toMatchObject({ month: 12, year: 1900 });
    expect(parseDate("Ljubljana BC").year).toBeUndefined();
    // Text with a year in it stays unparseable rather than becoming year -1900:
    // the era has to close something the grammar recognises.
    expect(parseDate("rojen v vasi 1900 BC")).toMatchObject({ qualifier: "unknown" });
    expect(parseDate("rojen v vasi 1900 BC").year).toBeUndefined();
  });

  it("sorts a BCE year before every common-era year", () => {
    expect(dateToSortKey(parseDate("44 BCE"))).toBeLessThan(dateToSortKey(parseDate("1 JAN 1")));
  });
});
