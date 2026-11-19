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
    expect(week.flatMap((d) => d.items.map((a) => [a.id, a.event.tag, d.inDays, d.day]))).toEqual([
      ["@I1@", "BIRT", 0, 16],
      ["@F1@", "MARR", 2, 18],
      ["@I1@", "DEAT", 4, 20],
      ["@I3@", "BIRT", 6, 22],
    ]);
  });

  it("runs across the end of a month and a year", () => {
    const week = onThisWeek(DS, new Date(2026, 10, 28));
    expect(week.flatMap((d) => d.items.map((a) => a.event.date?.raw))).toEqual(["30 NOV 1960"]);
  });

  it("groups a day's events, oldest year first, and counts those past the limit", () => {
    const ds = dataset(`0 HEAD
0 @I1@ INDI
1 BIRT
2 DATE 16 NOV 1900
0 @I2@ INDI
1 BIRT
2 DATE 16 NOV 1850
1 DEAT
2 DATE 16 NOV 1920
0 TRLR
`);
    const [day] = onThisWeek(ds, new Date(2026, 10, 16), 2);
    expect(day.items.map((a) => a.event.date?.raw)).toEqual(["16 NOV 1850", "16 NOV 1900"]);
    expect(day.more).toBe(1);
  });
});
