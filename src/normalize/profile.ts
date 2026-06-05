import { parsePlace } from "../gedcom/place";
import type { Dataset } from "../gedcom/types";
import type {
  DateFormatProfile,
  MasterProfile,
  PlaceFormatProfile,
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
  walkNodes(master.records, (node) => {
    if (node.value === undefined) return;
    if (node.tag === "DATE") dateValues.push(node.value);
    else if (node.tag === "PLAC") placeValues.push(node.value);
  });

  return {
    date: inferDateProfile(dateValues),
    place: inferPlaceProfile(placeValues),
  };
}

function inferDateProfile(values: string[]): DateFormatProfile {
  let upper = 0;
  let lower = 0;
  let title = 0;
  let full = 0;
  let abbr = 0;
  let paddedDay = 0;
  let dayCount = 0;

  for (const v of values) {
    for (const token of v.match(/[A-Za-z]{3,}/g) ?? []) {
      if (!isMonthWord(token)) continue;
      if (token.length > 3) full++;
      else abbr++;
      switch (casingOf(token)) {
        case "upper": upper++; break;
        case "lower": lower++; break;
        case "title": title++; break;
      }
    }
    // Day token: 1-2 digits immediately before a month word.
    const m = v.match(/(?:^|\s)(\d{1,2})\s+[A-Za-z]{3,}/);
    if (m) {
      dayCount++;
      if (/^0\d$/.test(m[1])) paddedDay++;
    }
  }

  const base = full > abbr ? MONTHS_FULL : MONTHS_ABBR;
  const casing: Casing =
    lower >= upper && lower >= title ? "lower" : title >= upper ? "title" : "upper";
  const monthTokens = base.map((t, i) => (i === 0 ? "" : applyCasing(t, casing)));
  const padDay = dayCount > 0 && paddedDay * 2 > dayCount; // majority padded

  return { monthTokens, padDay, qualifierTokens: DEFAULT_QUALIFIER_TOKENS };
}

function inferPlaceProfile(values: string[]): PlaceFormatProfile {
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
    modalDepth: mostFrequentKey(depthCounts) ?? 0,
    partCanonical: pickCanonical(partForms),
    fullCanonical: pickCanonical(fullForms),
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
