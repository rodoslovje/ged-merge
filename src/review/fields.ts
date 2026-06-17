import type { Dataset, Family, GedDate, GedEvent, Individual, PersonName, Sex } from "../gedcom/types";
import { parseDate } from "../gedcom/date";
import { foldToken } from "../match/text";
import { canonicalPlaceToken } from "../match/place";
import { nameSimilarity } from "../match/similarity";
import { findEvent, fullDatesLabel, lifespanLabel, displayName, nameTypeLabel } from "../match/relatives";
import { formatLifespan, isDeceased } from "../gedcom/lifespan";
import type { Translate } from "../locales/i18n";
import type { FieldRow, FieldState, RelativePair, RelativeCell } from "./types";

/** Friendly labels for the event tags we surface in review. */
const EVENT_LABELS: Record<string, string> = {
  BIRT: "Birth",
  BAPM: "Baptism",
  CHR: "Christening",
  CONF: "Confirmation",
  ADOP: "Adoption",
  FCOM: "First Communion",
  OCCU: "Occupation",
  EDUC: "Education",
  RETI: "Retirement",
  RESI: "Residence",
  EMIG: "Emigration",
  IMMI: "Immigration",
  NATU: "Naturalization",
  CENS: "Census",
  WILL: "Will",
  PROB: "Probate",
  DEAT: "Death",
  BURI: "Burial",
  CREM: "Cremation",
  MARR: "Marriage",
  ENGA: "Engagement",
  SEPA: "Separation",
  DIV: "Divorce",
};

/** Translate internal matching keys to friendly field labels. */
export function formatFieldLabel(t: Translate, key: string): string {
  if (key === "given") return t("field.given");
  if (key === "surname") return t("field.surname");
  if (key === "sex") return t("field.sex");
  if (key === "nickname") return t("field.nickname");
  if (key === "additionalNames") return t("field.additionalNames");
  if (key === "father") return t("field.father");
  if (key === "mother") return t("field.mother");
  if (key === "partners" || key.endsWith(".partner")) return t("field.partners");
  if (key === "children" || key.endsWith(".children")) return t("field.children");
  if (key === "husband") return t("field.husband");
  if (key === "wife") return t("field.wife");
  if (key === "links") return t("field.links");
  if (key === "notes" || key.endsWith(".notes")) return t("field.notes");

  let tag = key;
  let sub = "";
  // Handles family event keys: fam.<id>.MARR.date, fam.<id>.ENGA.place, etc.
  const famEventMatch = /\.([A-Z]+)\.([a-z]+)$/.exec(key);
  if (famEventMatch) {
    tag = famEventMatch[1];
    sub = famEventMatch[2];
  } else {
    const parts = key.split(".");
    if (parts.length === 2) {
      tag = parts[0];
      sub = parts[1];
    }
  }

  const name = t(`event.${tag}`, { defaultValue: EVENT_LABELS[tag] ?? tag });
  if (!sub) return name;
  if (sub === "value") return name;
  if (sub === "date") return t("event.date", { event: name });
  if (sub === "place") return t("event.place", { event: name });
  if (sub === "addr") return t("event.addr", { event: name });
  if (sub === "links") return t("event.link", { event: name });
  return key;
}

