import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { onThisWeek } from "./anniversaries";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));

const DS = dataset(`0 HEAD
0 @I1@ INDI
1 NAME Jože /Novak/
1 BIRT
2 DATE 16 NOV 1880
1 DEAT
2 DATE 20 NOV 1950
0 @I2@ INDI
1 NAME Ana /Kos/
1 BIRT
2 DATE ABT 17 NOV 1885
1 DEAT
2 DATE 30 NOV 1960
0 @I3@ INDI
1 NAME Marko /Novak/
1 BIRT
2 DATE 22 NOV 1830
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 MARR
2 DATE 18 NOV 1905
0 TRLR
`);

describe("onThisWeek", () => {
  it("lists the exact days of the coming week, nearest first", () => {
    const week = onThisWeek(DS, new Date(2026, 10, 16));
    expect(week.map((a) => [a.id, a.event.tag, a.inDays])).toEqual([
      ["@I1@", "BIRT", 0],
      ["@F1@", "MARR", 2],
      ["@I1@", "DEAT", 4],
      ["@I3@", "BIRT", 6],
    ]);
  });

  it("runs across the end of a month and a year", () => {
    const week = onThisWeek(DS, new Date(2026, 10, 28));
    expect(week.map((a) => a.event.date?.raw)).toEqual(["30 NOV 1960"]);
  });

  it("keeps to its limit", () => {
    expect(onThisWeek(DS, new Date(2026, 10, 16), 2)).toHaveLength(2);
  });
});
