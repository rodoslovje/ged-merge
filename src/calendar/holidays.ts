// Public holidays for the family calendar, per country: the work-free days the
// law lists, fixed dates plus the ones that move with Easter. Names live in the
// locales (`calendar.holiday.<key>`).

export type HolidayCountry = "si" | "hr";
export const HOLIDAY_COUNTRIES: HolidayCountry[] = ["si", "hr"];

export interface Holiday {
  month: number; // 1-12
  day: number;
  key: string;
}

/** Western (Gregorian) Easter Sunday — the anonymous Gregorian algorithm. */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** Easter Sunday plus `days`, as a month/day of the same year. */
function fromEaster(year: number, days: number, key: string): Holiday {
  const e = easterSunday(year);
  const d = new Date(Date.UTC(year, e.month - 1, e.day + days));
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate(), key };
}

const FIXED: Record<HolidayCountry, [number, number, string][]> = {
  // Zakon o praznikih in dela prostih dnevih v Republiki Sloveniji.
  si: [
    [1, 1, "newYear"],
    [1, 2, "newYear"],
    [2, 8, "si.preseren"],
    [4, 27, "si.resistance"],
    [5, 1, "labour"],
    [5, 2, "labour"],
    [6, 25, "si.statehood"],
    [8, 15, "assumption"],
    [10, 31, "si.reformation"],
    [11, 1, "si.remembrance"],
    [12, 25, "christmas"],
    [12, 26, "si.independence"],
  ],
  // Zakon o blagdanima, spomendanima i neradnim danima u Republici Hrvatskoj (2020).
  hr: [
    [1, 1, "newYear"],
    [1, 6, "epiphany"],
    [5, 1, "labour"],
    [5, 30, "hr.statehood"],
    [6, 22, "hr.antifascist"],
    [8, 5, "hr.victory"],
    [8, 15, "assumption"],
    [11, 1, "allSaints"],
    [11, 18, "hr.remembrance"],
    [12, 25, "christmas"],
    [12, 26, "hr.stephen"],
  ],
};

/** Every holiday of `country` in `year`, in date order. */
export function holidaysFor(country: HolidayCountry, year: number): Holiday[] {
  const out: Holiday[] = FIXED[country].map(([month, day, key]) => ({ month, day, key }));
  out.push(fromEaster(year, 0, "easter"), fromEaster(year, 1, "easterMonday"));
  if (country === "si") out.push(fromEaster(year, 49, "pentecost"));
  if (country === "hr") out.push(fromEaster(year, 60, "corpusChristi"));
  return out.sort((a, b) => a.month - b.month || a.day - b.day);
}
