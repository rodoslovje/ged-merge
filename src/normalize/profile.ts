import { addressStreetName, decomposePlace, parseCoordPair, parsePlace, stripHouseNumber } from "../gedcom/place";
import { canonicalPlaceToken } from "../match/place";
import { LINK_TAGS, looksLikeUrl } from "../gedcom/builder";
import { detectPrivacyStyleIfAny } from "../gedcom/private";
import { firstChild } from "../gedcom/node";
import type { Dataset, DateOrder, GedNode } from "../gedcom/types";
import type {
  DateFormatProfile,
  MainProfile,
  NumericDateFormat,
  PlaceFormatProfile,
  PlaceFormVocabulary,
  PlaceHierarchy,
  PlaceLayout,
  PlaceTargetFormat,
} from "./types";
import { detectLinkLangs } from "./links";
import { inferNameVariants } from "./nameVariants";
import { analyzeUnknownNames } from "./unknownName";
import { walkNodes } from "./walk";

// Re-exported so existing importers (worker, tests) keep getting it from here.
export { inferNameLayout, inferNameVariants } from "./nameVariants";

/** The placeholder token a file uses for unknown names (e.g. "NN"), or undefined
 *  when it leaves unknown name parts blank. Shown on the loader summary. */
export function detectUnknownNameToken(dataset: Dataset): string | undefined {
  return analyzeUnknownNames(dataset).token;
}

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
 * Infer the main's date and place conventions by sampling its records.
 * Conservative: when the main gives no signal we fall back to GEDCOM-standard
 * formatting (uppercase three-letter English months, no day padding).
 */
