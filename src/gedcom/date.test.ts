import { describe, expect, it } from "vitest";
import { parseDate } from "./date";

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
