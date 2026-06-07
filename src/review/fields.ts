import type { Dataset, Family, Individual, PersonName } from "../gedcom/types";
import { parseDate } from "../gedcom/date";
import { foldToken } from "../match/text";
import { canonicalPlaceToken } from "../match/place";
import { nameSimilarity } from "../match/similarity";
import { label, partnerNames } from "../match/relatives";
import type { Translate } from "../locales/i18n";
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
export function formatFieldLabel(t: Translate, key: string): string {
  if (key === "given") return t("field.given");
  if (key === "surname") return t("field.surname");
  if (key === "sex") return t("field.sex");
  if (key === "father") return t("field.father");
  if (key === "mother") return t("field.mother");
  if (key === "partners") return t("field.partners");
  if (key === "children") return t("field.children");
  if (key === "husband") return t("field.husband");
  if (key === "wife") return t("field.wife");
  if (key === "links") return t("field.links");

  const [tag, sub] = key.split(".");
  const name = t(`event.${tag}`, { defaultValue: EVENT_LABELS[tag] ?? tag });
  if (!sub) return name;
  if (sub === "date") return t("event.date", { event: name });
  if (sub === "place") return t("event.place", { event: name });
  if (sub === "addr") return t("event.addr", { event: name });
  if (sub === "links") return t("event.link", { event: name });
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
  t: Translate,
  master: Individual | undefined,
  compare: Individual | undefined,
  masterDs?: Dataset,
  compareDs?: Dataset,
): FieldRow[] {
  const rows: FieldRow[] = [];
  const mn = master?.names[0];
  const cn = compare?.names[0];

  pushRow(rows, "given", formatFieldLabel(t, "given"), mn?.given, cn?.given);
  pushRow(rows, "surname", formatFieldLabel(t, "surname"), mn?.surname, cn?.surname);
  pushRow(rows, "sex", formatFieldLabel(t, "sex"), sexText(t, master?.sex), sexText(t, compare?.sex));

  for (const tag of orderedEventTags(master, compare)) {
    const me = master?.events.find((e) => e.tag === tag);
    const ce = compare?.events.find((e) => e.tag === tag);
    pushRow(rows, `${tag}.date`, formatFieldLabel(t, `${tag}.date`), me?.date?.raw, ce?.date?.raw);
    pushRow(rows, `${tag}.place`, formatFieldLabel(t, `${tag}.place`), me?.place?.raw, ce?.place?.raw);
    pushRow(rows, `${tag}.addr`, formatFieldLabel(t, `${tag}.addr`), me?.address?.raw, ce?.address?.raw);
  }

  // Links (record-level and from any event, collapsed) come after the events.
  pushLinkRow(rows, "links", formatFieldLabel(t, "links"), gatherLinks(master), gatherLinks(compare));

  // Relatives last: parents, partner(s), the marriage facts, then children.
  // Marriage and children live on the FAM record but are reconciled here on the
  // spouse so every decision about a person is made in one place.
  if (masterDs && compareDs) {
    pushRow(rows, "father", formatFieldLabel(t, "father"), parentName(master, masterDs, "husband"), parentName(compare, compareDs, "husband"));
    pushRow(rows, "mother", formatFieldLabel(t, "mother"), parentName(master, masterDs, "wife"), parentName(compare, compareDs, "wife"));
    pushRelativesRow(rows, "partners", formatFieldLabel(t, "partners"), partnerRelatives(master, masterDs), partnerRelatives(compare, compareDs));

    const mMar = primaryMarriage(master, masterDs);
    const cMar = primaryMarriage(compare, compareDs);
    pushRow(rows, "MARR.date", formatFieldLabel(t, "MARR.date"), mMar?.date?.raw, cMar?.date?.raw);
    pushRow(rows, "MARR.place", formatFieldLabel(t, "MARR.place"), mMar?.place?.raw, cMar?.place?.raw);
    pushRow(rows, "MARR.addr", formatFieldLabel(t, "MARR.addr"), mMar?.address?.raw, cMar?.address?.raw);

    pushRelativesRow(rows, "children", formatFieldLabel(t, "children"), personChildRelatives(master, masterDs), personChildRelatives(compare, compareDs));
  }
  return rows;
}

/** The MARR event of the first family this person is a spouse in that has one. */
function primaryMarriage(indi: Individual | undefined, ds: Dataset) {
  if (!indi) return undefined;
  for (const famId of indi.spouseOf) {
    const m = ds.families.get(famId)?.events.find((e) => e.tag === "MARR");
    if (m) return m;
  }
  return undefined;
}