export function inferMainProfile(main: Dataset): MainProfile {
  const dateValues: string[] = [];
  const placeValues: string[] = [];
  const links: string[] = [];
  let addrCount = 0;
  walkNodes(main.records, (node) => {
    if (node.tag === "ADDR" && node.value !== undefined) addrCount++;
    if (node.value === undefined) return;
    if (node.tag === "DATE") dateValues.push(node.value);
    else if (node.tag === "PLAC") placeValues.push(node.value);
    else if (LINK_TAGS.has(node.tag) && looksLikeUrl(node.value)) links.push(node.value);
  });

  return {
    version: main.version,
    date: inferDateProfile(dateValues),
    place: inferPlaceProfile(placeValues, addrCount),
    linkLangs: detectLinkLangs(links),
    placeFmt: inferPlaceExportFormat(main),
    nameVariants: inferNameVariants(main),
    unknownName: analyzeUnknownNames(main).target,
    privacyStyle: detectPrivacyStyleIfAny(main.records),
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
  // Prefer numeric output only when it's the main's dominant style.
  if (numeric.count > monthWordValues && numeric.count > 0) {
    const resolved = numeric.resolve();
    const placeholder = detectDatePlaceholder(values);
    if (placeholder) resolved.placeholder = placeholder;
    profile.numeric = resolved;
  }
  return profile;
}

/**
 * The character a file uses to mark an unknown date component ("_" or "?"), or
 * undefined when it doesn't use placeholder dates. Detected from values where a
 * placeholder run sits in a numeric date slot (bounded by separators or the
 * ends), e.g. "__.05.1900" or ".__.____". Requires at least two such values so a
 * single stray entry isn't mistaken for a house convention.
 */
export function detectDatePlaceholder(values: string[]): string | undefined {
  let underscore = 0;
  let question = 0;
  for (const v of values) {
    if (!/(?:^|[./-])\s*[_?]{1,4}\s*(?:[./-]|$)/.test(v)) continue;
    if (v.includes("_")) underscore++;
    else question++;
  }
  if (underscore + question < 2) return undefined;
  return underscore >= question ? "_" : "?";
}

/**
 * A human-readable pattern for an inferred date profile, e.g. "DD.MM.YYYY" or
 * "D JAN YYYY". The month-word form uses the file's own month token so its
 * abbreviation and casing show through.
 */
export function describeDateFormat(profile: DateFormatProfile): string {
  if (profile.numeric) {
    const { order, separator, padDay, padMonth } = profile.numeric;
    const d = padDay ? "DD" : "D";
    const m = padMonth ? "MM" : "M";
    const fields = order === "YMD" ? ["YYYY", m, d] : order === "MDY" ? [m, d, "YYYY"] : [d, m, "YYYY"];
    // The unknown-component marker (e.g. "__") is reported separately so it can
    // live in the format row's tooltip instead of cluttering the short label.
    return fields.join(separator);
  }
  const d = profile.padDay ? "DD" : "D";
  const token = profile.monthTokens[1] || "JAN";
  // Conventional month placeholder (MMM abbreviated / MMMM full), cased to match
  // the file's own month tokens (e.g. "Mmm" for title case, "mmm" for lower).
  const month = applyCasing(token.length > 3 ? "MMMM" : "MMM", casingOf(token));
  return `${d} ${month} YYYY`;
}

/** Detect and describe a dataset's date format; undefined when it has no dates. */
export function inferDateLayout(dataset: Dataset): string | undefined {
  return dateLayoutFromValues(collectDateValues(dataset));
}

/** Detect a dataset's unknown-date placeholder marker ("_"/"?"), or undefined. */
export function inferDatePlaceholder(dataset: Dataset): string | undefined {
  return detectDatePlaceholder(collectDateValues(dataset));
}

/** How much of a file's places carry coordinates — the "location used" signal
 *  for the loader card. `withCoord` counts PLAC lines with a usable `MAP`. */
export interface CoordUsage {
  withCoord: number;
  total: number;
}

/**
 * Count PLAC lines and how many of them carry a parseable coordinate. Reported
 * on load so it is obvious whether a file uses coordinates at all — and, when it
 * does, how far the coverage goes, which is what decides whether geocoding is
 * worth a pass.
 */
export function detectCoordUsage(dataset: Dataset): CoordUsage {
  let withCoord = 0;
  let total = 0;
  walkNodes(dataset.records, (node) => {
    if (node.tag !== "PLAC" || !node.value?.trim()) return;
    total++;
    const map = node.children.find((c) => c.tag === "MAP");
    const lati = map?.children.find((c) => c.tag === "LATI")?.value;
    const long = map?.children.find((c) => c.tag === "LONG")?.value;
    if (lati && long && parseCoordPair(lati, long)) withCoord++;
  });
  return { withCoord, total };
}

/** Pure: describe a date layout from already-collected DATE values (undefined when there are none). */
export function dateLayoutFromValues(values: string[]): string | undefined {
  return values.length === 0 ? undefined : describeDateFormat(inferDateProfile(values));
}

function collectDateValues(dataset: Dataset): string[] {
  const values: string[] = [];
  walkNodes(dataset.records, (node) => {
    if (node.tag === "DATE" && node.value !== undefined) values.push(node.value);
  });
  return values;
}

/** DATE and PLAC/ADDR values collected from one walk of a dataset's record tree. */
export interface LayoutValues {
  dateValues: string[];
  placeValues: string[];
  addrCount: number;
}

/**
 * Collect DATE and PLAC/ADDR values in a single tree walk, for callers (the
 * compare-file load path) that need both the date and place layout — and, for
 * the normalizer, the date values again to infer the source's numeric date
 * order — without walking the same tree three separate times.
 */
export function collectLayoutValues(dataset: { records: GedNode[] }): LayoutValues {
  const dateValues: string[] = [];
  const placeValues: string[] = [];
  let addrCount = 0;
  walkNodes(dataset.records, (node) => {
    if (node.tag === "ADDR" && node.value !== undefined) addrCount++;
    if (node.value === undefined) return;
    if (node.tag === "DATE") dateValues.push(node.value);
    else if (node.tag === "PLAC") placeValues.push(node.value);
  });
  return { dateValues, placeValues, addrCount };
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

/** Parish marker (Slovenian "župnija"/"župnije", Croatian "župa"/"župe", or English "parish"). */
const PARISH_MARK = /\b(?:župnij[ae]|žup[ae]|parish)\b/i;
/** A bracketed aside on the first comma part — Brother's Keeper
 *  "Locality (Country)"; square brackets are the same convention. */
const PAREN_ON_FIRST = /^[^,]*(?:\([^)]+\)|\[[^\]]+\])/;

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

/**
 * Which comma form a file writes between place jurisdictions — `"comma-space"`
 * for `Kranj, Slovenija` (the form GEDCOM 5.5.1's own grammar and examples
 * use), `"comma"` for the packed `Kranj,Slovenija`. Majority wins, ties go to
 * the spec form. Undefined when no place has a comma at all: no signal.
 */