/** Order events are displayed in; unknown tags follow, in first-seen order. */
const EVENT_ORDER = [
  "BIRT", "BAPM", "CHR", "CONF", "ADOP", "FCOM",
  "OCCU", "EDUC", "RETI",
  "RESI", "EMIG", "IMMI", "NATU", "CENS",
  "WILL", "PROB",
  "DEAT", "BURI", "CREM",
];

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
  pushRow(rows, "nickname", formatFieldLabel(t, "nickname"), mn?.nickname, cn?.nickname);
  const mExtraNames = master?.names.slice(1) ?? [];
  const cExtraNames = compare?.names.slice(1) ?? [];
  if (mExtraNames.length || cExtraNames.length) {
    const mText = mExtraNames.map((n) => extraNameText(n, t)).join("\n") || undefined;
    const cText = cExtraNames.map((n) => extraNameText(n, t)).join("\n") || undefined;
    pushRow(rows, "additionalNames", formatFieldLabel(t, "additionalNames"), mText, cText);
  }

  // Record-level links and notes before events.
  pushLinkRow(rows, "links", formatFieldLabel(t, "links"), gatherLinks(master), gatherLinks(compare));
  pushRow(rows, "notes", formatFieldLabel(t, "notes"), master?.notes?.join("\n"), compare?.notes?.join("\n"));

  for (const { tag, masterIdx, compareIdx, keyIdx, multi } of orderedEventTags(master, compare)) {
    const masterEvents = master?.events.filter((e) => e.tag === tag) ?? [];
    const compareEvents = compare?.events.filter((e) => e.tag === tag) ?? [];
    const me = masterIdx >= 0 ? masterEvents[masterIdx] : undefined;
    const ce = compareIdx >= 0 ? compareEvents[compareIdx] : undefined;
    const keyBase = multi ? `${tag}.${keyIdx}` : tag;
    const eventLabel = t(`event.${tag}`, { defaultValue: EVENT_LABELS[tag] ?? tag });
    const subRows: FieldRow[] = [];
    pushRow(subRows, `${keyBase}.value`, formatFieldLabel(t, `${tag}.value`), me?.value, ce?.value);
    pushRow(subRows, `${keyBase}.date`, formatFieldLabel(t, `${tag}.date`), me?.date?.raw, ce?.date?.raw, t("event.colDate"));
    pushRow(subRows, `${keyBase}.place`, formatFieldLabel(t, `${tag}.place`), me?.place?.raw, ce?.place?.raw, t("event.colPlace"));
    // If one side's address is embedded in the other's combined place string, treat as matching.
    const mAddr = me?.address?.raw;
    const cAddr = ce?.address?.raw;
    const effectiveMAddr = !mAddr && cAddr && placeContainsAddr(me?.place?.raw, cAddr) ? cAddr : mAddr;
    const effectiveCAddr = !cAddr && mAddr && placeContainsAddr(ce?.place?.raw, mAddr) ? mAddr : cAddr;
    pushRow(subRows, `${keyBase}.addr`, formatFieldLabel(t, `${tag}.addr`), effectiveMAddr, effectiveCAddr, t("event.colAddr"));
    if (subRows.length > 0) {
      const mLinks = me?.links?.length ? me.links : undefined;
      const cLinks = ce?.links?.length ? ce.links : undefined;
      if (mLinks || cLinks) {
        subRows[0] = {
          ...subRows[0],
          ...(mLinks ? { masterLinkIcons: mLinks } : {}),
          ...(cLinks ? { incomingLinkIcons: cLinks } : {}),
        };
      }
      rows.push({ key: `${keyBase}.header`, label: eventLabel, master: "", incoming: "", state: "agree", isGroupHeader: true, isEventHeader: true });
      rows.push(...subRows);
    }
  }

  // Relatives last: parents, partner(s), the marriage facts, then children.
  // Marriage and children live on the FAM record but are reconciled here on the
  // spouse so every decision about a person is made in one place.
  if (masterDs && compareDs) {
    const parentRows: FieldRow[] = [];
    pushRelativesRow(parentRows, "father", formatFieldLabel(t, "father"), parentRelative(master, masterDs, "husband"), parentRelative(compare, compareDs, "husband"));
    pushRelativesRow(parentRows, "mother", formatFieldLabel(t, "mother"), parentRelative(master, masterDs, "wife"), parentRelative(compare, compareDs, "wife"));
    if (parentRows.length > 0) {
      rows.push({ key: "parents.header", label: t("field.parents"), master: "", incoming: "", state: "agree", isGroupHeader: true });
      rows.push(...parentRows);
    }

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
      const marriageRows: FieldRow[] = [];
      pushRow(marriageRows, `${famKey}.MARR.date`, formatFieldLabel(t, `${famKey}.MARR.date`), mMar?.date?.raw, cMar?.date?.raw);
      pushRow(marriageRows, `${famKey}.MARR.place`, formatFieldLabel(t, `${famKey}.MARR.place`), mMar?.place?.raw, cMar?.place?.raw);
      pushRow(marriageRows, `${famKey}.MARR.addr`, formatFieldLabel(t, `${famKey}.MARR.addr`), mMar?.address?.raw, cMar?.address?.raw);
      if (marriageRows.length > 0) {
        const mMarLinks = mMar?.links?.length ? mMar.links : undefined;
        const cMarLinks = cMar?.links?.length ? cMar.links : undefined;
        if (mMarLinks || cMarLinks) {
          marriageRows[0] = {
            ...marriageRows[0],
            ...(mMarLinks ? { masterLinkIcons: mMarLinks } : {}),
            ...(cMarLinks ? { incomingLinkIcons: cMarLinks } : {}),
          };
        }
        rows.push({ key: `${famKey}.MARR.header`, label: t("event.MARR", { defaultValue: "Marriage" }), master: "", incoming: "", state: "agree", isGroupHeader: true, isEventHeader: true });
        rows.push(...marriageRows);
      }

      for (const etag of ["ENGA", "SEPA", "DIV"] as const) {
        const mEv = mFam?.events.find((e) => e.tag === etag);
        const cEv = cFam?.events.find((e) => e.tag === etag);
        if (!mEv && !cEv) continue;
        const etagRows: FieldRow[] = [];
        pushRow(etagRows, `${famKey}.${etag}.date`, formatFieldLabel(t, `${famKey}.${etag}.date`), mEv?.date?.raw, cEv?.date?.raw);
        pushRow(etagRows, `${famKey}.${etag}.place`, formatFieldLabel(t, `${famKey}.${etag}.place`), mEv?.place?.raw, cEv?.place?.raw);
        pushRow(etagRows, `${famKey}.${etag}.addr`, formatFieldLabel(t, `${famKey}.${etag}.addr`), mEv?.address?.raw, cEv?.address?.raw);
        if (etagRows.length > 0) {
          const mEvLinks = mEv?.links?.length ? mEv.links : undefined;
          const cEvLinks = cEv?.links?.length ? cEv.links : undefined;
          if (mEvLinks || cEvLinks) {
            etagRows[0] = {
              ...etagRows[0],
              ...(mEvLinks ? { masterLinkIcons: mEvLinks } : {}),
              ...(cEvLinks ? { incomingLinkIcons: cEvLinks } : {}),
            };
          }
          rows.push({ key: `${famKey}.${etag}.header`, label: t(`event.${etag}`, { defaultValue: EVENT_LABELS[etag] ?? etag }), master: "", incoming: "", state: "agree", isGroupHeader: true, isEventHeader: true });
          rows.push(...etagRows);
        }
      }

      const mFamNotes = mFam?.notes?.join("\n");
      const cFamNotes = cFam?.notes?.join("\n");
      pushRow(rows, `${famKey}.notes`, formatFieldLabel(t, `${famKey}.notes`), mFamNotes, cFamNotes);

      const mChildren = mFam ? mFam.children.map(id => masterDs.individuals.get(id)).filter((i): i is Individual => !!i) : [];
      const cChildren = cFam ? cFam.children.map(id => compareDs.individuals.get(id)).filter((i): i is Individual => !!i) : [];
      const mChildRels = individualsToRelatives(mChildren);
      const cChildRels = individualsToRelatives(cChildren);

      if (mChildRels.length > 0 || cChildRels.length > 0) {
        rows.push({ key: `${famKey}.children.header`, label: t("field.children"), master: "", incoming: "", state: "agree", isGroupHeader: true, isEventHeader: true });
        pushRelativesRow(rows, `${famKey}.children`, formatFieldLabel(t, "children"), mChildRels, cChildRels, "");
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
 *  - `linkCount` = attached links the compare has that the master lacks
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
      const masterKeys = new Set((row.masterLinks ?? []).map(linkKey));
      if ((row.incomingLinks ?? []).some((url) => !masterKeys.has(linkKey(url)))) linkCount++;
    } else if (row.state === "incoming-only") newCount++;
    else if (row.state === "conflict") diffCount++;
    if (row.masterLinkIcons || row.incomingLinkIcons) {
      const masterIconKeys = new Set((row.masterLinkIcons ?? []).map(linkKey));
      if ((row.incomingLinkIcons ?? []).some((url) => !masterIconKeys.has(linkKey(url)))) linkCount++;
    }
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
  displayLabel?: string,
): void {
  const m = (master ?? "").trim();
  const i = (incoming ?? "").trim();
  if (!m && !i) return; // nothing to show
  rows.push({ key, label, master: m, incoming: i, state: stateOf(key, m, i), displayLabel });
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
  displayLabel?: string,
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
    ...(displayLabel !== undefined ? { displayLabel } : {}),
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
 * Record-level links only (event links are shown per-event in their header rows).
 */
function gatherLinks(record: Individual | Family | undefined): string[] {
  if (!record) return [];
  const all: string[] = [...(record.links ?? [])];
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

/** Matches the language-code path segment of a Matricula Online URL, e.g. ".../sl/slovenia/...". */
const MATRICULA_LANG_RE = /^(https?:\/\/data\.matricula-online\.eu)\/([a-z]{2})\//;

/**
 * Normalize a URL for set comparison: case-fold, drop a trailing slash, and
 * ignore the language code in Matricula Online URLs (e.g. /sl/ vs /de/)
 * since they link to the same record in different UI languages.
 */
export function linkKey(url: string): string {
  const key = url.trim().toLowerCase().replace(/\/+$/, "");
  return key.replace(MATRICULA_LANG_RE, "$1/xx/");
}

/** The language code a Matricula Online URL uses, if it is one. */
export function matriculaLangCode(url: string): string | undefined {
  return MATRICULA_LANG_RE.exec(url.trim().toLowerCase())?.[2];
}

/** Rewrite a Matricula Online URL to use the given language code. */
export function withMatriculaLang(url: string, lang: string): string {
  return url.replace(MATRICULA_LANG_RE, `$1/${lang}/`);
}

function extraNameText(n: import("../gedcom/types").PersonName, t: Translate): string {
  const name = displayName(n);
  return n.type ? `${name} (${nameTypeLabel(n.type, t)})` : name;
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

function orderedEventTags(
  master?: Individual,
  compare?: Individual,
): Array<{ tag: string; masterIdx: number; compareIdx: number; keyIdx: number; multi: boolean }> {
  const mEvents = master?.events ?? [];
  const cEvents = compare?.events ?? [];

  const mByTag = new Map<string, GedEvent[]>();
  const cByTag = new Map<string, GedEvent[]>();
  for (const e of mEvents) { const a = mByTag.get(e.tag) ?? []; a.push(e); mByTag.set(e.tag, a); }
  for (const e of cEvents) { const a = cByTag.get(e.tag) ?? []; a.push(e); cByTag.set(e.tag, a); }

  const allTags = new Set([...mByTag.keys(), ...cByTag.keys()]);
  type Instance = { tag: string; masterIdx: number; compareIdx: number; keyIdx: number; multi: boolean };
  const instances: Instance[] = [];

  for (const tag of allTags) {
    const mTagEvs = mByTag.get(tag) ?? [];
    const cTagEvs = cByTag.get(tag) ?? [];
    const multi = Math.max(mTagEvs.length, cTagEvs.length) > 1;

    if (!multi) {
      const mIdx = mTagEvs.length > 0 ? 0 : -1;
      const cIdx = cTagEvs.length > 0 ? 0 : -1;
      // When both sides have a dated event and the pair scores too low, show them separately.
      if (mIdx >= 0 && cIdx >= 0
          && mTagEvs[0].date?.year != null && cTagEvs[0].date?.year != null
          && eventPairScore(mTagEvs[0], cTagEvs[0]) < MIN_EVENT_PAIR_SCORE) {
        instances.push({ tag, masterIdx: 0, compareIdx: -1, keyIdx: 0, multi: true });
        instances.push({ tag, masterIdx: -1, compareIdx: 0, keyIdx: 1, multi: true });
      } else {
        instances.push({ tag, masterIdx: mIdx, compareIdx: cIdx, keyIdx: 0, multi: false });
      }
    } else {
      // Pair events by date+place similarity instead of positional index.
      const pairs = pairEventsByDatePlace(mTagEvs, cTagEvs);
      const usedM = new Set(pairs.map(p => p.mi));
      const usedC = new Set(pairs.map(p => p.ci));
      let keyIdx = 0;
      for (const { mi, ci } of pairs) instances.push({ tag, masterIdx: mi, compareIdx: ci, keyIdx: keyIdx++, multi: true });
      for (let mi = 0; mi < mTagEvs.length; mi++) if (!usedM.has(mi)) instances.push({ tag, masterIdx: mi, compareIdx: -1, keyIdx: keyIdx++, multi: true });
      for (let ci = 0; ci < cTagEvs.length; ci++) if (!usedC.has(ci)) instances.push({ tag, masterIdx: -1, compareIdx: ci, keyIdx: keyIdx++, multi: true });
    }
  }

  instances.sort((a, b) => {
    const me = a.masterIdx >= 0 ? (mByTag.get(a.tag) ?? [])[a.masterIdx] : undefined;
    const ce = a.compareIdx >= 0 ? (cByTag.get(a.tag) ?? [])[a.compareIdx] : undefined;
    const me2 = b.masterIdx >= 0 ? (mByTag.get(b.tag) ?? [])[b.masterIdx] : undefined;
    const ce2 = b.compareIdx >= 0 ? (cByTag.get(b.tag) ?? [])[b.compareIdx] : undefined;
    const dateA = eventSortKey(me, ce);
    const dateB = eventSortKey(me2, ce2);
    if (dateA !== dateB) return dateA - dateB;
    const posA = EVENT_ORDER.indexOf(a.tag);
    const posB = EVENT_ORDER.indexOf(b.tag);
    return (posA === -1 ? 999 : posA) - (posB === -1 ? 999 : posB) || a.keyIdx - b.keyIdx;
  });

  return instances;
}

function eventSortKey(me: GedEvent | undefined, ce: GedEvent | undefined): number {
  const d = me?.date ?? ce?.date;
  if (d?.year != null) return d.year * 10000 + (d.month ?? 0) * 100 + (d.day ?? 0);
  return 9_999_999;
}

/** Minimum score for two events to be considered the same event. Below this they are shown separately. */
const MIN_EVENT_PAIR_SCORE = 0.35;

/** Greedy bipartite matching of events by date+place similarity. */
function pairEventsByDatePlace(
  masterEvents: GedEvent[],
  compareEvents: GedEvent[],
): { mi: number; ci: number }[] {
  const cands: { mi: number; ci: number; score: number }[] = [];
  for (let mi = 0; mi < masterEvents.length; mi++) {
    for (let ci = 0; ci < compareEvents.length; ci++) {
      const score = eventPairScore(masterEvents[mi], compareEvents[ci]);
      if (score >= MIN_EVENT_PAIR_SCORE) cands.push({ mi, ci, score });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const usedM = new Set<number>();
  const usedC = new Set<number>();
  const pairs: { mi: number; ci: number }[] = [];
  for (const { mi, ci } of cands) {
    if (usedM.has(mi) || usedC.has(ci)) continue;
    usedM.add(mi);
    usedC.add(ci);
    pairs.push({ mi, ci });
  }
  return pairs;
}

function eventPairScore(me: GedEvent, ce: GedEvent): number {
  return datePairSim(me.date, ce.date) * 0.6 + eventPlaceSim(me, ce) * 0.4;
}

/** Year-based date similarity: 1.0 for gap ≤ 1 year, decays to 0 beyond 15 years. */
function datePairSim(a: GedDate | undefined, b: GedDate | undefined): number {
  if (a?.year == null || b?.year == null) return 0.3;
  const ay = a.year2 != null ? (a.year + a.year2) / 2 : a.year;
  const by = b.year2 != null ? (b.year + b.year2) / 2 : b.year;
  const gap = Math.abs(ay - by);
  if (gap <= 1) return 1;
  if (gap <= 3) return 0.7;
  if (gap <= 7) return 0.4;
  if (gap <= 15) return 0.2;
  return 0;
}

/** Place similarity: word overlap plus a bonus when one side's address is embedded in the other's place. */
function eventPlaceSim(me: GedEvent, ce: GedEvent): number {
  const mWords = placeWords(me.place?.raw);
  const cWords = placeWords(ce.place?.raw);
  const addrBonus =
    (me.address?.raw && placeContainsAddr(ce.place?.raw, me.address.raw)) ||
    (ce.address?.raw && placeContainsAddr(me.place?.raw, ce.address.raw))
      ? 0.4
      : 0;
  if (mWords.size === 0 && cWords.size === 0 && addrBonus === 0) return 0.3;
  const shared = [...mWords].filter(w => cWords.has(w)).length;
  const total = new Set([...mWords, ...cWords]).size;
  return Math.min(1, (total > 0 ? shared / total : 0) + addrBonus);
}

/** Significant words from a place string, with country-name canonicalization. */
function placeWords(place: string | undefined): Set<string> {
  if (!place) return new Set();
  return new Set(
    foldToken(place)
      .split(/[\s,()\-\/\.]+/)
      .map(w => canonicalPlaceToken(w))
      .filter(w => w.length >= 3),
  );
}

/** True when `addr` (normalized) appears as a substring inside `place` (normalized). */
function placeContainsAddr(place: string | undefined, addr: string): boolean {
  const norm = foldToken(addr).replace(/\s+/g, "");
  if (norm.length < 5) return false;
  return foldToken(place ?? "").replace(/\s+/g, "").includes(norm);
}

function sexText(t: Translate, sex: string | undefined): string {
  if (sex === "M") return t("sex.M");
  if (sex === "F") return t("sex.F");
  return "";
}
