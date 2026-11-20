import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseDate } from "../gedcom/date";
import { yearBounds } from "../gedcom/lifespan";
import { parseGedcom } from "../gedcom/parser";
import { matchDatasets } from "./engine";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

/** Whether a record with `mainLines` and one with `incomingLines`, same name and place, are matched. */
function matched(mainLines: string, incomingLines: string): boolean {
  const main = dataset(wrap(`0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n${mainLines}`));
  const compare = dataset(wrap(`0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n${incomingLines}`));
  return matchDatasets(main, compare).individuals.length === 1;
}

describe("yearBounds", () => {
  const bounds = (raw: string) => yearBounds(parseDate(raw));
  it("reads each qualifier as the years it allows", () => {
    expect(bounds("12 JAN 1851")).toEqual({ min: 1851, max: 1851 });
    // An estimate is a point here — see yearBounds for why.
    expect(bounds("ABT 1850")).toEqual({ min: 1850, max: 1850 });
    expect(bounds("BEF 1850")).toEqual({ min: -Infinity, max: 1850 });
    expect(bounds("AFT 1800")).toEqual({ min: 1800, max: Infinity });
    expect(bounds("BET 1840 AND 1850")).toEqual({ min: 1840, max: 1850 });
    expect(bounds("FROM 1840 TO 1850")).toEqual({ min: 1840, max: 1850 });
    expect(bounds("")).toBeUndefined();
  });
});

describe("the lifespan gate, on dates that only bound or approximate", () => {
  it("still reads an about date as its year: an estimate vetoes like any other", () => {
    // A father whose birth is estimated from his child's, against an infant
    // of a like surname who died the year before that estimate.
    expect(matched(
      "1 BIRT\n2 DATE ABT 1850\n1 DEAT Y\n",
      "1 BIRT\n2 DATE 18 JAN 1849\n2 PLAC Kranj\n1 DEAT\n2 DATE 5 DEC 1849\n2 PLAC Kranj\n",
    )).toBe(false);
  });

  it("lets a death in 1845 meet a birth before 1850", () => {
    expect(matched(
      "1 DEAT\n2 DATE 3 MAR 1845\n2 PLAC Kranj\n",
      "1 BIRT\n2 DATE BEF 1850\n2 PLAC Kranj\n1 DEAT\n2 DATE 1845\n2 PLAC Kranj\n",
    )).toBe(true);
  });

  it("lets a death after 1800 meet a marriage in 1805", () => {
    const main = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1770\n2 PLAC Kranj\n1 DEAT\n2 DATE AFT 1800\n"));
    const compare = dataset(wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1770\n2 PLAC Kranj\n1 FAMS @F1@\n" +
        "0 @P2@ INDI\n1 NAME Marija /Oblak/\n1 SEX F\n1 FAMS @F1@\n" +
        "0 @F1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 MARR\n2 DATE 1805\n",
    ));
    expect(matchDatasets(main, compare).individuals.some((c) => c.mainId === "@I1@" && c.compareId === "@P1@")).toBe(true);
  });

  it("still keeps apart a death that came before the other's birth", () => {
    expect(matched(
      "1 BIRT\n2 DATE 1790\n2 PLAC Kranj\n1 DEAT\n2 DATE 1795\n2 PLAC Kranj\n",
      "1 BIRT\n2 DATE 1798\n2 PLAC Kranj\n",
    )).toBe(false);
    // …also when the death is only bounded from above, or about a year too early.
    expect(matched("1 BIRT\n2 DATE 1790\n1 DEAT\n2 DATE BEF 1795\n", "1 BIRT\n2 DATE 1798\n")).toBe(false);
    expect(matched("1 BIRT\n2 DATE 1790\n1 DEAT\n2 DATE ABT 1796\n", "1 BIRT\n2 DATE 1798\n")).toBe(false);
  });
});