export function detectPlaceSeparator(values: string[]): "comma" | "comma-space" | undefined {
  let withSpace = 0;
  let withoutSpace = 0;
  for (const v of values) {
    for (const m of v.matchAll(/,(\s?)/g)) {
      if (m[1]) withSpace++;
      else withoutSpace++;
    }
  }
  if (withSpace + withoutSpace === 0) return undefined;
  return withoutSpace > withSpace ? "comma" : "comma-space";
}

/** The literal string a {@link detectPlaceSeparator} value writes. */
export function placeSeparatorText(kind: "comma" | "comma-space"): string {
  return kind === "comma" ? "," : ", ";
}

type PlaceExportFormat = {
  layout: PlaceLayout;
  separator: string;
  countryPreferred?: Map<string, string>;
  hierarchy: PlaceHierarchy;
  forms?: PlaceFormVocabulary;
};
const placeExportFormatCache = new WeakMap<Dataset, PlaceExportFormat>();

/**
 * The main's place layout plus its PLAC part separator ("," vs ", "), used at
 * export to reshape incoming places to match the main.
 * Cached by dataset identity — the result never changes for the same object.
 */
export function inferPlaceExportFormat(dataset: Dataset): PlaceExportFormat {
  const cached = placeExportFormatCache.get(dataset);
  if (cached) return cached;
  const values: string[] = [];
  const formTally = new Map<string, Map<string, number>>();
  let addrCount = 0;
  walkNodes(dataset.records, (node) => {
    if (node.tag === "ADDR" && node.value !== undefined) addrCount++;
    else if (node.tag === "PLAC" && node.value !== undefined) {
      values.push(node.value);
      tallyPlaceForm(formTally, node.value, firstChild(node, "FORM")?.value);
    }
  });
  // Build preferred country form map: canonical-key → most-used display form in main.
  const countryForms = new Map<string, Map<string, number>>();
  for (const v of values) {
    const country = decomposePlace(v).country;
    if (!country) continue;
    const canonical = canonicalPlaceToken(country);
    const forms = countryForms.get(canonical) ?? new Map<string, number>();
    bumpStr(forms, country);
    countryForms.set(canonical, forms);
  }
  const countryPreferred = new Map<string, string>();
  for (const [canonical, forms] of countryForms) {
    const preferred = mostFrequentStr(forms);
    if (preferred) countryPreferred.set(canonical, preferred);
  }

  const forms = resolvePlaceForms(formTally);
  const result: PlaceExportFormat = {
    layout: detectPlaceLayout(values, addrCount),
    separator: placeSeparatorText(detectPlaceSeparator(values) ?? "comma-space"),
    ...(countryPreferred.size > 0 ? { countryPreferred } : {}),
    hierarchy: inferPlaceHierarchy(dataset),
    ...(forms.size > 0 ? { forms } : {}),
  };
  placeExportFormatCache.set(dataset, result);
  return result;
}

/** Key into a {@link PlaceFormVocabulary}: the country a place ends in and how
 *  many parts it has. An absent country keys the depth-only entry. */
function placeFormKey(country: string | undefined, parts: number): string {
  return `${country ? canonicalPlaceToken(country) : ""}|${parts}`;
}

/** Count the comma parts of a place value, the way a FORM's labels count. */
function placeParts(value: string): number {
  return value.split(",").filter((s) => s.trim()).length;
}

/** Tally one attested place → FORM pairing, under both its country-specific
 *  key and the depth-only one. */
function tallyPlaceForm(
  tally: Map<string, Map<string, number>>,
  place: string,
  form: string | undefined,
): void {
  if (!form?.trim()) return;
  const parts = placeParts(place);
  // A FORM whose label count doesn't match the place it sits on describes
  // neither reliably ("Slovenia,Slovenia" under three labels) — learning from
  // it would spread one file's mistake onto every place we write next.
  if (parts === 0 || parts !== placeParts(form)) return;
  const country = decomposePlace(place).country;
  for (const key of [placeFormKey(country, parts), placeFormKey(undefined, parts)]) {
    const forms = tally.get(key) ?? new Map<string, number>();
    bumpStr(forms, form.trim());
    tally.set(key, forms);
  }
}

