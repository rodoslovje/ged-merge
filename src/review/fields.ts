import type { Dataset, Family, Individual, PersonName, Sex } from "../gedcom/types";
import { parseDate } from "../gedcom/date";
import { foldToken } from "../match/text";
import { canonicalPlaceToken } from "../match/place";
import { nameSimilarity } from "../match/similarity";
import { findEvent, fullDatesLabel, lifespanLabel, displayName } from "../match/relatives";
import { formatLifespan, isDeceased } from "../gedcom/lifespan";
import type { Translate } from "../locales/i18n";
import type { FieldRow, FieldState, RelativePair, RelativeCell } from "./types";

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
  if (key === "partners" || key.endsWith(".partner")) return t("field.partners");
  if (key === "children" || key.endsWith(".children")) return t("field.children");
  if (key === "husband") return t("field.husband");
  if (key === "wife") return t("field.wife");
  if (key === "links") return t("field.links");

  let tag = key;
  let sub = "";
  if (key.includes(".MARR.")) {
    tag = "MARR";
    sub = key.split(".MARR.")[1];
  } else {
    const parts = key.split(".");
    if (parts.length === 2) {
      tag = parts[0];
      sub = parts[1];
    }
  }

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
    pushRelativesRow(rows, "father", formatFieldLabel(t, "father"), parentRelative(master, masterDs, "husband"), parentRelative(compare, compareDs, "husband"));
    pushRelativesRow(rows, "mother", formatFieldLabel(t, "mother"), parentRelative(master, masterDs, "wife"), parentRelative(compare, compareDs, "wife"));

    const famPairs = pairFamilies(master, compare, masterDs, compareDs);
    famPairs.forEach((pair) => {
      const mFam = pair.masterFam;
      const cFam = pair.compareFam;
      const famKey = cFam ? `fam.${cFam.id}` : `fam.${mFam!.id}`;

      const mSpouseId = mFam ? (mFam.husband === master?.id ? mFam.wife : mFam.husband) : undefined;
      const cSpouseId = cFam ? (cFam.husband === compare?.id ? cFam.wife : cFam.husband) : undefined;
      const mSpouse = mSpouseId ? masterDs.individuals.get(mSpouseId) : undefined;
      const cSpouse = cSpouseId ? compareDs.individuals.get(cSpouseId) : undefined;
      const mSpouseRel = mSpouse ? [partnerToRelative(mSpouse)] : [];
      const cSpouseRel = cSpouse ? [partnerToRelative(cSpouse)] : [];

      const spouseName = displayName(mSpouse?.names[0] ?? cSpouse?.names[0]) || "?";

      rows.push({
        key: `${famKey}.header`,
        label: t("field.familyWith", { name: spouseName, defaultValue: `Family with ${spouseName}` }),
        master: "",
        incoming: "",
        state: "agree",
        isGroupHeader: true,
      });

      if (mSpouseRel.length > 0 || cSpouseRel.length > 0) {
        pushRelativesRow(rows, `${famKey}.partner`, formatFieldLabel(t, "partners"), mSpouseRel, cSpouseRel);
      }

      const mMar = mFam?.events.find((e) => e.tag === "MARR");
      const cMar = cFam?.events.find((e) => e.tag === "MARR");

      pushRow(rows, `${famKey}.MARR.date`, formatFieldLabel(t, "MARR.date"), mMar?.date?.raw, cMar?.date?.raw);
      pushRow(rows, `${famKey}.MARR.place`, formatFieldLabel(t, "MARR.place"), mMar?.place?.raw, cMar?.place?.raw);
      pushRow(rows, `${famKey}.MARR.addr`, formatFieldLabel(t, "MARR.addr"), mMar?.address?.raw, cMar?.address?.raw);

      const mChildren = mFam ? mFam.children.map(id => masterDs.individuals.get(id)).filter((i): i is Individual => !!i) : [];
      const cChildren = cFam ? cFam.children.map(id => compareDs.individuals.get(id)).filter((i): i is Individual => !!i) : [];
      const mChildRels = individualsToRelatives(mChildren);
      const cChildRels = individualsToRelatives(cChildren);

      if (mChildRels.length > 0 || cChildRels.length > 0) {
        pushRelativesRow(rows, `${famKey}.children`, formatFieldLabel(t, "children"), mChildRels, cChildRels);
      }
    });
  }
  return rows;
}

