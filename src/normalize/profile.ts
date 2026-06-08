import { parsePlace } from "../gedcom/place";
import type { Dataset, DateOrder } from "../gedcom/types";
import type {
  DateFormatProfile,
  MasterProfile,
  NumericDateFormat,
  PlaceFormatProfile,
  PlaceLayout,
} from "./types";
import { walkNodes } from "./walk";

const MONTHS_ABBR = [
  "", "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];
const MONTHS_FULL = [
  "", "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];

type Casing = "upper" | "lower" | "title";

const DEFAULT_QUALIFIER_TOKENS: DateFormatProfile["qualifierTokens"] = {
  exact: "",
  about: "ABT",
  before: "BEF",
  after: "AFT",
  between: "BET",
  from: "FROM",
  to: "TO",
  range: "FROM",
  interpreted: "INT",
  unknown: "",
};

/**
 * Infer the master's date and place conventions by sampling its records.
 * Conservative: when the master gives no signal we fall back to GEDCOM-standard
 * formatting (uppercase three-letter English months, no day padding).
 */
export function inferMasterProfile(master: Dataset): MasterProfile {
  const dateValues: string[] = [];
  const placeValues: string[] = [];
  let addrCount = 0;
  walkNodes(master.records, (node) => {
    if (node.tag === "ADDR" && node.value !== undefined) addrCount++;
    if (node.value === undefined) return;
    if (node.tag === "DATE") dateValues.push(node.value);
    else if (node.tag === "PLAC") placeValues.push(node.value);
  });

  return {
    date: inferDateProfile(dateValues),
    place: inferPlaceProfile(placeValues, addrCount),
  };
}

export function inferDateProfile(values: string[]): DateFormatProfile {
  let upper = 0;
  let lower = 0;
  let title = 0;
  let full = 0;
  let abbr = 0;
  let paddedDay = 0;
  let dayCount = 0;

  let monthWordValues = 0;
  const numeric = new NumericTally();

  for (const v of values) {
    let hasMonthWord = false;
    for (const token of v.match(/[A-Za-z]{3,}/g) ?? []) {
      if (!isMonthWord(token)) continue;
      hasMonthWord = true;
      if (token.length > 3) full++;
      else abbr++;
      switch (casingOf(token)) {
        case "upper": upper++; break;
        case "lower": lower++; break;
        case "title": title++; break;
      }
    }
    if (hasMonthWord) {
      monthWordValues++;
      // Day token: 1-2 digits immediately before a month word.
      const m = v.match(/(?:^|\s)(\d{1,2})\s+[A-Za-z]{3,}/);
      if (m) {
        dayCount++;
        if (/^0\d$/.test(m[1])) paddedDay++;
      }
    } else {
      numeric.observe(v);
    }
  }

  const base = full > abbr ? MONTHS_FULL : MONTHS_ABBR;
  const casing: Casing =
    lower >= upper && lower >= title ? "lower" : title >= upper ? "title" : "upper";
  const monthTokens = base.map((t, i) => (i === 0 ? "" : applyCasing(t, casing)));
  const padDay = dayCount > 0 && paddedDay * 2 > dayCount; // majority padded

  const profile: DateFormatProfile = {
    monthTokens,
    padDay,
    qualifierTokens: DEFAULT_QUALIFIER_TOKENS,
  };
  // Prefer numeric output only when it's the master's dominant style.
  if (numeric.count > monthWordValues && numeric.count > 0) {
    profile.numeric = numeric.resolve();
  }
  return profile;
}

/**
 * Accumulates evidence about numeric date values to infer their layout: field
 * order (DMY/MDY/YMD), separator, and zero-padding.
 */
class NumericTally {
  count = 0;
  private sep = new Map<string, number>();
  private yearFirst = 0;
  private yearLast = 0;
  private dmyVotes = 0; // year-last values where the first field can't be a month
  private mdyVotes = 0; // year-last values where the second field can't be a month
  private padFields = 0;
  private fieldCount = 0;

  observe(value: string): void {
    const m = value.trim().match(/^(\d{1,4})([./-])(\d{1,4})\2(\d{1,4})$/);
    if (!m) return;
    const [, g1, separator, g2, g3] = m;
    let dayMonth: [string, string];
    if (isYearField(g1)) {
      this.yearFirst++;
      dayMonth = [g2, g3];
    } else if (isYearField(g3)) {
      this.yearLast++;
      dayMonth = [g1, g2];
      if (+g1 > 12 && +g2 <= 12) this.dmyVotes++;
      else if (+g2 > 12 && +g1 <= 12) this.mdyVotes++;
    } else {
      return; // No identifiable year — not usable evidence.
    }
    this.count++;
    bumpStr(this.sep, separator);
    // Only single-digit values carry padding signal: "05" is padded, "5" is
    // not; a value like "20" is intrinsically two digits and tells us nothing.
    for (const g of dayMonth) {
      if (+g >= 10) continue;
      this.fieldCount++;
      if (g.length === 2) this.padFields++;
    }
  }

  resolve(): NumericDateFormat {
    const separator = mostFrequentStr(this.sep) ?? ".";
    let order: DateOrder;
    if (this.yearFirst > this.yearLast) order = "YMD";
    else if (this.dmyVotes > this.mdyVotes) order = "DMY";
    else if (this.mdyVotes > this.dmyVotes) order = "MDY";
    else order = separator === "/" ? "MDY" : "DMY"; // ambiguous default
    const pad = this.fieldCount > 0 && this.padFields * 2 > this.fieldCount;
    return { order, separator, padDay: pad, padMonth: pad };
  }
}

/** A 3+ digit run, or any value too large to be a day, is taken to be a year. */
function isYearField(g: string): boolean {
  return g.length >= 3 || +g > 31;
}

function inferPlaceProfile(values: string[], addrCount: number): PlaceFormatProfile {
  const depthCounts = new Map<number, number>();
  // part -> casing form -> count
  const partForms = new Map<string, Map<string, number>>();
  const fullForms = new Map<string, Map<string, number>>();

  for (const v of values) {
    const { parts, raw } = parsePlace(v);
    if (parts.length === 0) continue;
    bump(depthCounts, parts.length);

    for (const part of parts) {
      const key = part.toLowerCase();
      const forms = partForms.get(key) ?? new Map<string, number>();
      bumpStr(forms, part);
      partForms.set(key, forms);
    }

    const fullKey = parts.map((p) => p.toLowerCase()).join("|");
    const forms = fullForms.get(fullKey) ?? new Map<string, number>();
    bumpStr(forms, raw);
    fullForms.set(fullKey, forms);
  }

  return {
    layout: detectPlaceLayout(values, addrCount),
    modalDepth: mostFrequentKey(depthCounts) ?? 0,
    partCanonical: pickCanonical(partForms),
    fullCanonical: pickCanonical(fullForms),
  };
}

/** Parish marker (Slovenian "župnija"/"župnije"). */
const PARISH_MARK = /\bžupnij[ae]\b/i;
/** A parenthetical on the first comma part — Brother's Keeper "Locality (Country)". */
const PAREN_ON_FIRST = /^[^,]*\([^)]+\)/;

/**
 * Classify a file's place-formatting convention from its PLAC values and how
 * many ADDR lines accompany them. See {@link PlaceLayout} for the categories.
 */
export function detectPlaceLayout(values: string[], addrCount: number): PlaceLayout {
  const n = values.length;
  if (n === 0) return "unknown";

  let parenCountry = 0;
  let parish = 0;
  let withNumber = 0;
  let multiPart = 0;
  for (const v of values) {
    if (PAREN_ON_FIRST.test(v)) parenCountry++;
    if (PARISH_MARK.test(v)) parish++;
    if (/\d/.test(v)) withNumber++;
    if (v.split(",").filter((p) => p.trim()).length >= 2) multiPart++;
  }
  const frac = (x: number) => x / n;

  // Brother's Keeper packed form: country in parentheses and/or parish markers.
  if (frac(parenCountry) > 0.3 || frac(parish) > 0.15) return "packed-plac";
  // Structured hierarchy with house numbers kept in separate ADDR lines.
  if (addrCount / n > 0.15 && frac(multiPart) > 0.4) return "structured-addr";
  // Mostly single-part "Name 52" values.
  if (frac(multiPart) < 0.2 && frac(withNumber) > 0.4) return "address-only";
  // Comma hierarchy with no embedded addresses.
  if (frac(multiPart) > 0.4) return "plain-structured";
  return "unknown";
}

/** Detect a dataset's place layout directly (used for the compare slot). */
export function inferPlaceLayout(dataset: Dataset): PlaceLayout {
  const values: string[] = [];
  let addrCount = 0;
  walkNodes(dataset.records, (node) => {
    if (node.tag === "ADDR" && node.value !== undefined) addrCount++;
    else if (node.tag === "PLAC" && node.value !== undefined) values.push(node.value);
  });
  return detectPlaceLayout(values, addrCount);
}

/**
 * The master's place layout plus its PLAC part separator ("," vs ", "), used at
 * export to reshape incoming places to match the master.
 */
export function inferPlaceExportFormat(dataset: Dataset): { layout: PlaceLayout; separator: string } {
  const values: string[] = [];
  let addrCount = 0;
  let withSpace = 0;
  let withoutSpace = 0;
  walkNodes(dataset.records, (node) => {
    if (node.tag === "ADDR" && node.value !== undefined) addrCount++;
    else if (node.tag === "PLAC" && node.value !== undefined) {
      values.push(node.value);
      for (const m of node.value.matchAll(/,(\s?)/g)) {
        if (m[1]) withSpace++;
        else withoutSpace++;
      }
    }
  });
  return {
    layout: detectPlaceLayout(values, addrCount),
    separator: withoutSpace > withSpace ? "," : ", ",
  };
}

// --- helpers ---------------------------------------------------------------

function isMonthWord(token: string): boolean {
  const u = token.toUpperCase();
  return MONTHS_ABBR.includes(u) || MONTHS_FULL.includes(u);
}

function casingOf(token: string): Casing {
  if (token === token.toUpperCase()) return "upper";
  if (token === token.toLowerCase()) return "lower";
  return "title";
}

function applyCasing(token: string, casing: Casing): string {
  switch (casing) {
    case "upper": return token.toUpperCase();
    case "lower": return token.toLowerCase();
    case "title": return token[0].toUpperCase() + token.slice(1).toLowerCase();
  }
}

function bump(map: Map<number, number>, key: number): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}
function bumpStr(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function mostFrequentKey(map: Map<number, number>): number | undefined {
  let best: number | undefined;
  let bestCount = -1;
  for (const [k, c] of map) {
    if (c > bestCount) {
      best = k;
      bestCount = c;
    }
  }
  return best;
}

function mostFrequentStr(map: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = -1;
  for (const [k, c] of map) {
    if (c > bestCount) {
      best = k;
      bestCount = c;
    }
  }
  return best;
}

/** For each key, choose the most frequently-seen form. */
function pickCanonical(forms: Map<string, Map<string, number>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, formCounts] of forms) {
    let bestForm = "";
    let bestCount = -1;
    for (const [form, count] of formCounts) {
      if (count > bestCount) {
        bestForm = form;
        bestCount = count;
      }
    }
    out.set(key, bestForm);
  }
  return out;
}