/** Reduce each key's tally to its most-used wording. A depth-only key that the
 *  file spells more than one way is dropped: it means this file *does* vary its
 *  labels by country, so guessing across countries would write the wrong ones. */
function resolvePlaceForms(tally: Map<string, Map<string, number>>): PlaceFormVocabulary {
  const out: PlaceFormVocabulary = new Map();
  for (const [key, forms] of tally) {
    if (key.startsWith("|") && forms.size > 1) continue;
    const best = mostFrequentStr(forms);
    if (best) out.set(key, best);
  }
  return out;
}

/**
 * The `FORM` this file would write for a place, or undefined when it wouldn't:
 * it writes no FORM at all, it has never labelled a place of this shape, or the
 * layout packs addresses into the PLAC so its parts aren't jurisdictions.
 *
 * Only ever answers with wording the file itself already uses.
 */
export function placeFormFor(fmt: PlaceTargetFormat, plac: string, country: string | undefined): string | undefined {
  if (!fmt.forms || fmt.layout === "packed-plac") return undefined;
  const parts = placeParts(plac);
  if (!parts) return undefined;
  return fmt.forms.get(placeFormKey(country, parts)) ?? fmt.forms.get(placeFormKey(undefined, parts));
}

/** Joins a learned jurisdiction chain for tallying; never appears in place text. */
const CHAIN_SEP = "\u0001";

/**
 * Learn place associations from the main's own attested PLAC/ADDR/AGNC, so
 * reshaping can recognize a more specific locality than an incoming place
 * names (via a shared parish or street) and fill in jurisdiction levels it
 * omits (e.g. a municipality) — without an external geographic database, just
 * what the main tree already shows elsewhere.
 */
export function inferPlaceHierarchy(dataset: Dataset): PlaceHierarchy {
  const parentTally = new Map<string, Map<string, number>>();
  const streetTally = new Map<string, Map<string, number>>();

  walkNodes(dataset.records, (node) => {
    const placNode = firstChild(node, "PLAC");
    if (!placNode?.value) return;
    const addrNode = firstChild(node, "ADDR");
    const p = decomposePlace(placNode.value);
    if (!p.locality) return;

    if (p.jurisdiction.length >= 2) {
      bumpStr(getForms(parentTally, p.locality.toLowerCase()), p.jurisdiction.slice(1).join(CHAIN_SEP));
    }

    // A locality written the same as its own next jurisdiction level
    // ("Kranj,Kranj,Slovenia") is a generic catch-all, not a real
    // disambiguation — it's how many records on a street get entered when
    // nobody pinned down the exact hamlet. Don't let it outvote the rarer,
    // correctly narrowed entries for that same street (e.g.
    // "Stražišče,Kranj,Slovenia"); only those are worth learning from here.
    const isGeneric = p.jurisdiction.length >= 2 && p.locality.toLowerCase() === p.jurisdiction[1].toLowerCase();
    if (isGeneric) return;

    // The street may be an inline PLAC segment (packed layout, number still
    // attached) or a separate ADDR (structured layout, already number-free).
    // We learn streets only, not parishes: a parish often spans many villages,
    // so its most-common locality is an unreliable plurality, not a real clue.
    const streetName = (p.street && stripHouseNumber(p.street)) || addressStreetName(addrNode?.value);
    if (streetName && streetName.toLowerCase() !== p.locality.toLowerCase()) {
      bumpStr(getForms(streetTally, streetName.toLowerCase()), p.locality);
    }
  });

  const parentOf = new Map<string, string[]>();
  for (const [key, forms] of parentTally) {
    const best = mostFrequentStr(forms);
    if (best) parentOf.set(key, best.split(CHAIN_SEP));
  }
  const localityOfStreet = new Map<string, string>();
  for (const [key, forms] of streetTally) {
    const best = mostFrequentStr(forms);
    if (best) localityOfStreet.set(key, best);
  }
  return { parentOf, localityOfStreet };
}

function getForms(map: Map<string, Map<string, number>>, key: string): Map<string, number> {
  let forms = map.get(key);
  if (!forms) {
    forms = new Map<string, number>();
    map.set(key, forms);
  }
  return forms;
}

// --- helpers ---------------------------------------------------------------

export function isMonthWord(token: string): boolean {
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
