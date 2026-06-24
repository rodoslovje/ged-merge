import type { Dataset, Family, GedDate, GedEvent, Individual, PersonName, Sex, SourceCitation } from "../gedcom/types";
import { sourceCitationKey } from "../gedcom/source";
import { decomposePlace } from "../gedcom/place";
import { compareKey, foldToken } from "../match/text";
import { canonicalPlaceToken, placeCompareKey } from "../match/place";
import { dateCompareKey, nameSimilarity } from "../match/similarity";
import { findEvent, fullDatesLabel, lifespanLabel, displayName, nameTypeLabel } from "../match/relatives";
import { formatLifespan, isDeceased } from "../gedcom/lifespan";
import type { Translate } from "../locales/i18n";
import type { FieldRow, FieldState, RelativePair, RelativeCell } from "./types";
import { inferPlaceExportFormat } from "../normalize/profile";
import { linkKey } from "../normalize/links";
import { reshapesLayout } from "../normalize/placeReformat";
import type { PlaceTargetFormat } from "../normalize/types";

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
  if (key === "links") return t("field.sources");
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
  if (sub === "note") return t("event.note", { event: name });
  if (sub === "agency") return t("event.agency", { event: name });
  if (sub === "links") return t("event.link", { event: name });
  return key;
}

/** Order events are displayed in; unknown tags follow, in first-seen order. */
export const EVENT_ORDER = [
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
  placeFmt?: PlaceTargetFormat,
  /** Incoming events to treat as absent — see `CandidateDecision.rejectedEvents`. */
  rejectedEvents?: Set<string>,
): FieldRow[] {
  const rows: FieldRow[] = [];
  const mn = master?.names[0];
  const cn = compare?.names[0];
  const resolvedPlaceFmt = placeFmt ?? (masterDs ? inferPlaceExportFormat(masterDs) : undefined);
  const shouldReshape = !!(resolvedPlaceFmt && reshapesLayout(resolvedPlaceFmt.layout));

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
    const rejected = compareIdx >= 0 && (rejectedEvents?.has(`${tag}:${compareIdx}`) ?? false);
    const me = masterIdx >= 0 ? masterEvents[masterIdx] : undefined;
    const ce = !rejected && compareIdx >= 0 ? compareEvents[compareIdx] : undefined;
    const effectiveCompareIdx = rejected ? -1 : compareIdx;
    const keyBase = multi ? `${tag}.${keyIdx}` : tag;
    const eventLabel = t(`event.${tag}`, { defaultValue: EVENT_LABELS[tag] ?? tag });
    const subRows: FieldRow[] = [];
    pushRow(subRows, `${keyBase}.date`, t("event.colDate"), me?.date?.raw, ce?.date?.raw);
    pushRow(subRows, `${keyBase}.value`, formatFieldLabel(t, `${tag}.value`), me?.value, ce?.value);
    // Places are already reshaped into the master's layout when the incoming
    // file was loaded (see normalize/normalize.ts), so the raw values can be
    // shown directly. When the master doesn't enforce a particular layout,
    // fall back to heuristically extracting a comparable address for display.
    const effectiveIncomingAddr = shouldReshape
      ? ce?.address?.raw
      : extractEffectiveAddr(ce?.address?.raw, ce?.place?.raw, me?.address?.raw);
    const effectiveMAddr = shouldReshape
      ? me?.address?.raw
      : extractEffectiveAddr(me?.address?.raw, me?.place?.raw, effectiveIncomingAddr);
    pushRow(subRows, `${keyBase}.place`, t("event.colPlace"), me?.place?.raw, ce?.place?.raw, undefined, undefined, ce?.place?.originalRaw);
    pushRow(subRows, `${keyBase}.addr`, t("event.colAddr"), effectiveMAddr, effectiveIncomingAddr, undefined, undefined, ce?.address?.originalRaw);
    pushRow(subRows, `${keyBase}.note`, t("event.colNote"), me?.note, ce?.note);
    pushRow(subRows, `${keyBase}.agency`, t("event.colAgency"), me?.agency, ce?.agency);
    pushSourcesRow(subRows, `${keyBase}.sources`, t("field.sources"), me?.sources, ce?.sources, me?.links, ce?.links);
    for (const r of subRows) { r.eventMasterIdx = masterIdx; r.eventCompareIdx = effectiveCompareIdx; }
    if (subRows.length > 0) {
      rows.push({
        key: `${keyBase}.header`, label: eventLabel, master: "", incoming: "", state: "agree", isGroupHeader: true, isEventHeader: true,
      });
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
      pushRow(marriageRows, `${famKey}.MARR.date`, t("event.colDate"), mMar?.date?.raw, cMar?.date?.raw);
      pushRow(marriageRows, `${famKey}.MARR.place`, t("event.colPlace"), mMar?.place?.raw, cMar?.place?.raw, undefined, undefined, cMar?.place?.originalRaw);
      pushRow(marriageRows, `${famKey}.MARR.addr`, t("event.colAddr"), mMar?.address?.raw, cMar?.address?.raw, undefined, undefined, cMar?.address?.originalRaw);
      pushRow(marriageRows, `${famKey}.MARR.note`, t("event.colNote"), mMar?.note, cMar?.note);
      pushRow(marriageRows, `${famKey}.MARR.agency`, t("event.colAgency"), mMar?.agency, cMar?.agency);
      pushSourcesRow(marriageRows, `${famKey}.MARR.sources`, t("field.sources"), mMar?.sources, cMar?.sources, mMar?.links, cMar?.links);
      if (marriageRows.length > 0) {
        rows.push({
          key: `${famKey}.MARR.header`, label: t("event.MARR", { defaultValue: "Marriage" }), master: "", incoming: "", state: "agree", isGroupHeader: true, isEventHeader: true,
        });
        rows.push(...marriageRows);
      }

      for (const etag of ["ENGA", "SEPA", "DIV"] as const) {
        const mEv = mFam?.events.find((e) => e.tag === etag);
        const cEv = cFam?.events.find((e) => e.tag === etag);
        if (!mEv && !cEv) continue;
        const etagRows: FieldRow[] = [];
        pushRow(etagRows, `${famKey}.${etag}.date`, t("event.colDate"), mEv?.date?.raw, cEv?.date?.raw);
        pushRow(etagRows, `${famKey}.${etag}.place`, t("event.colPlace"), mEv?.place?.raw, cEv?.place?.raw, undefined, undefined, cEv?.place?.originalRaw);
        pushRow(etagRows, `${famKey}.${etag}.addr`, t("event.colAddr"), mEv?.address?.raw, cEv?.address?.raw, undefined, undefined, cEv?.address?.originalRaw);
        pushRow(etagRows, `${famKey}.${etag}.note`, t("event.colNote"), mEv?.note, cEv?.note);
        pushRow(etagRows, `${famKey}.${etag}.agency`, t("event.colAgency"), mEv?.agency, cEv?.agency);
        pushSourcesRow(etagRows, `${famKey}.${etag}.sources`, t("field.sources"), mEv?.sources, cEv?.sources, mEv?.links, cEv?.links);
        if (etagRows.length > 0) {
          rows.push({
            key: `${famKey}.${etag}.header`, label: t(`event.${etag}`, { defaultValue: EVENT_LABELS[etag] ?? etag }), master: "", incoming: "", state: "agree", isGroupHeader: true, isEventHeader: true,
          });
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
    birthApprox: findEvent(partner, "BIRT")?.date?.qualifier !== "exact",
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

/**
 * Master family id → the `fam.<id>` key base used for that family's rows in
 * `individualFieldRows` (see the `famKey` derivation above: a paired family
 * is keyed by the *compare* side's id, not the master's). Callers that walk
 * the master's own family records — e.g. the edit view rendering a confirmed
 * merge's preview — need this to look up highlight/incoming data by the
 * master family id they have on hand.
 */
export function familyMergeKeyBases(
  master: Individual | undefined,
  compare: Individual | undefined,
  masterDs: Dataset,
  compareDs: Dataset,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of pairFamilies(master, compare, masterDs, compareDs)) {
    if (!pair.masterFam) continue;
    const key = pair.compareFam ? `fam.${pair.compareFam.id}` : `fam.${pair.masterFam.id}`;
    map.set(pair.masterFam.id, key);
  }
  return map;
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
      birthApprox: findEvent(parent, "BIRT")?.date?.qualifier !== "exact",
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
  /** True when the birth year is an estimate (ABT/EST/CAL) rather than an
   *  exact assertion — widens how much a birth-year gap counts against pairing. */
  birthApprox?: boolean;
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
    const isSources = row.masterSources !== undefined || row.incomingSources !== undefined
      || row.masterLinkIcons !== undefined || row.incomingLinkIcons !== undefined;
    if (isLink) {
      const masterKeys = new Set((row.masterLinks ?? []).map(linkKey));
      if ((row.incomingLinks ?? []).some((url) => !masterKeys.has(linkKey(url)))) linkCount++;
    } else if (isSources) {
      // row.state also folds in icon-only links (for default-choice purposes),
      // so re-derive the citation-only comparison here to keep those tallied
      // exclusively via linkCount below, not double-counted into new/diff.
      const mKeys = new Set((row.masterSources ?? []).map(sourceCitationKey));
      const iKeys = new Set((row.incomingSources ?? []).map(sourceCitationKey));
      if (!mKeys.size && iKeys.size) newCount++;
      else if (mKeys.size && iKeys.size && !(mKeys.size === iKeys.size && [...mKeys].every((k) => iKeys.has(k)))) diffCount++;
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
  masterTitle?: string,
  incomingTitle?: string,
): void {
  const m = (master ?? "").trim();
  const i = (incoming ?? "").trim();
  if (!m && !i) return; // nothing to show
  rows.push({ key, label, master: m, incoming: i, state: stateOf(key, m, i), displayLabel, masterTitle, incomingTitle });
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
  // An ABT/EST birth year on either side is an estimate, not an assertion, so
  // it shouldn't count as heavily against the pairing as a gap between two
  // exact dates would — mirrors the wider tolerance dateSimilarity gives
  // approximate dates.
  const tolerance = a.birthApprox || b.birthApprox ? 10 : 1;
  const birthAdjust = gap === 0 ? 0.15 : gap <= tolerance ? 0.05 : -0.25;
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

/**
 * A row for an event's source citations, shown under its other fields so each
 * side's sources sit in their own column (like any other field) rather than
 * as badges on the event header. The event's own attached links (`_LINK`/`WWW`,
 * distinct from `SOUR` citations) ride along as icons on this same row — but a
 * link already covered by one of that side's citation URLs is dropped, since
 * the citation itself is already clickable to that URL.
 */
function pushSourcesRow(
  rows: FieldRow[],
  key: string,
  label: string,
  master: SourceCitation[] | undefined,
  incoming: SourceCitation[] | undefined,
  masterLinks?: string[],
  incomingLinks?: string[],
): void {
  const mBase = master ?? [];
  const iBase = incoming ?? [];
  // A plain link that resolves to the exact same archival page as a citation
  // already on the other side is the same record, just not yet itself a
  // citation on this side — show it as that citation (with the other side's
  // title/page) instead of a disconnected new link, so an identical source
  // doesn't read as a conflict needing a merge decision.
  const { sources: m, remainingLinks: mRemainingLinks } = reconcileLinksAsCitations(masterLinks, mBase, iBase);
  const { sources: i, remainingLinks: iRemainingLinks } = reconcileLinksAsCitations(incomingLinks, iBase, mBase);
  const mIcons = linksNotCitedAsSource(mRemainingLinks, m);
  const iIcons = linksNotCitedAsSource(iRemainingLinks, i);
  if (m.length === 0 && i.length === 0 && mIcons.length === 0 && iIcons.length === 0) return;
  rows.push({
    key,
    label,
    // Keep a text form — including the icon-only links — so the default merge
    // choice (master-if-present) and the row's agree/conflict state see them
    // too, not just the citations.
    master: [...m.map((c) => c.title ?? c.sourceId), ...mIcons].join("\n"),
    incoming: [...i.map((c) => c.title ?? c.sourceId), ...iIcons].join("\n"),
    state: sourcesState(m, i, mIcons, iIcons),
    masterSources: m.length ? m : undefined,
    incomingSources: i.length ? i : undefined,
    masterLinkIcons: mIcons.length ? mIcons : undefined,
    incomingLinkIcons: iIcons.length ? iIcons : undefined,
  });
}

/** An event's own links, minus any already reachable via one of its source citations' URLs. */
function linksNotCitedAsSource(links: string[] | undefined, sources: SourceCitation[]): string[] {
  if (!links?.length) return [];
  const citedKeys = new Set(sources.filter((c) => c.url).map((c) => linkKey(c.url!)));
  return links.filter((url) => !citedKeys.has(linkKey(url)));
}

/**
 * Match a side's plain links against the *other* side's citations: a link
 * whose URL resolves (mod case/trailing-slash/Matricula-language) to the same
 * page as one of the other side's citations is that same archival record, so
 * it's added to this side's own citation list (reusing the other side's
 * title/page) and dropped from the plain-link list, rather than staying a
 * disconnected new link next to a citation that already covers it.
 */
function reconcileLinksAsCitations(
  links: string[] | undefined,
  ownSources: SourceCitation[],
  otherSources: SourceCitation[],
): { sources: SourceCitation[]; remainingLinks: string[] } {
  if (!links?.length || !otherSources.length) return { sources: ownSources, remainingLinks: links ?? [] };
  const matched: SourceCitation[] = [];
  const remainingLinks: string[] = [];
  for (const url of links) {
    const key = linkKey(url);
    const match = otherSources.find((c) => c.url && linkKey(c.url) === key);
    if (match) matched.push(match);
    else remainingLinks.push(url);
  }
  return matched.length ? { sources: [...ownSources, ...matched], remainingLinks } : { sources: ownSources, remainingLinks };
}

/** Compares both citations and icon-only links together: a side "has" the
 * field if either is non-empty, so a links-only difference isn't masked as
 * "agree" just because the citations happen to match (or both be empty). */
function sourcesState(
  master: SourceCitation[],
  incoming: SourceCitation[],
  masterIcons: string[] = [],
  incomingIcons: string[] = [],
): FieldState {
  const m = new Set(master.map(sourceCitationKey));
  const i = new Set(incoming.map(sourceCitationKey));
  const mi = new Set(masterIcons.map(linkKey));
  const ii = new Set(incomingIcons.map(linkKey));
  const masterHas = m.size > 0 || mi.size > 0;
  const incomingHas = i.size > 0 || ii.size > 0;
  if (masterHas && !incomingHas) return "master-only";
  if (!masterHas && incomingHas) return "incoming-only";
  const sameCitations = m.size === i.size && [...m].every((x) => i.has(x));
  const sameIcons = mi.size === ii.size && [...mi].every((x) => ii.has(x));
  return sameCitations && sameIcons ? "agree" : "conflict";
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


/** Events that can occur at most once per person — always paired with the incoming side, never score-gated. */
const SINGLE_EVENT_TAGS = new Set(["BIRT", "DEAT", "BURI"]);

export function orderedEventTags(
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
      // Birth/death/burial happen at most once per person, so they're always the same
      // event regardless of score — no splitting for those tags.
      if (mIdx >= 0 && cIdx >= 0
          && !SINGLE_EVENT_TAGS.has(tag)
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

  // Compute mid-lifespan sort key for placing undated life-zone events (RESI, OCCU, …)
  // between birth and death rather than before all dated events.
  const birthKeys = [...(mByTag.get("BIRT") ?? []), ...(cByTag.get("BIRT") ?? [])]
    .filter(e => e.date?.year != null).map(e => dateToSortKey(e.date));
  const deathKeys = [
    ...(mByTag.get("DEAT") ?? []), ...(cByTag.get("DEAT") ?? []),
    ...(mByTag.get("BURI") ?? []), ...(cByTag.get("BURI") ?? []),
    ...(mByTag.get("CREM") ?? []), ...(cByTag.get("CREM") ?? []),
  ].filter(e => e.date?.year != null).map(e => dateToSortKey(e.date));
  const minBirthKey = birthKeys.length > 0 ? Math.min(...birthKeys) : undefined;
  // Anchor for undated birth-zone tags (BAPM, CHR, …): the *latest* known birth
  // date, so they sort after whichever of master/compare's birth date the BIRT
  // row itself ends up using (effectiveSortKey prefers master's date when present).
  const maxBirthKey = birthKeys.length > 0 ? Math.max(...birthKeys) : undefined;
  const maxDeathKey = deathKeys.length > 0 ? Math.max(...deathKeys) : undefined;
  // Earliest known death-zone date: dated life-zone events (e.g. an occupation
  // "FROM 1995 TO 2024") are clamped just before this, so an imprecise,
  // same-year end date doesn't outrank a same-year death/burial (see
  // dateToSortKey: a year-only date sorts after any specific date in that year).
  const minDeathKey = deathKeys.length > 0 ? Math.min(...deathKeys) : undefined;
  const midLifeKey =
    minBirthKey != null && maxDeathKey != null ? (minBirthKey + maxDeathKey) / 2
    : minBirthKey != null ? minBirthKey + 30 * 10_000
    : maxDeathKey != null ? maxDeathKey - 30 * 10_000
    : 15_000_000; // ~year 1500 fallback

  instances.sort((a, b) => {
    const me = a.masterIdx >= 0 ? (mByTag.get(a.tag) ?? [])[a.masterIdx] : undefined;
    const ce = a.compareIdx >= 0 ? (cByTag.get(a.tag) ?? [])[a.compareIdx] : undefined;
    const me2 = b.masterIdx >= 0 ? (mByTag.get(b.tag) ?? [])[b.masterIdx] : undefined;
    const ce2 = b.compareIdx >= 0 ? (cByTag.get(b.tag) ?? [])[b.compareIdx] : undefined;
    const dateA = effectiveSortKey(me, ce, a.tag, midLifeKey, maxBirthKey, minDeathKey);
    const dateB = effectiveSortKey(me2, ce2, b.tag, midLifeKey, maxBirthKey, minDeathKey);
    if (dateA !== dateB) return dateA - dateB;
    const posA = EVENT_ORDER.indexOf(a.tag);
    const posB = EVENT_ORDER.indexOf(b.tag);
    return (posA === -1 ? 999 : posA) - (posB === -1 ? 999 : posB) || a.keyIdx - b.keyIdx;
  });

  return instances;
}

/** Birth-adjacent tags that should always sort before any dated event. */
const BIRTH_ZONE_TAGS = new Set(["BIRT", "BAPM", "CHR", "CONF", "ADOP", "FCOM"]);

/**
 * Life-zone tags that can only occur while the person is alive, so they must
 * always sort before a known death/burial/cremation date even when their own
 * (often imprecise) date would otherwise rank later. WILL/PROB are excluded:
 * probate routinely happens after death, so their date should be trusted as-is.
 */
export const LIFE_ZONE_TAGS = new Set(["OCCU", "EDUC", "RETI", "RESI", "EMIG", "IMMI", "NATU", "CENS"]);

/** Death/burial/cremation tags — the terminal events a life-zone event must precede. */
export const DEATH_ZONE_TAGS = new Set(["DEAT", "BURI", "CREM"]);

/** Earliest death-zone sort key among `events` with a known date, or `undefined` if none. */
export function minDeathZoneKey(events: { tag: string; date?: GedDate }[]): number | undefined {
  const keys = events
    .filter((e) => DEATH_ZONE_TAGS.has(e.tag) && e.date?.year != null)
    .map((e) => dateToSortKey(e.date));
  return keys.length > 0 ? Math.min(...keys) : undefined;
}

/**
 * Clamps a life-zone event's date key to land just before the earliest known
 * death/burial/cremation date, so an imprecise same-year date (e.g. a
 * year-only OCCU) never outranks it (see `dateToSortKey`: a year-only date
 * sorts after any specific date in that year). Other tags pass through.
 */
export function clampBeforeDeathZone(tag: string, key: number, minDeathKey: number | undefined): number {
  if (LIFE_ZONE_TAGS.has(tag) && minDeathKey != null && key >= minDeathKey) return minDeathKey - 1;
  return key;
}

/**
 * Sort key for an event instance. When the event has a date, returns the
 * precision-aware date key. When undated, uses zone-based placement:
 *  - Birth-zone tags (BIRT, BAPM, …): pinned just after the known birth date
 *    (so e.g. an undated christening still sorts after a dated birth), or
 *    key 0–5 when no birth date is known at all.
 *  - Death-zone tags (DEAT, BURI, CREM): key 99_999_997–99_999_999, always last.
 *  - Life-zone tags (RESI, OCCU, …): key near `midLifeKey`, between birth and death.
 */
function effectiveSortKey(
  me: GedEvent | undefined,
  ce: GedEvent | undefined,
  tag: string,
  midLifeKey: number,
  maxBirthKey: number | undefined,
  minDeathKey: number | undefined,
): number {
  const d = me?.date ?? ce?.date;
  if (d?.year != null) {
    return clampBeforeDeathZone(tag, dateToSortKey(d), minDeathKey);
  }
  const pos = EVENT_ORDER.indexOf(tag);
  if (BIRTH_ZONE_TAGS.has(tag)) {
    return maxBirthKey != null ? maxBirthKey + (pos >= 0 ? pos : 5) + 1 : (pos >= 0 ? pos : 5);
  }
  if (tag === "CREM") return 99_999_999;
  if (tag === "BURI") return 99_999_998;
  if (tag === "DEAT") return 99_999_997;
  return midLifeKey + (pos === -1 ? 500 : pos * 1_000);
}

/**
 * Sort key for a single GedDate that is precision- and qualifier-aware:
 *  - BEF Y  → just before year start (Y*10000 - 1), so it sorts before any Y date
 *  - AFT Y  → after year end (Y*10000 + 9999)
 *  - Full date Y-M-D → Y*10000 + M*100 + D
 *  - Month-only Y-M  → mid-month (M*100 + 50), after same-month full dates
 *  - Year-only Y     → Y*10000 + 9000, after all specific dates in that year
 */
export function dateToSortKey(d: GedDate | undefined): number {
  if (!d || d.year == null) return 9_999_999;
  if (d.qualifier === "before") return d.year * 10000 - 1;
  if (d.qualifier === "after") return d.year * 10000 + 9999;
  // FROM..TO periods (e.g. an occupation held over several years) sort by their
  // end date, so they land next to whatever else was happening when they ended.
  const useEnd = d.qualifier === "range" && d.year2 != null;
  const year = useEnd ? d.year2! : d.year;
  const m = useEnd ? d.month2 : d.month;
  const day = useEnd ? d.day2 : d.day;
  const base = year * 10000;
  if (!m) return base + 9000;            // year-only → after any known date in year
  if (!day) return base + m * 100 + 50;  // month-only → mid-month
  return base + m * 100 + day;
}


/** Minimum score for two events to be considered the same event. Below this they are shown separately. */
const MIN_EVENT_PAIR_SCORE = 0.6;

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

/** Year-based date similarity: 1.0 for gap ≤ 1 year, decays to 0 beyond 10 years. */
function datePairSim(a: GedDate | undefined, b: GedDate | undefined): number {
  if (a?.year == null || b?.year == null) return 0.3;
  const ay = a.year2 != null ? (a.year + a.year2) / 2 : a.year;
  const by = b.year2 != null ? (b.year + b.year2) / 2 : b.year;
  const gap = Math.abs(ay - by);
  if (gap <= 1) return 1;
  if (gap <= 3) return 0.7;
  if (gap <= 5) return 0.4;
  if (gap <= 10) return 0.2;
  return 0;
}

/**
 * Place similarity: word overlap, plus a bonus when one side's address is
 * embedded in the other's place, plus a bonus when both sides name the same
 * locality (the first, most specific place component) — two events in
 * "Kranj" and "Kranj, Slovenia" are more likely the same place than two
 * events that merely share a shared municipality/country word.
 */
function eventPlaceSim(me: GedEvent, ce: GedEvent): number {
  const mWords = new Set([...placeWords(me.place?.raw), ...placeWords(me.address?.raw)]);
  const cWords = new Set([...placeWords(ce.place?.raw), ...placeWords(ce.address?.raw)]);
  const addrBonus =
    (me.address?.raw && placeContainsAddr(ce.place?.raw, me.address.raw)) ||
    (ce.address?.raw && placeContainsAddr(me.place?.raw, ce.address.raw))
      ? 0.4
      : 0;
  const mLocality = firstPlaceComponent(me.place?.raw);
  const cLocality = firstPlaceComponent(ce.place?.raw);
  const localityBonus = mLocality && mLocality === cLocality ? 0.3 : 0;
  if (mWords.size === 0 && cWords.size === 0 && addrBonus === 0) return 0.3;
  const shared = [...mWords].filter(w => cWords.has(w)).length;
  const total = new Set([...mWords, ...cWords]).size;
  return Math.min(1, (total > 0 ? shared / total : 0) + addrBonus + localityBonus);
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

/** The most specific (first) component of a comma-separated place string, canonicalized for comparison. */
function firstPlaceComponent(place: string | undefined): string | undefined {
  if (!place) return undefined;
  const first = place.split(",")[0];
  const canon = canonicalPlaceToken(first);
  return canon || undefined;
}

/** True when `addr` (normalized) appears as a substring inside `place` (normalized). */
function placeContainsAddr(place: string | undefined, addr: string): boolean {
  const norm = foldToken(addr).replace(/\s+/g, "");
  if (norm.length < 5) return false;
  return foldToken(place ?? "").replace(/\s+/g, "").includes(norm);
}


/**
 * Compute the effective address for comparison when one side's address may be
 * embedded inside a packed PLAC (no separate ADDR field). Only extracts when
 * the other side has an ADDR, so we don't add addr rows where neither side has
 * address data.
 *
 * Priority:
 *  1. Own ADDR if present — use it directly.
 *  2. Exact substring match: the other side's ADDR appears verbatim in our PLAC
 *     → return the other addr so the row shows "=".
 *  3. Structural extraction: decompose our packed PLAC; use the street component
 *     (or locality + houseNumber) as the effective addr so a conflict is visible.
 */
function extractEffectiveAddr(
  ownAddr: string | undefined,
  ownPlace: string | undefined,
  otherAddr: string | undefined,
): string | undefined {
  if (ownAddr) return ownAddr;
  if (!ownPlace) return undefined;
  // Structural extraction: decompose the packed PLAC and reassemble
  // the address component (street/house + facility parenthetical).
  // Runs even when the other side has no ADDR, so packed PLACs always
  // surface their embedded address as a separate row.
  const dec = decomposePlace(ownPlace);
  let extracted = dec.street
    ?? (dec.houseNumber ? `${dec.locality ?? ""} ${dec.houseNumber}`.trim() : undefined);
  if (extracted && dec.facility) extracted += ` (${dec.facility})`;
  if (extracted) return extracted;
  // Fallback: exact substring match shows the other addr verbatim (→ "=").
  if (otherAddr && placeContainsAddr(ownPlace, otherAddr)) return otherAddr;
  return undefined;
}

function sexText(t: Translate, sex: string | undefined): string {
  if (sex === "M") return t("sex.M");
  if (sex === "F") return t("sex.F");
  return "";
}
