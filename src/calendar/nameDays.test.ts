import { describe, expect, it } from "vitest";
import { DAYS, VARIANTS } from "./nameDayData";
import { NAME_CALENDARS, nameDayOf, nameKey, parseDay, saintsOf } from "./nameDays";

describe("the name-day tables", () => {
  it("cover every day of a leap year", () => {
    expect(DAYS.map((m) => m.length)).toEqual([31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  });

  for (const calendar of NAME_CALENDARS) {
    // Where each name stands, and where it is starred.
    const seen = new Map<string, { days: number; stars: number }>();
    for (const month of DAYS) {
      for (const line of month) {
        for (const { name, main } of parseDay(line, calendar)) {
          const at = seen.get(nameKey(name)) ?? { days: 0, stars: 0 };
          seen.set(nameKey(name), { days: at.days + 1, stars: at.stars + (main ? 1 : 0) });
        }
      }
    }

    it(`${calendar}: a name on several days marks exactly one of them, a name on one day none`, () => {
      const wrong = [...seen].filter(([, at]) => (at.days > 1 ? at.stars !== 1 : at.stars !== 0)).map(([name]) => name);
      expect(wrong).toEqual([]);
    });

    it(`${calendar}: every variant belongs to one name of the calendar, and is not one itself`, () => {
      const owner = new Map<string, string>();
      const wrong: string[] = [];
      for (const line of VARIANTS[calendar]) {
        const [canonical, rest] = line.split(":");
        if (!seen.has(nameKey(canonical))) wrong.push(`${canonical}: not in the calendar`);
        for (const v of rest.trim().split(/\s+/)) {
          const key = nameKey(v);
          if (seen.has(key)) wrong.push(`${v}: has a day of its own`);
          if (owner.has(key)) wrong.push(`${v}: under ${owner.get(key)} and ${canonical}`);
          owner.set(key, canonical);
        }
      }
      expect(wrong).toEqual([]);
    });
  }
});

describe("saintsOf", () => {
  it("names a day in each calendar's own forms", () => {
    expect(saintsOf("si", 3, 19)).toEqual(["Jožef"]);
    expect(saintsOf("hr", 3, 19)).toEqual(["Josip"]);
  });

  it("leaves out a name the other calendar alone carries", () => {
    expect(saintsOf("si", 5, 7)).toEqual(["Gizela"]);
    expect(saintsOf("hr", 5, 7)).toEqual(["Gizela", "Dujam"]);
  });
});

describe("nameDayOf", () => {
  it("gives a name on several days its bearers' day", () => {
    expect(nameDayOf("si", "Janez")).toEqual({ month: 6, day: 24 });
    expect(nameDayOf("hr", "Ivan")).toEqual({ month: 6, day: 24 });
    expect(nameDayOf("si", "Marija")).toEqual({ month: 8, day: 15 });
  });

  it("follows the everyday forms to their saint", () => {
    expect(nameDayOf("si", "Jože")).toEqual({ month: 3, day: 19 });
    expect(nameDayOf("si", "Francka")).toEqual({ month: 3, day: 9 });
    expect(nameDayOf("hr", "Krešimir")).toEqual({ month: 11, day: 24 });
  });

  it("lets the two calendars differ", () => {
    expect(nameDayOf("si", "Stanislav")).toEqual({ month: 11, day: 13 });
    expect(nameDayOf("hr", "Stanislav")).toEqual({ month: 4, day: 11 });
  });

  it("reads past case, missing diacritics and second names", () => {
    expect(nameDayOf("si", "JOZE")).toEqual({ month: 3, day: 19 });
    expect(nameDayOf("si", "Ana Marija")).toEqual({ month: 7, day: 26 });
    expect(nameDayOf("si", "Ana-Marija")).toEqual({ month: 7, day: 26 });
  });

  it("has no day for a name the calendar does not carry", () => {
    expect(nameDayOf("si", "Xyz")).toBeUndefined();
    expect(nameDayOf("si", undefined)).toBeUndefined();
  });
});