/** This person's children across all their families, as alignable relatives. */
function personChildRelatives(indi: Individual | undefined, ds: Dataset): Relative[] {
  if (!indi) return [];
  const seen = new Set<string>();
  const out: Relative[] = [];
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    for (const cid of fam.children) {
      if (seen.has(cid)) continue;
      const child = ds.individuals.get(cid);
      if (!child) continue;
      seen.add(cid);
      out.push({ name: child.names[0], text: label(child) });
    }
  }
  return out;
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

/**
 * A relative shown in an aligned list: the structured name used to pair the two
 * sides, plus the text rendered to the user.
 */
interface Relative {
  name: PersonName | undefined;
  text: string;
}

/** This person's spouses as alignable relatives. */
function partnerRelatives(indi: Individual | undefined, ds: Dataset): Relative[] {
  if (!indi) return [];
  return partnerNames(indi, ds)
    .filter((n) => n.full)
    .map((n) => ({ name: n, text: n.full }));
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
 * Push a list-of-relatives row (partners, children) whose two sides are *aligned*
 * by name: a master relative and its closest incoming counterpart share a line,
 * while relatives with no match on the other side get a line of their own (the
 * opposite cell left blank). This lines matching people up so differences and
 * additions are easy to spot. Blank-padding is kept out of the emptiness/state
 * test so a one-sided list still reads as master-/incoming-only.
 */
function pushRelativesRow(
  rows: FieldRow[],
  key: string,
  label: string,
  master: Relative[],
  incoming: Relative[],
): void {
  if (master.length === 0 && incoming.length === 0) return;
  const { masterLines, incomingLines } = alignRelatives(master, incoming);
  const m = master.length ? masterLines.join("\n") : "";
  const i = incoming.length ? incomingLines.join("\n") : "";
  const state: FieldState =
    m && !i ? "master-only" : !m && i ? "incoming-only" : compareKey(m) === compareKey(i) ? "agree" : "conflict";
  rows.push({ key, label, master: m, incoming: i, state });
}

/**
 * Minimum name similarity for two relatives to be paired onto the same line.
 * Set high because relatives typically share a surname (which alone scores ~0.6),
 * so distinguishing the same person from a same-surname sibling rests on the
 * given name: this threshold demands a strong given-name agreement too, pairing
 * spelling variants (Ana/Anna) while keeping distinct siblings (Berta/Doris) apart.
 */
const RELATIVE_PAIR_THRESHOLD = 0.85;

/**
 * Greedily pair master and incoming relatives by name similarity (best pairs
 * first), then emit aligned line arrays: matched pairs on a shared line in master
 * order, master-only relatives with a blank incoming line, and any unmatched
 * incoming relatives appended with a blank master line.
 */
function alignRelatives(
  master: Relative[],
  incoming: Relative[],
): { masterLines: string[]; incomingLines: string[] } {
  const pairs: { mi: number; ii: number; sim: number }[] = [];
  master.forEach((m, mi) =>
    incoming.forEach((c, ii) => {
      const sim = relativeSimilarity(m, c);
      if (sim >= RELATIVE_PAIR_THRESHOLD) pairs.push({ mi, ii, sim });
    }),
  );
  pairs.sort((a, b) => b.sim - a.sim);

  const matchOf = new Map<number, number>(); // master index -> incoming index
  const usedIncoming = new Set<number>();
  const usedMaster = new Set<number>();
  for (const p of pairs) {
    if (usedMaster.has(p.mi) || usedIncoming.has(p.ii)) continue;
    usedMaster.add(p.mi);
    usedIncoming.add(p.ii);
    matchOf.set(p.mi, p.ii);
  }

  const masterLines: string[] = [];
  const incomingLines: string[] = [];
  master.forEach((m, mi) => {
    masterLines.push(m.text);
    const ii = matchOf.get(mi);
    incomingLines.push(ii !== undefined ? incoming[ii].text : "");
  });
  incoming.forEach((c, ii) => {
    if (usedIncoming.has(ii)) return;
    masterLines.push("");
    incomingLines.push(c.text);
  });
  return { masterLines, incomingLines };
}

/** Similarity of two relatives: structured-name based, with a text fallback. */
function relativeSimilarity(a: Relative, b: Relative): number {
  if (a.name && b.name) return nameSimilarity(a.name, b.name) ?? 0;
  return foldToken(a.text) === foldToken(b.text) ? 1 : 0;
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

function sexText(t: Translate, sex: string | undefined): string {
  if (sex === "M") return t("sex.M");
  if (sex === "F") return t("sex.F");
  return "";
}