function partnerToRelative(partner: Individual): Relative {
  return {
    id: partner.id,
    name: partner.names[0],
    text: lifespanLabel(partner),
    full: fullDatesLabel(partner),
    birthYear: findEvent(partner, "BIRT")?.date?.year,
    displayName: displayName(partner.names[0]),
    years: formatLifespan(findEvent(partner, "BIRT")?.date?.year, findEvent(partner, "DEAT")?.date?.year, isDeceased(partner)),
    sex: partner.sex,
  };
}

function individualsToRelatives(indis: Individual[]): Relative[] {
  return indis
    .map((child, order) => ({ child, order, sort: birthSortKey(child) }))
    .sort((a, b) => a.sort - b.sort || a.order - b.order)
    .map(({ child }) => partnerToRelative(child));
}

interface FamPair {
  masterFam?: Family;
  compareFam?: Family;
}

function pairFamilies(
  master: Individual | undefined,
  compare: Individual | undefined,
  masterDs: Dataset,
  compareDs: Dataset
): FamPair[] {
  const mFams = master ? master.spouseOf.map(id => masterDs.families.get(id)).filter((f): f is Family => !!f) : [];
  const cFams = compare ? compare.spouseOf.map(id => compareDs.families.get(id)).filter((f): f is Family => !!f) : [];

  const cand: { mi: number; ii: number; sim: number }[] = [];

  mFams.forEach((mf, mi) => {
    cFams.forEach((cf, ii) => {
      const mSpouseId = mf.husband === master?.id ? mf.wife : mf.husband;
      const cSpouseId = cf.husband === compare?.id ? cf.wife : cf.husband;
      const mSpouse = mSpouseId ? masterDs.individuals.get(mSpouseId) : undefined;
      const cSpouse = cSpouseId ? compareDs.individuals.get(cSpouseId) : undefined;

      let sim = 0;
      if (mSpouse && cSpouse) {
         const mRel = partnerToRelative(mSpouse);
         const cRel = partnerToRelative(cSpouse);
         sim = relativeSimilarity(mRel, cRel);
      } else {
         if (mFams.length === 1 && cFams.length === 1) {
           sim = 1;
         } else {
           const mKids = mf.children.map(id => masterDs.individuals.get(id)).filter(Boolean) as Individual[];
           const cKids = cf.children.map(id => compareDs.individuals.get(id)).filter(Boolean) as Individual[];
           let matches = 0;
           mKids.forEach(mk => {
             if (cKids.some(ck => relativeSimilarity(partnerToRelative(mk), partnerToRelative(ck)) >= RELATIVE_PAIR_THRESHOLD)) {
               matches++;
             }
           });
           if (matches > 0) {
             sim = matches / Math.max(mKids.length, cKids.length);
           }
         }
      }

      if (sim >= 0.5) {
         cand.push({ mi, ii, sim });
      }
    });
  });

  cand.sort((a, b) => b.sim - a.sim);
  const matchOf = new Map<number, number>();
  const usedC = new Set<number>();
  const usedM = new Set<number>();
  for (const p of cand) {
    if (usedM.has(p.mi) || usedC.has(p.ii)) continue;
    usedM.add(p.mi);
    usedC.add(p.ii);
    matchOf.set(p.mi, p.ii);
  }

  const pairs: FamPair[] = [];
  mFams.forEach((mf, mi) => {
    const ii = matchOf.get(mi);
    pairs.push({ masterFam: mf, compareFam: ii !== undefined ? cFams[ii] : undefined });
  });
  cFams.forEach((cf, ii) => {
    if (!usedC.has(ii)) pairs.push({ compareFam: cf });
  });
  return pairs;
}

/** Sortable birth-date value (YYYYMMDD); +Infinity when no birth year is known. */
function birthSortKey(indi: Individual): number {
  const d = findEvent(indi, "BIRT")?.date;
  if (!d || d.year == null) return Number.POSITIVE_INFINITY;
  return d.year * 10000 + (d.month ?? 0) * 100 + (d.day ?? 0);
}

/** The parent (father via HUSB, mother via WIFE) from the first family this
 * person is a child in, as an alignable relative. */
