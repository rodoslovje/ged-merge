import type { Dataset, Family, Individual } from "../gedcom/types";
import { foldToken } from "../match/text";
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

  pushRow(rows, "children", "Children", childList(master, masterDs), childList(compare, compareDs));
  return rows;
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
  const keyFn = key.endsWith(".place") ? placeCompareKey : compareKey;
  return keyFn(master) === keyFn(incoming) ? "agree" : "conflict";
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
 * Place comparison additionally maps each jurisdiction part through a
 * country-alias table, so language variants of the country name
 * (Slovenija/Slovenia, Österreich/Austria/Avstrija) are treated as equal.
 */
function placeCompareKey(value: string): string {
  return value
    .split(",")
    .map((part) => {
      const folded = foldToken(part).replace(/\s+/g, "");
      return COUNTRY_CANONICAL.get(folded) ?? folded;
    })
    .join(",");
}

/**
 * Groups of equivalent country names (folded, diacritic-stripped, no spaces).
 * The first entry is the canonical form. Extend as needed.
 */
const COUNTRY_GROUPS: string[][] = [
  ["slovenia", "slovenija"],
  ["austria", "osterreich", "avstrija"],
  ["germany", "deutschland", "nemcija"],
  ["italy", "italia", "italija"],
  ["croatia", "hrvatska", "hrvaska"],
  ["hungary", "magyarorszag", "madzarska", "ogrska"],
  ["serbia", "srbija"],
  ["france", "francija"],
  ["switzerland", "schweiz", "svica"],
  ["unitedstates", "usa", "unitedstatesofamerica", "zda", "amerika"],
  ["yugoslavia", "jugoslavija"],
  ["austriahungary", "avstroogrska", "austrohungarianempire"],
];

const COUNTRY_CANONICAL: Map<string, string> = new Map(
  COUNTRY_GROUPS.flatMap((group) => group.map((variant) => [variant, group[0]] as const)),
);

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
