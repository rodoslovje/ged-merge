import type { Dataset, Family, Individual } from "../gedcom/types";
import { parseDate } from "../gedcom/date";
import { foldToken } from "../match/text";
import { canonicalPlaceToken } from "../match/place";
import { label, partnerNames } from "../match/relatives";
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

/** Translate internal matching keys to friendly field labels. */
export function formatFieldLabel(key: string): string {
  if (key === "given") return "Given name";
  if (key === "surname") return "Surname";
  if (key === "sex") return "Sex";
  if (key === "father") return "Father";
  if (key === "mother") return "Mother";
  if (key === "partners") return "Partner(s)";
  if (key === "children") return "Children";
  if (key === "husband") return "Husband";
  if (key === "wife") return "Wife";
  if (key === "links") return "Links";

  const [tag, sub] = key.split(".");
  const name = EVENT_LABELS[tag] ?? tag;
  if (!sub) return name;
  if (sub === "date") return `${name} date`;
  if (sub === "place") return `${name} place`;
  if (sub === "addr") return `${name} address`;
  if (sub === "links") return `${name} link`;
  return key;
}

/** Order events are displayed in; unknown tags follow, in first-seen order. */
const EVENT_ORDER = ["BIRT", "BAPM", "CHR", "RESI", "MARR", "DIV", "DEAT", "BURI", "CREM"];

/**
 * Build the comparable field rows for an individual candidate. When datasets are
 * supplied, parents and partners (resolved through the family graph) are added
 * as their own rows.
 */
export function individualFieldRows(
  master: Individual | undefined,
  compare: Individual | undefined,
  masterDs?: Dataset,
  compareDs?: Dataset,
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

  // Links (record-level and from any event, collapsed) come after the events.
  pushLinkRow(rows, "links", "Links", gatherLinks(master), gatherLinks(compare));

  // Relatives last: parents, then partners.
  if (masterDs && compareDs) {
    pushRow(rows, "father", "Father", parentName(master, masterDs, "husband"), parentName(compare, compareDs, "husband"));
    pushRow(rows, "mother", "Mother", parentName(master, masterDs, "wife"), parentName(compare, compareDs, "wife"));
    pushRow(rows, "partners", "Partner(s)", partnerList(master, masterDs), partnerList(compare, compareDs));
  }
  return rows;
}

/** Full name of a parent (father via HUSB, mother via WIFE) from the first
 * family this person is a child in. */
function parentName(
  indi: Individual | undefined,
  ds: Dataset,
  role: "husband" | "wife",
): string {
  if (!indi) return "";
  for (const famId of indi.childOf) {
    const id = ds.families.get(famId)?.[role];
    const n = id ? ds.individuals.get(id)?.names[0]?.full : undefined;
    if (n) return n;
  }
  return "";
}

/** Semicolon-joined full names of this person's spouses. */
function partnerList(indi: Individual | undefined, ds: Dataset): string {
  if (!indi) return "";
  return partnerNames(indi, ds)
    .map((n) => n.full)
    .filter(Boolean)
    .join("; ");
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

  // All links (family-level and from any family event) collapse into one field.
  pushLinkRow(rows, "links", "Links", gatherLinks(master), gatherLinks(compare));

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
 *  - `linkCount` = attached-link rows the compare adds or that differ
 *
 * Links are tallied separately (not folded into new/diff) so the matches list
 * can surface and filter on them as their own dimension.
 */
export function fieldDiffCounts(
  rows: FieldRow[],
): { newCount: number; diffCount: number; linkCount: number } {
  let newCount = 0;
  let diffCount = 0;
  let linkCount = 0;
  for (const row of rows) {
    const isLink = row.masterLinks !== undefined || row.incomingLinks !== undefined;
    if (isLink) {
      if (row.state === "incoming-only" || row.state === "conflict") linkCount++;
    } else if (row.state === "incoming-only") newCount++;
    else if (row.state === "conflict") diffCount++;
  }
  return { newCount, diffCount, linkCount };
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

/**
 * A row whose values are attached links, rendered as clickable icons. The
 * state drives the New/Diff counts: incoming has a link the master lacks =
 * "incoming-only" (New); the two sides' link sets differ = "conflict" (Diff).
 */
function pushLinkRow(
  rows: FieldRow[],
  key: string,
  label: string,
  master: string[] | undefined,
  incoming: string[] | undefined,
): void {
  const m = master ?? [];
  const i = incoming ?? [];
  if (m.length === 0 && i.length === 0) return;
  rows.push({
    key,
    label,
    // Keep a text form so the default merge choice (master-if-present) works.
    master: m.join("\n"),
    incoming: i.join("\n"),
    state: linkState(m, i),
    masterLinks: m,
    incomingLinks: i,
  });
}

/**
 * Every link reachable from a record — attached directly or to any of its
 * events — gathered into one list, de-duplicated (case- and trailing-slash
 * insensitive), preserving first-seen order.
 */
function gatherLinks(record: Individual | Family | undefined): string[] {
  if (!record) return [];
  const all: string[] = [...(record.links ?? [])];
  for (const e of record.events) if (e.links) all.push(...e.links);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of all) {
    const key = linkKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

function linkState(master: string[], incoming: string[]): FieldState {
  const m = new Set(master.map(linkKey));
  const i = new Set(incoming.map(linkKey));
  if (m.size && !i.size) return "master-only";
  if (!m.size && i.size) return "incoming-only";
  const same = m.size === i.size && [...m].every((x) => i.has(x));
  return same ? "agree" : "conflict";
}

/** Normalize a URL for set comparison: case-fold and drop a trailing slash. */
function linkKey(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, "");
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