function parentRelative(
  indi: Individual | undefined,
  ds: Dataset,
  role: "husband" | "wife",
): Relative[] {
  if (!indi) return [];
  for (const famId of indi.childOf) {
    const id = ds.families.get(famId)?.[role];
    const parent = id ? ds.individuals.get(id) : undefined;
    if (parent) return [{
      id: parent.id,
      name: parent.names[0],
      text: lifespanLabel(parent),
      full: fullDatesLabel(parent),
      birthYear: findEvent(parent, "BIRT")?.date?.year,
      displayName: displayName(parent.names[0]),
      years: formatLifespan(findEvent(parent, "BIRT")?.date?.year, findEvent(parent, "DEAT")?.date?.year, isDeceased(parent)),
      sex: parent.sex,
    }];
  }
  return [];
}

interface Relative {
  /** The relative's individual id, used to link/navigate to them. */
  id?: string;
  name: PersonName | undefined;
  text: string;
  /** Full-date variant for the hover tooltip; falls back to text when absent. */
  full?: string;
  /** Birth year, when known — used to align same-named relatives by birth. */
  birthYear?: number;
  /** Display name. */
  displayName?: string;
  years?: string;
  sex?: Sex;
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
  const pairs = alignRelatives(master, incoming);
  // Joined text is still kept so comparison/state and the merge's default choice
  // (master-if-present) work; rendering uses the structured `relatives` pairs.
  const m = master.length ? pairs.map((p) => p.master?.text ?? "").join("\n") : "";
  const i = incoming.length ? pairs.map((p) => p.incoming?.text ?? "").join("\n") : "";
  const state: FieldState =
    m && !i ? "master-only" : !m && i ? "incoming-only" : compareKey(m) === compareKey(i) ? "agree" : "conflict";
  rows.push({
    key,
    label,
    master: m,
    incoming: i,
    state,
    relatives: pairs,
    masterRefs: pairs.map((p) => p.master?.id),
    incomingRefs: pairs.map((p) => p.incoming?.id),
  });
}

/** One relative as an aligned cell: visible text, id, and a full-date tooltip
 *  (only when it adds detail beyond the text). */
function relativeCell(r: Relative): RelativeCell {
  return {
    text: r.text,
    id: r.id,
    title: r.full && r.full !== r.text ? r.full : undefined,
    name: r.displayName,
    years: r.years,
    sex: r.sex,
  };
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
 * first), then emit aligned pairs: matched relatives share a pair in master
 * order, master-only relatives get a pair with no incoming side, and any
 * unmatched incoming relatives are appended with no master side.
 */
function alignRelatives(master: Relative[], incoming: Relative[]): RelativePair[] {
  const cand: { mi: number; ii: number; sim: number }[] = [];
  master.forEach((m, mi) =>
    incoming.forEach((c, ii) => {
      const sim = relativeSimilarity(m, c);
      if (sim >= RELATIVE_PAIR_THRESHOLD) cand.push({ mi, ii, sim });
    }),
  );
  cand.sort((a, b) => b.sim - a.sim);

  const matchOf = new Map<number, number>(); // master index -> incoming index
  const usedIncoming = new Set<number>();
  const usedMaster = new Set<number>();
  for (const p of cand) {
    if (usedMaster.has(p.mi) || usedIncoming.has(p.ii)) continue;
    usedMaster.add(p.mi);
    usedIncoming.add(p.ii);
    matchOf.set(p.mi, p.ii);
  }

  const pairs: RelativePair[] = [];
  master.forEach((m, mi) => {
    const ii = matchOf.get(mi);
    pairs.push({
      master: relativeCell(m),
      incoming: ii !== undefined ? relativeCell(incoming[ii]) : undefined,
    });
  });
  incoming.forEach((c, ii) => {
    if (usedIncoming.has(ii)) return;
    pairs.push({ incoming: relativeCell(c) });
  });
  return pairs;
}

/**
 * Similarity of two relatives, used to align children/partners. The name (given
 * + surname) is the base signal; birth year then nudges the score so the pairing
 * lines people up by name *and* birth: a shared birth year rescues a borderline
 * name match (spelling variants of the same child), while diverging birth years
 * pull same-named siblings apart so they don't collapse onto one line.
 */
function relativeSimilarity(a: Relative, b: Relative): number {
  const nameSim = a.name && b.name
    ? nameSimilarity(a.name, b.name) ?? 0
    : foldToken(a.text) === foldToken(b.text) ? 1 : 0;

  if (a.birthYear == null || b.birthYear == null) return nameSim;
  const gap = Math.abs(a.birthYear - b.birthYear);
  const birthAdjust = gap === 0 ? 0.15 : gap <= 1 ? 0.05 : -0.25;
  return Math.max(0, Math.min(1, nameSim + birthAdjust));
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
