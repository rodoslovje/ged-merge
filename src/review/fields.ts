import type { Dataset, Family, Individual } from "../gedcom/types";
import { parseDate } from "../gedcom/date";
import { foldToken } from "../match/text";
import { canonicalPlaceToken } from "../match/place";
import { label } from "../match/relatives";
import type { FieldRow, FieldState } from "./types";

/** Friendly labels for the event tags we surface in review. */
const EVENT_LABELS: Record<string, string> = {
  BIRT: "Birth",
  BAPM: "Baptism",
  CHR: "Christening",
  DEAT: "Death",
  BURI: "Burial",
  CREM: "Cremation",
  MARR: "Marriage",
  DIV: "Divorce",
  RESI: "Residence",
};

/** Order events are displayed in; unknown tags follow, in first-seen order. */
const EVENT_ORDER = ["BIRT", "BAPM", "CHR", "RESI", "MARR", "DIV", "DEAT", "BURI", "CREM"];

/** Build the comparable field rows for an individual candidate. */
export function individualFieldRows(
  master: Individual | undefined,
  compare: Individual | undefined,
): FieldRow[] {
  const rows: FieldRow[] = [];
  const mn = master?.names[0];
  const cn = compare?.names[0];

  pushRow(rows, "given", "Given name", mn?.given, cn?.given);
  pushRow(rows, "surname", "Surname", mn?.surname, cn?.surname);
  pushRow(rows, "sex", "Sex", sexText(master?.sex), sexText(compare?.sex));

  for (const tag of orderedEventTags(master, compare)) {
    const me = master?.events.find((e) => e.tag === tag);
    const ce = compare?.events.find((e) => e.tag === tag);
    const name = EVENT_LABELS[tag] ?? tag;
    pushRow(rows, `${tag}.date`, `${name} date`, me?.date?.raw, ce?.date?.raw);
    pushRow(rows, `${tag}.place`, `${name} place`, me?.place?.raw, ce?.place?.raw);
    pushRow(rows, `${tag}.addr`, `${name} address`, me?.address?.raw, ce?.address?.raw);
  }
  return rows;
}

/** Build the comparable field rows for a family candidate. */
export function familyFieldRows(
  master: Family | undefined,
  compare: Family | undefined,
  masterDs: Dataset,
  compareDs: Dataset,
): FieldRow[] {
  const rows: FieldRow[] = [];

  pushRow(rows, "husband", "Husband", spouse(master?.husband, masterDs), spouse(compare?.husband, compareDs));
  pushRow(rows, "wife", "Wife", spouse(master?.wife, masterDs), spouse(compare?.wife, compareDs));

  const mm = master?.events.find((e) => e.tag === "MARR");
  const cm = compare?.events.find((e) => e.tag === "MARR");
  pushRow(rows, "MARR.date", "Marriage date", mm?.date?.raw, cm?.date?.raw);
  pushRow(rows, "MARR.place", "Marriage place", mm?.place?.raw, cm?.place?.raw);
  pushRow(rows, "MARR.addr", "Marriage address", mm?.address?.raw, cm?.address?.raw);

  pushRow(rows, "children", "Children", childList(master, masterDs), childList(compare, compareDs));
  return rows;
}

/**
 * Summary counts over a set of field rows:
 *  - `newCount`  = fields the compare record has but the master lacks (to add)
 *  - `diffCount` = fields both have but that differ (to reconcile)
 */
export function fieldDiffCounts(rows: FieldRow[]): { newCount: number; diffCount: number } {
  let newCount = 0;
  let diffCount = 0;
  for (const row of rows) {
    if (row.state === "incoming-only") newCount++;
    else if (row.state === "conflict") diffCount++;
  }
  return { newCount, diffCount };
}

// --- helpers ---------------------------------------------------------------

function pushRow(
  rows: FieldRow[],
  key: string,
  label: string,
  master: string | undefined,
  incoming: string | undefined,
): void {
  const m = (master ?? "").trim();
  const i = (incoming ?? "").trim();
  if (!m && !i) return; // nothing to show
  rows.push({ key, label, master: m, incoming: i, state: stateOf(key, m, i) });
}

function stateOf(key: string, master: string, incoming: string): FieldState {
  if (master && !incoming) return "master-only";
  if (!master && incoming) return "incoming-only";
  const keyFn = key.endsWith(".place")
    ? placeCompareKey
    : key.endsWith(".date")
      ? dateCompareKey
      : compareKey;
  return keyFn(master) === keyFn(incoming) ? "agree" : "conflict";
}

/**
 * Date comparison is semantic: equivalent expressions agree regardless of
 * spelling ("Abt. 1900" = "ABT 1900" = "About 1900"). Unparseable dates fall
 * back to a whitespace-insensitive text comparison.
 */
function dateCompareKey(value: string): string {
  const d = parseDate(value);
  if (d.qualifier === "unknown") return compareKey(value);
  return [d.qualifier, d.year, d.month, d.day, d.year2, d.month2, d.day2].join("|");
}

/**
 * Normalize a value for comparison. Whitespace-only differences (extra spaces,
 * spaces around commas/slashes) are not real conflicts, so all whitespace is
 * removed after folding case and diacritics.
 */
function compareKey(value: string): string {
  return foldToken(value).replace(/\s+/g, "");
}

/**
 * Place comparison maps each jurisdiction part through the shared country-alias
 * canonicalization (Slovenija/Slovenia, Österreich/Austria) and drops repeated
 * parts, so more or less detailed spellings of the same place agree — e.g.
 * "Kranj, Kranj, Slovenia" (town + like-named municipality) equals "Kranj,
 * Slovenia".
 */
function placeCompareKey(value: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const part of value.split(",")) {
    const canon = canonicalPlaceToken(part);
    if (!canon || seen.has(canon)) continue;
    seen.add(canon);
    parts.push(canon);
  }
  return parts.join(",");
}

function orderedEventTags(master?: Individual, compare?: Individual): string[] {
  const present = new Set<string>();
  for (const e of master?.events ?? []) present.add(e.tag);
  for (const e of compare?.events ?? []) present.add(e.tag);
  const known = EVENT_ORDER.filter((t) => present.has(t));
  const extra = [...present].filter((t) => !EVENT_ORDER.includes(t)).sort();
  return [...known, ...extra];
}

function sexText(sex: string | undefined): string {
  if (sex === "M") return "Male";
  if (sex === "F") return "Female";
  return "";
}

function spouse(id: string | undefined, ds: Dataset): string {
  const indi = id ? ds.individuals.get(id) : undefined;
  return indi ? label(indi) : "";
}

function childList(fam: Family | undefined, ds: Dataset): string {
  if (!fam) return "";
  return fam.children
    .map((id) => ds.individuals.get(id))
    .filter((i): i is Individual => i !== undefined)
    .map((i) => label(i))
    .join("; ");
}
