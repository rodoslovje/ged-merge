import type { Dataset, Family, GedDate, GedEvent, Individual, PersonName, Sex, SourceCitation } from "../gedcom/types";
import { EDITABLE_FAM_EVENT_TAGS, INDI_EVENT_TAG_ORDER, VALUE_EVENT_TAGS, eventDisplayLabel } from "../gedcom/eventTags";
import { sourceCitationKey } from "../gedcom/source";
import { decomposePlace } from "../gedcom/place";
import { compareKey, foldToken } from "../match/text";
import { canonicalPlaceToken, placeCompareKey } from "../match/place";
import { PARENT_GIVEN_CONFLICT, comparableName, dateCompareKey, givenSimilarity, nameSimilarity } from "../match/similarity";
import { findEvent, fullDatesLabel, lifespanLabel, displayName, nameTypeLabel } from "../match/relatives";
import { birthDateOf, formatLifespan, isDeceased } from "../gedcom/lifespan";
import { dateToSortKey, parseDate } from "../gedcom/date";
import { ageBetween, coupleAgesDisplay, fullAgeBetween, lifespanAge, type AgeBadge } from "../gedcom/age";
import type { Translate } from "../locales/i18n";
import type { FieldRow, FieldState, RelativePair, RelativeCell } from "./types";
import { inferPlaceExportFormat } from "../normalize/profile";
import { linkKey } from "../normalize/links";
import { reshapesLayout } from "../normalize/placeReformat";
import type { PlaceTargetFormat } from "../normalize/types";
import { UNNAMED } from "../gedcom/nameDisplay";

/** Swap the name builders' untranslatable stand-in for a person the file names
 *  nowhere (see {@link UNNAMED}) for the translated one. */
function translateUnnamed(name: string, t: Translate): string {
  return name === UNNAMED ? t("name.unnamed", { defaultValue: UNNAMED }) : name;
}

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
  GRAD: "Graduation",
  RETI: "Retirement",
  _MILT: "Military service",
  _MILI: "Military service",
  TITL: "Title",
  DSCR: "Physical description",
  RELI: "Religion",
  NATI: "Nationality",
  RACE: "Race / ethnicity",
  NOBI: "Award / title",
  LATR: "Legal transaction",
  DEED: "Deed",
  ILL: "Illness",
  NCHI: "Number of children",
  _MEDC: "Medical",
  FACT: "Fact",
  REFN: "Reference number",
  _FNRL: "Funeral",
  _INTE: "Interment",
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
  _MSTAT: "Status",
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
  if (key === "fsid") return t("field.fsid");
  if (key === "notes" || key.endsWith(".notes")) return t("field.notes");
  if (key === "private" || key.endsWith(".private")) return t("field.private");

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

  const name = eventDisplayLabel(tag, t, EVENT_LABELS[tag]);
  if (!sub) return name;
  if (sub === "value") return name;
  if (sub === "date") return t("event.date", { event: name });
  if (sub === "place") return t("event.place", { event: name });
  if (sub === "addr") return t("event.addr", { event: name });
  if (sub === "note") return t("event.note", { event: name });
  if (sub === "agency") return t("event.agency", { event: name });
  if (sub === "type") return t("event.type", { event: name });
  if (sub === "cause") return t("event.cause", { event: name });
  if (sub === "links") return t("event.link", { event: name });
  return key;
}

/** Order events are displayed in; unknown tags — including the generic EVEN,
 *  which has no fixed life-cycle slot — follow, in first-seen order. */
export const EVENT_ORDER = INDI_EVENT_TAG_ORDER.filter((tag) => tag !== "EVEN");

/**
 * Build the comparable field rows for an individual candidate. When datasets are
 * supplied, parents and partners (resolved through the family graph) are added
 * as their own rows.
 */
export function individualFieldRows(
  t: Translate,
  main: Individual | undefined,
  compare: Individual | undefined,
  mainDs?: Dataset,
  compareDs?: Dataset,
  placeFmt?: PlaceTargetFormat,
  /** Incoming events to treat as absent — see `CandidateDecision.rejectedEvents`. */
  rejectedEvents?: Set<string>,
  /** Append the age at each event date (person / parents / couple), matching the
   *  Edit view's "Show ages" setting. Off by default so other callers are unchanged. */
  showAge = false,
): FieldRow[] {
  const rows: FieldRow[] = [];
  const mn = main?.names[0];
  const cn = compare?.names[0];
  const resolvedPlaceFmt = placeFmt ?? (mainDs ? inferPlaceExportFormat(mainDs) : undefined);
  const shouldReshape = !!(resolvedPlaceFmt && reshapesLayout(resolvedPlaceFmt.layout));

  pushRow(rows, "given", formatFieldLabel(t, "given"), mn?.given, cn?.given);
  pushRow(rows, "surname", formatFieldLabel(t, "surname"), mn?.surname, cn?.surname);
  pushRow(rows, "sex", formatFieldLabel(t, "sex"), sexText(t, main?.sex), sexText(t, compare?.sex));
  pushRow(rows, "nickname", formatFieldLabel(t, "nickname"), mn?.nickname, cn?.nickname);
  const mExtraNames = main?.names.slice(1) ?? [];
  const cExtraNames = compare?.names.slice(1) ?? [];
  if (mExtraNames.length || cExtraNames.length) {
    const mText = mExtraNames.map((n) => extraNameText(n, t)).join("\n") || undefined;
    const cText = cExtraNames.map((n) => extraNameText(n, t)).join("\n") || undefined;
    pushRow(rows, "additionalNames", formatFieldLabel(t, "additionalNames"), mText, cText);
  }
  // FamilySearch ids (uppercased — the canonical form — so a case-only
  // difference between the files reads as agreement).
  pushRow(rows, "fsid", formatFieldLabel(t, "fsid"),
    main?.fsids?.map((s) => s.toUpperCase()).join("\n"),
    compare?.fsids?.map((s) => s.toUpperCase()).join("\n"));

  // Record-level sources (SOUR citations) and plain links, combined into one
  // "Sources" row — same citations-plus-link-icons shape used per event — then
  // notes, all before the events.
  pushSourcesRow(rows, "links", formatFieldLabel(t, "links"), main?.sources, compare?.sources, gatherLinks(main), gatherLinks(compare),
    recordCitations(main), recordCitations(compare));
  pushRow(rows, "notes", formatFieldLabel(t, "notes"), main?.notes?.join("\n"), compare?.notes?.join("\n"));
  // Private flag: shown when either side declares it; merging is additive
  // (an incoming flag is written, a main-side flag is never removed).
  pushRow(rows, "private", formatFieldLabel(t, "private"),
    main?.private ? `🔒 ${t("edit.privateLabel")}` : undefined,
    compare?.private ? `🔒 ${t("edit.privateLabel")}` : undefined);

  buildEventRows(rows, t, main, compare, mainDs, compareDs, shouldReshape, rejectedEvents, showAge);

  // Relatives last: parents, partner(s), the marriage facts, then children.
  // Marriage and children live on the FAM record but are reconciled here on the
  // spouse so every decision about a person is made in one place.
  if (mainDs && compareDs) {
    buildParentRows(rows, t, main, compare, mainDs, compareDs, showAge);
    buildFamilyRows(rows, t, main, compare, mainDs, compareDs, showAge);
  }
  return rows;
}

/** One group (header + type/date/…/sources sub-rows) per event instance, in the
 *  shared zone-aware chronological order (`orderedEventTags`). */
function buildEventRows(
  rows: FieldRow[],
  t: Translate,
  main: Individual | undefined,
  compare: Individual | undefined,
  mainDs: Dataset | undefined,
  compareDs: Dataset | undefined,
  shouldReshape: boolean,
  rejectedEvents: Set<string> | undefined,
  showAge: boolean,
): void {
  const mainPool = recordCitations(main);
  const comparePool = recordCitations(compare);
  for (const { tag, mainIdx, compareIdx, keyIdx, multi } of orderedEventTags(main, compare)) {
    const mainEvents = main?.events.filter((e) => e.tag === tag) ?? [];
    const compareEvents = compare?.events.filter((e) => e.tag === tag) ?? [];
    const rejected = compareIdx >= 0 && (rejectedEvents?.has(`${tag}:${compareIdx}`) ?? false);
    const me = mainIdx >= 0 ? mainEvents[mainIdx] : undefined;
    const ce = !rejected && compareIdx >= 0 ? compareEvents[compareIdx] : undefined;
    const effectiveCompareIdx = rejected ? -1 : compareIdx;
    const keyBase = multi ? `${tag}.${keyIdx}` : tag;
    // A generic `EVEN`/`FACT` shows its descriptive `TYPE` (e.g. "Civil
    // Partnership") as the event name itself, so it reads like any built-in
    // event — the header's tooltip is what says it's custom. The TYPE stays
    // editable/comparable under the "Title" label and the tag's own line
    // value (`1 EVEN <v>`) under the "Agency" label.
    const isEven = tag === "EVEN" || tag === "FACT";
    const baseLabel = eventDisplayLabel(tag, t, EVENT_LABELS[tag]);
    const headerType = isEven ? (me?.type ?? ce?.type) : undefined;
    const eventLabel = headerType?.trim() || baseLabel;
    const customTitle = isEven ? t("event.customTooltip", { tag }) : undefined;
    const subRows: FieldRow[] = [];
    pushRow(subRows, `${keyBase}.type`, isEven ? t("event.colTitle") : t("event.colType"), me?.type, ce?.type);
    pushRow(subRows, `${keyBase}.date`, t("event.colDate"), me?.date?.raw, ce?.date?.raw);
    pushRow(subRows, `${keyBase}.value`, isEven ? t("event.colAgency") : formatFieldLabel(t, `${tag}.value`), me?.value, ce?.value);
    // Places are already reshaped into the main's layout when the incoming
    // file was loaded (see normalize/normalize.ts), so the raw values can be
    // shown directly. When the main doesn't enforce a particular layout,
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
    // EVEN's line value already occupies the "Agency" label, so its real AGNC
    // sub-tag (rare) isn't shown as a second Agency row.
    if (!isEven) pushRow(subRows, `${keyBase}.agency`, t("event.colAgency"), me?.agency, ce?.agency);
    pushRow(subRows, `${keyBase}.cause`, t("event.colCause"), me?.cause, ce?.cause);
    pushSourcesRow(subRows, `${keyBase}.sources`, t("field.sources"), me?.sources, ce?.sources, me?.links, ce?.links,
      mainPool, comparePool);
    if (showAge) {
      attachAges(subRows, `${keyBase}.date`,
        eventAgeBadges(main, mainDs, me, tag, t),
        eventAgeBadges(compare, compareDs, ce, tag, t));
    }
    for (const r of subRows) { r.eventMainIdx = mainIdx; r.eventCompareIdx = effectiveCompareIdx; }
    // An event's own line value (`1 REFN Mlinar`, an attribute's text) is
    // labelled with the event's name — which the group header directly above
    // already says. The repeat carries nothing, and a long one (Referenčna
    // številka, Etnična pripadnost) overruns the narrow label column and
    // collides with the value, so the row goes label-less under its header.
    for (const r of subRows) if (r.label === eventLabel) r.displayLabel = "";
    if (subRows.length > 0) {
      rows.push({
        key: `${keyBase}.header`, label: eventLabel, labelTitle: customTitle, main: "", incoming: "", state: "agree", isGroupHeader: true, isEventHeader: true,
      });
      rows.push(...subRows);
    }
  }
}

/** Father/mother rows under one "Parents" group header. */
function buildParentRows(
  rows: FieldRow[],
  t: Translate,
  main: Individual | undefined,
  compare: Individual | undefined,
  mainDs: Dataset,
  compareDs: Dataset,
  showAge: boolean,
): void {
  const parentRows: FieldRow[] = [];
  const mFather = parentRelative(main, mainDs, "husband", showAge);
  const mMother = parentRelative(main, mainDs, "wife", showAge);
  let cFather = parentRelative(compare, compareDs, "husband", showAge);
  let cMother = parentRelative(compare, compareDs, "wife", showAge);
  // Which parent sits in which slot is the incoming file's assertion, and a file
  // that records no sex can have it the other way round (a genealogical index
  // naming a couple, an export with the spouses swapped). When the two parents
  // line up better crossed than straight, read them crossed — otherwise both
  // parents show as one-sided, as if neither file knew them.
  if (parentsAreCrossed(mFather, mMother, cFather, cMother)) [cFather, cMother] = [cMother, cFather];
  pushRelativesRow(parentRows, "father", formatFieldLabel(t, "father"), mFather, cFather);
  pushRelativesRow(parentRows, "mother", formatFieldLabel(t, "mother"), mMother, cMother);
  if (parentRows.length > 0) {
    rows.push({ key: "parents.header", label: t("field.parents"), main: "", incoming: "", state: "agree", isGroupHeader: true });
    rows.push(...parentRows);
  }
}

/**
 * Do the incoming parents belong in the other slots? Scores the two readings —
 * father↔father + mother↔mother against father↔mother + mother↔father — and
 * says so when crossing them wins and at least one crossed pair is a real match.
 * Each list holds 0 or 1 parent, as {@link parentRelative} returns.
 */
function parentsAreCrossed(
  mFather: Relative[],
  mMother: Relative[],
  cFather: Relative[],
  cMother: Relative[],
): boolean {
  const sim = (a: Relative[], b: Relative[]) =>
    a[0] && b[0] ? relativeSimilarity(a[0], b[0]) : 0;
  const crossed = sim(mFather, cMother) + sim(mMother, cFather);
  return crossed > sim(mFather, cFather) + sim(mMother, cMother) && crossed >= RELATIVE_PAIR_THRESHOLD;
}

/** Per spouse-family group: the partner row, the family events (marriage,
 *  engagement, separation, divorce), family notes, and the aligned children
 *  list. Families are paired across the two files by `pairFamilies`. */
function buildFamilyRows(
  rows: FieldRow[],
  t: Translate,
  main: Individual | undefined,
  compare: Individual | undefined,
  mainDs: Dataset,
  compareDs: Dataset,
  showAge: boolean,
): void {
  const famPairs = pairFamilies(main, compare, mainDs, compareDs);
  famPairs.forEach((pair) => {
    const mFam = pair.mainFam;
    const cFam = pair.compareFam;
    const famKey = cFam ? `fam.${cFam.id}` : `fam.${mFam!.id}`;

    const mSpouseId = mFam ? (mFam.husband === main?.id ? mFam.wife : mFam.husband) : undefined;
    const cSpouseId = cFam ? (cFam.husband === compare?.id ? cFam.wife : cFam.husband) : undefined;
    const mSpouse = mSpouseId ? mainDs.individuals.get(mSpouseId) : undefined;
    const cSpouse = cSpouseId ? compareDs.individuals.get(cSpouseId) : undefined;
    const mSpouseRel = mSpouse ? [partnerToRelative(mSpouse, showAge)] : [];
    const cSpouseRel = cSpouse ? [partnerToRelative(cSpouse, showAge)] : [];

    // A family whose only recorded parent is this person has nobody to be named
    // after — "Family with (unnamed)" reads as a nameless partner who does not
    // exist. A partner who is merely nameless still gets the "with" form, under
    // the translated stand-in.
    const spouse = mSpouse ?? cSpouse;
    const spouseName = translateUnnamed(displayName(spouse?.names[0]), t);

    rows.push({
      key: `${famKey}.header`,
      label: spouse
        ? t("field.familyWith", { name: spouseName, defaultValue: `Family with ${spouseName}` })
        : t("field.familyNoPartner", { defaultValue: "Family with no partner" }),
      main: "",
      incoming: "",
      state: "agree",
      isGroupHeader: true,
    });

    if (mSpouseRel.length > 0 || cSpouseRel.length > 0) {
      pushRelativesRow(rows, `${famKey}.partner`, formatFieldLabel(t, "partners"), mSpouseRel, cSpouseRel);
    }

    const mFamPool = recordCitations(mFam);
    const cFamPool = recordCitations(cFam);
    for (const etag of EDITABLE_FAM_EVENT_TAGS) {
      const mEv = mFam?.events.find((e) => e.tag === etag);
      const cEv = cFam?.events.find((e) => e.tag === etag);
      if (!mEv && !cEv) continue;
      // A family `EVEN` gets the same custom-event treatment as on a person:
      // the TYPE is the event's name (header + "Title" sub-row) and its line
      // value compares under the "Agency" label.
      const isEven = etag === "EVEN";
      const etagRows: FieldRow[] = [];
      pushRow(etagRows, `${famKey}.${etag}.type`, isEven ? t("event.colTitle") : t("event.colType"), mEv?.type, cEv?.type);
      if (isEven) {
        pushRow(etagRows, `${famKey}.${etag}.value`, t("event.colAgency"), mEv?.value, cEv?.value);
      } else if (VALUE_EVENT_TAGS.has(etag)) {
        pushRow(etagRows, `${famKey}.${etag}.value`, t("event.colValue"), mEv?.value, cEv?.value);
      }
      pushRow(etagRows, `${famKey}.${etag}.date`, t("event.colDate"), mEv?.date?.raw, cEv?.date?.raw);
      pushRow(etagRows, `${famKey}.${etag}.place`, t("event.colPlace"), mEv?.place?.raw, cEv?.place?.raw, undefined, undefined, cEv?.place?.originalRaw);
      pushRow(etagRows, `${famKey}.${etag}.addr`, t("event.colAddr"), mEv?.address?.raw, cEv?.address?.raw, undefined, undefined, cEv?.address?.originalRaw);
      pushRow(etagRows, `${famKey}.${etag}.note`, t("event.colNote"), mEv?.note, cEv?.note);
      // EVEN's line value already occupies the "Agency" label (above), so its
      // real AGNC sub-tag (rare) isn't shown as a second Agency row.
      if (!isEven) pushRow(etagRows, `${famKey}.${etag}.agency`, t("event.colAgency"), mEv?.agency, cEv?.agency);
      pushRow(etagRows, `${famKey}.${etag}.cause`, t("event.colCause"), mEv?.cause, cEv?.cause);
      pushSourcesRow(etagRows, `${famKey}.${etag}.sources`, t("field.sources"), mEv?.sources, cEv?.sources, mEv?.links, cEv?.links,
        mFamPool, cFamPool);
      if (showAge) {
        attachAges(etagRows, `${famKey}.${etag}.date`,
          coupleEventAges(mFam, mainDs, mEv, t),
          coupleEventAges(cFam, compareDs, cEv, t));
      }
      if (etagRows.length > 0) {
        const baseLabel = eventDisplayLabel(etag, t, EVENT_LABELS[etag]);
        const headerType = isEven ? (mEv?.type ?? cEv?.type) : undefined;
        rows.push({
          key: `${famKey}.${etag}.header`,
          label: headerType?.trim() || baseLabel,
          labelTitle: isEven ? t("event.customTooltip", { tag: etag }) : undefined,
          main: "", incoming: "", state: "agree", isGroupHeader: true, isEventHeader: true,
        });
        rows.push(...etagRows);
      }
    }

    const mFamNotes = mFam?.notes?.join("\n");
    const cFamNotes = cFam?.notes?.join("\n");
    pushRow(rows, `${famKey}.notes`, formatFieldLabel(t, `${famKey}.notes`), mFamNotes, cFamNotes);
    pushRow(rows, `${famKey}.private`, formatFieldLabel(t, `${famKey}.private`),
      mFam?.private ? `🔒 ${t("edit.privateLabel")}` : undefined,
      cFam?.private ? `🔒 ${t("edit.privateLabel")}` : undefined);

    const mChildren = mFam ? mFam.children.map(id => mainDs.individuals.get(id)).filter((i): i is Individual => !!i) : [];
    const cChildren = cFam ? cFam.children.map(id => compareDs.individuals.get(id)).filter((i): i is Individual => !!i) : [];
    const mChildRels = individualsToRelatives(mChildren, showAge);
    const cChildRels = individualsToRelatives(cChildren, showAge);

    if (mChildRels.length > 0 || cChildRels.length > 0) {
      rows.push({ key: `${famKey}.children.header`, label: t("field.children"), main: "", incoming: "", state: "agree", isGroupHeader: true, isEventHeader: true });
      pushRelativesRow(rows, `${famKey}.children`, formatFieldLabel(t, "children"), mChildRels, cChildRels,
        { displayLabel: "", perChildChoice: true, kind: "child" });
    }
  });
}

/** The abbreviated lifespan ("1817–1921"), with the age appended ("1817–1921
 *  (104)") when `showAge` — the same suffix person cards get in Edit mode. */
function relativeYears(indi: Individual, showAge: boolean): string {
  const years = formatLifespan(findEvent(indi, "BIRT")?.date?.year, findEvent(indi, "DEAT")?.date?.year, isDeceased(indi));
  if (!showAge || !years) return years;
  const age = lifespanAge(indi);
  return age === undefined ? years : `${years} (${age})`;
}

function partnerToRelative(partner: Individual, showAge = false): Relative {
  const birth = findEvent(partner, "BIRT")?.date;
  return {
    id: partner.id,
    name: partner.names[0],
    text: lifespanLabel(partner),
    full: fullDatesLabel(partner),
    birthYear: birth?.year,
    birthApprox: birth?.qualifier !== "exact",
    birthDay: birth?.month != null && birth.day != null ? birth.month * 100 + birth.day : undefined,
    deathYear: findEvent(partner, "DEAT")?.date?.year,
    displayName: displayName(partner.names[0]),
    years: relativeYears(partner, showAge),
    sex: partner.sex,
  };
}

function individualsToRelatives(indis: Individual[], showAge = false): Relative[] {
  return indis
    .map((child, order) => ({ child, order, sort: birthSortKey(child) }))
    .sort((a, b) => a.sort - b.sort || a.order - b.order)
    .map(({ child }) => partnerToRelative(child, showAge));
}

interface FamPair {
  mainFam?: Family;
  compareFam?: Family;
}

function pairFamilies(
  main: Individual | undefined,
  compare: Individual | undefined,
  mainDs: Dataset,
  compareDs: Dataset
): FamPair[] {
  const mFams = main ? main.spouseOf.map(id => mainDs.families.get(id)).filter((f): f is Family => !!f) : [];
  const cFams = compare ? compare.spouseOf.map(id => compareDs.families.get(id)).filter((f): f is Family => !!f) : [];

  const cand: { mi: number; ii: number; sim: number }[] = [];

  mFams.forEach((mf, mi) => {
    cFams.forEach((cf, ii) => {
      const mSpouseId = mf.husband === main?.id ? mf.wife : mf.husband;
      const cSpouseId = cf.husband === compare?.id ? cf.wife : cf.husband;
      const mSpouse = mSpouseId ? mainDs.individuals.get(mSpouseId) : undefined;
      const cSpouse = cSpouseId ? compareDs.individuals.get(cSpouseId) : undefined;

      /** Share of this main family's children that also appear in the incoming
       *  one — the evidence that two unions are the same when their partners
       *  don't say so themselves. */
      const childOverlap = (): number => {
        const mKids = mf.children.map(id => mainDs.individuals.get(id)).filter(Boolean) as Individual[];
        const cKids = cf.children.map(id => compareDs.individuals.get(id)).filter(Boolean) as Individual[];
        let matches = 0;
        mKids.forEach(mk => {
          if (cKids.some(ck => relativeSimilarity(partnerToRelative(mk), partnerToRelative(ck), "child") >= RELATIVE_PAIR_THRESHOLD)) {
            matches++;
          }
        });
        return matches > 0 ? matches / Math.max(mKids.length, cKids.length) : 0;
      };

      let sim = 0;
      if (mSpouse && cSpouse) {
         // Both unions name a partner, so the partners decide: two people are
         // the same one only at the bar the table uses everywhere else
         // (RELATIVE_PAIR_THRESHOLD). Below it they are different people, and
         // pairing the unions would file one person's marriage under another's
         // — the two are shown as separate families instead, unless matching
         // children prove the couple is the same after all.
         sim = samePartner(partnerToRelative(mSpouse), partnerToRelative(cSpouse))
           ? Math.max(relativeSimilarity(partnerToRelative(mSpouse), partnerToRelative(cSpouse)), PARTNER_PAIR_SCORE)
           : childOverlap();
      } else if (mFams.length === 1 && cFams.length === 1) {
         // One union on each side and no partner named on one of them: nothing
         // else to confuse them with.
         sim = 1;
      } else {
         sim = childOverlap();
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
    pairs.push({ mainFam: mf, compareFam: ii !== undefined ? cFams[ii] : undefined });
  });
  cFams.forEach((cf, ii) => {
    if (!usedC.has(ii)) pairs.push({ compareFam: cf });
  });
  return pairs;
}

/**
 * Main family id → the `fam.<id>` key base used for that family's rows in
 * `individualFieldRows` (see the `famKey` derivation above: a paired family
 * is keyed by the *compare* side's id, not the main's). Callers that walk
 * the main's own family records — e.g. the edit view rendering a confirmed
 * merge's preview — need this to look up highlight/incoming data by the
 * main family id they have on hand.
 */
/**
 * Incoming family id → the main family id the review paired it with — i.e.
 * the pair whose rows the user actually saw and judged (`pairFamilies` is
 * what `buildFamilyRows` renders). The merge writes family-row choices into
 * exactly this family, so review and merge can never disagree about which
 * main family a choice was made against. Unpaired incoming families are
 * absent; the merge falls back to its own spouse matching for those.
 */
export function pairedMainFamilies(
  main: Individual | undefined,
  compare: Individual | undefined,
  mainDs: Dataset,
  compareDs: Dataset,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of pairFamilies(main, compare, mainDs, compareDs)) {
    if (pair.mainFam && pair.compareFam) map.set(pair.compareFam.id, pair.mainFam.id);
  }
  return map;
}

export function familyMergeKeyBases(
  main: Individual | undefined,
  compare: Individual | undefined,
  mainDs: Dataset,
  compareDs: Dataset,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of pairFamilies(main, compare, mainDs, compareDs)) {
    if (!pair.mainFam) continue;
    const key = pair.compareFam ? `fam.${pair.compareFam.id}` : `fam.${pair.mainFam.id}`;
    map.set(pair.mainFam.id, key);
  }
  return map;
}

/** Sortable birth-date value (YYYYMMDD); +Infinity when no birth year is known. */
function birthSortKey(indi: Individual): number {
  const d = findEvent(indi, "BIRT")?.date;
  if (!d || d.year == null) return Number.POSITIVE_INFINITY;
  return d.year * 10000 + (d.month ?? 0) * 100 + (d.day ?? 0);
}

/** {@link parentIndi} wrapped as an alignable relative list (empty when the
 *  person, or that parent, is absent). */
function parentRelative(
  indi: Individual | undefined,
  ds: Dataset,
  role: "husband" | "wife",
  showAge = false,
): Relative[] {
  const parent = indi ? parentIndi(indi, ds, role) : undefined;
  return parent ? [partnerToRelative(parent, showAge)] : [];
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
  /** Day within the year (month × 100 + day), when the birth is that precise —
   *  tells two children of one birth year apart. */
  birthDay?: number;
  /** Death year, when known. */
  deathYear?: number;
  /** Display name. */
  displayName?: string;
  years?: string;
  sex?: Sex;
}


/**
 * Summary counts over a set of field rows:
 *  - `newCount`  = fields the compare record has but the main lacks (to add)
 *  - `diffCount` = fields both have but that differ (to reconcile)
 *  - `linkCount` = attached links the compare has that the main lacks
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
    const isLink = row.mainLinks !== undefined || row.incomingLinks !== undefined;
    const isSources = row.mainSources !== undefined || row.incomingSources !== undefined
      || row.mainLinkIcons !== undefined || row.incomingLinkIcons !== undefined;
    if (isLink) {
      const mainKeys = new Set((row.mainLinks ?? []).map(linkKey));
      if ((row.incomingLinks ?? []).some((url) => !mainKeys.has(linkKey(url)))) linkCount++;
    } else if (isSources) {
      // row.state also folds in icon-only links (for default-choice purposes),
      // so re-derive the citation-only comparison here to keep those tallied
      // exclusively via linkCount below, not double-counted into new/diff.
      const mKeys = new Set((row.mainSources ?? []).map(sourceCitationKey));
      const iKeys = new Set((row.incomingSources ?? []).map(sourceCitationKey));
      if (!mKeys.size && iKeys.size) newCount++;
      else if (mKeys.size && iKeys.size && !(mKeys.size === iKeys.size && [...mKeys].every((k) => iKeys.has(k)))) diffCount++;
    } else if (row.state === "incoming-only") newCount++;
    else if (row.state === "conflict") diffCount++;
    if (row.mainLinkIcons || row.incomingLinkIcons) {
      const mainIconKeys = new Set((row.mainLinkIcons ?? []).map(linkKey));
      if ((row.incomingLinkIcons ?? []).some((url) => !mainIconKeys.has(linkKey(url)))) linkCount++;
    }
  }
  return { newCount, diffCount, linkCount };
}

// --- helpers ---------------------------------------------------------------

/** Set the age badges on an already-built date row (found by key); a no-op when
 *  the row wasn't pushed (no date on either side) or there are no ages. */
function attachAges(
  rows: FieldRow[],
  key: string,
  mainAges: AgeBadge[] | undefined,
  incomingAges: AgeBadge[] | undefined,
): void {
  if (!mainAges && !incomingAges) return;
  const row = rows.find((r) => r.key === key);
  if (!row) return;
  if (mainAges) row.mainAges = mainAges;
  if (incomingAges) row.incomingAges = incomingAges;
}

/** The parent (father via HUSB, mother via WIFE) from the first family this
 *  person is a child in. The single lookup behind both the parent rows
 *  ({@link parentRelative}) and the parents' ages on a birth row. */
function parentIndi(indi: Individual, ds: Dataset, role: "husband" | "wife"): Individual | undefined {
  for (const famId of indi.childOf) {
    const id = ds.families.get(famId)?.[role];
    const parent = id ? ds.individuals.get(id) : undefined;
    if (parent) return parent;
  }
  return undefined;
}

/** Age(s) at an individual event's date: the parents' ages ("♂/♀") on a birth,
 *  otherwise the person's own age. Undefined when the date or a birth is missing. */
function eventAgeBadges(
  indi: Individual | undefined,
  ds: Dataset | undefined,
  ev: GedEvent | undefined,
  tag: string,
  t: Translate,
): AgeBadge[] | undefined {
  if (!ev?.date) return undefined;
  if (tag === "BIRT") {
    if (!indi || !ds) return undefined;
    return coupleAgesDisplay(
      parentIndi(indi, ds, "husband"),
      parentIndi(indi, ds, "wife"),
      ev.date,
      { husband: t("event.age.father"), wife: t("event.age.mother") },
      t,
    );
  }
  const birth = birthDateOf(indi);
  const age = ageBetween(birth, ev.date);
  if (age === undefined) return undefined;
  const detail = fullAgeBetween(birth, ev.date, t);
  return [{ text: String(age), title: detail ? `${t("event.age.person")}: ${detail}` : t("event.age.person") }];
}

/** The husband's and wife's ages ("♂/♀") at a family event's date. */
function coupleEventAges(
  fam: Family | undefined,
  ds: Dataset | undefined,
  ev: GedEvent | undefined,
  t: Translate,
): AgeBadge[] | undefined {
  if (!fam || !ds || !ev?.date) return undefined;
  return coupleAgesDisplay(
    fam.husband ? ds.individuals.get(fam.husband) : undefined,
    fam.wife ? ds.individuals.get(fam.wife) : undefined,
    ev.date,
    { husband: t("event.age.husband"), wife: t("event.age.wife") },
    t,
  );
}

function pushRow(
  rows: FieldRow[],
  key: string,
  label: string,
  main: string | undefined,
  incoming: string | undefined,
  displayLabel?: string,
  mainTitle?: string,
  incomingTitle?: string,
): void {
  const m = (main ?? "").trim();
  const i = (incoming ?? "").trim();
  if (!m && !i) return; // nothing to show
  rows.push({ key, label, main: m, incoming: i, state: stateOf(key, m, i), displayLabel, mainTitle, incomingTitle });
}

/**
 * Push a list-of-relatives row (partners, children) whose two sides are *aligned*
 * by name: a main relative and its closest incoming counterpart share a line,
 * while relatives with no match on the other side get a line of their own (the
 * opposite cell left blank). This lines matching people up so differences and
 * additions are easy to spot. Blank-padding is kept out of the emptiness/state
 * test so a one-sided list still reads as main-/incoming-only.
 */
function pushRelativesRow(
  rows: FieldRow[],
  key: string,
  label: string,
  main: Relative[],
  incoming: Relative[],
  opts: { displayLabel?: string; perChildChoice?: boolean; kind?: RelativeKind } = {},
): void {
  if (main.length === 0 && incoming.length === 0) return;
  const { displayLabel, perChildChoice, kind = "partner" } = opts;
  const pairs = alignRelatives(main, incoming, kind);
  // Joined text is still kept so comparison/state and the merge's default choice
  // (main-if-present) work; rendering uses the structured `relatives` pairs.
  const m = main.length ? pairs.map((p) => p.main?.text ?? "").join("\n") : "";
  const i = incoming.length ? pairs.map((p) => p.incoming?.text ?? "").join("\n") : "";
  const state: FieldState =
    m && !i ? "main-only" : !m && i ? "incoming-only" : compareKey(m) === compareKey(i) ? "agree" : "conflict";
  rows.push({
    key,
    label,
    ...(displayLabel !== undefined ? { displayLabel } : {}),
    ...(perChildChoice ? { perChildChoice: true } : {}),
    main: m,
    incoming: i,
    state,
    relatives: pairs,
    mainRefs: pairs.map((p) => p.main?.id),
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
 * In which role a pair of relatives is being compared. Children of one couple
 * carry their parents' surname whatever their given names, so between them the
 * surname is not evidence; a partner's surname is.
 */
type RelativeKind = "child" | "partner";

/**
 * Minimum name similarity for two relatives to be paired onto the same line.
 * Set high because relatives typically share a surname (which alone scores ~0.6),
 * so distinguishing the same person from a same-surname sibling rests on the
 * given name: this threshold demands a strong given-name agreement too, pairing
 * spelling variants (Ana/Anna) while keeping distinct siblings (Berta/Doris) apart.
 * Between children, where the surname is dropped altogether, it *is* the
 * given-name bar — and deliberately the same 0.85 the matcher calls two records
 * one person at (`SAME_PERSON_GIVEN`).
 */
export const RELATIVE_PAIR_THRESHOLD = 0.85;

/**
 * How far two *exact* birth years may sit apart before the gap is read as
 * "different children" rather than as a discrepancy over one child. A year
 * taken off a baptism a season later, or a transcription slip, moves a birth
 * by a year or two — Katarina 1803 against her own record as Catharina 1805 —
 * so the pairing tolerates that much while a wider gap still pulls same-named
 * siblings apart. Kept just under `SAME_PERSON_YEAR_GAP` (±3), the record-level
 * bar the matcher itself applies to one person's two records.
 */
const EXACT_YEAR_TOLERANCE = 2;

/**
 * How alike two individuals look *as relatives* — the same name + birth-year
 * signal that aligns partners and children in the review table, exposed so
 * other views pair people the same way (the compare tree falls back to it for
 * spouses the matcher never paired). At or above
 * {@link RELATIVE_PAIR_THRESHOLD} means "the same person"; the caller says in
 * which role it is asking, because two children of one couple are compared on
 * their given names alone (their surname is their parents'). Ranking score,
 * not a 0..1 similarity — the birth-year bonus can carry it past 1.
 */
export function relativePersonSimilarity(
  a: Individual,
  b: Individual,
  kind: RelativeKind = "partner",
): number {
  return relativeSimilarity(partnerToRelative(a), partnerToRelative(b), kind);
}

/**
 * Score given to a union pair joined on the partner's given name alone (see
 * {@link samePartner}) — above the 0.5 bar `pairFamilies` admits candidates at,
 * but below any full-name agreement, so a partner who matches outright still
 * wins the pairing when both compete for the same union.
 */
const PARTNER_PAIR_SCORE = 0.6;

/**
 * Are these two partners the same person? Their whole names agreeing at
 * {@link RELATIVE_PAIR_THRESHOLD} settles it. Failing that, an equally strong
 * *given* name still does, provided no two known birth years contradict it:
 * a wife carried under her maiden name in one file and her married name in the
 * other shares only her given name ("Ana Novak" vs "Ana Bratuša" scores 0.67),
 * and that is a spelling of one woman, not two marriages.
 */
function samePartner(a: Relative, b: Relative): boolean {
  if (relativeSimilarity(a, b) >= RELATIVE_PAIR_THRESHOLD) return true;
  if (a.birthYear != null && b.birthYear != null && a.birthYear !== b.birthYear) return false;
  const aGiven = a.name?.given?.trim();
  const bGiven = b.name?.given?.trim();
  if (!aGiven || !bGiven) return false;
  return givenSimilarity(aGiven, bGiven) >= RELATIVE_PAIR_THRESHOLD;
}

/**
 * Greedily pair main and incoming relatives by name similarity (best pairs
 * first), then emit aligned pairs: matched relatives share a pair in main
 * order, main-only relatives get a pair with no incoming side, and any
 * unmatched incoming relatives are appended with no main side.
 */
function alignRelatives(main: Relative[], incoming: Relative[], kind: RelativeKind): RelativePair[] {
  const cand: { mi: number; ii: number; sim: number }[] = [];
  main.forEach((m, mi) =>
    incoming.forEach((c, ii) => {
      const sim = relativeSimilarity(m, c, kind);
      if (sim >= RELATIVE_PAIR_THRESHOLD) cand.push({ mi, ii, sim });
    }),
  );
  cand.sort((a, b) => b.sim - a.sim);

  const matchOf = new Map<number, number>(); // main index -> incoming index
  const usedIncoming = new Set<number>();
  const usedMain = new Set<number>();
  for (const p of cand) {
    if (usedMain.has(p.mi) || usedIncoming.has(p.ii)) continue;
    usedMain.add(p.mi);
    usedIncoming.add(p.ii);
    matchOf.set(p.mi, p.ii);
  }

  const pairs: RelativePair[] = [];
  main.forEach((m, mi) => {
    const ii = matchOf.get(mi);
    pairs.push({
      main: relativeCell(m),
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
 * Do the dates alone say these are one person? Asked only when a name can't
 * (see {@link relativeSimilarity}), so the bar is agreement, not mere absence
 * of conflict: both births known, asserted rather than estimated, in the same
 * year, and never contradicted by the day within that year or by a death year.
 */
function datesIdentify(a: Relative, b: Relative): boolean {
  if (a.birthYear == null || b.birthYear == null) return false;
  if (a.birthApprox || b.birthApprox) return false;
  if (a.birthYear !== b.birthYear) return false;
  if (a.birthDay != null && b.birthDay != null && a.birthDay !== b.birthDay) return false;
  return !(a.deathYear != null && b.deathYear != null && a.deathYear !== b.deathYear);
}

/**
 * Similarity of two relatives, used to align children/partners. The name (given
 * + surname) is the base signal; birth year then nudges the score so the pairing
 * lines people up by name *and* birth: a shared birth year rescues a borderline
 * name match (spelling variants of the same child), while diverging birth years
 * pull same-named siblings apart so they don't collapse onto one line. The
 * year only ever corroborates a name that already agrees — see the guard below.
 */
function relativeSimilarity(a: Relative, b: Relative, kind: RelativeKind = "partner"): number {
  // Placeholders ("NN", "?", "Living") name nobody, so they count as missing
  // here exactly as they do in the matcher — two of them are not a match.
  const an = comparableName(a.name);
  const bn = comparableName(b.name);

  // A surname is the one thing everybody in the family shares, so on its own it
  // identifies nobody: an infant recorded without a given name would otherwise
  // score a *perfect* name match against each of its siblings in turn (the
  // weighted average is taken over the parts both sides have, and the surname
  // is the only one). Without a given name on both sides the dates have to
  // carry the pairing. The matcher holds its own pairs to the same bar — see
  // the `anchored` rule in scoreIndividual.
  if (!an?.given || !bn?.given) return datesIdentify(a, b) ? RELATIVE_PAIR_THRESHOLD : 0;

  // Children of one couple share the family surname by construction, so it
  // identifies nobody among them: weighted 0.6 in `nameSimilarity` it floors
  // every sibling pair at ~0.6, which lifted "Anton"/"Alojz" (given names
  // 0.64 apart — two brothers) to 0.856, over the bar. Only the given name
  // discriminates, so between children only the given name is compared, and
  // the bar becomes a given-name bar. The matcher drops the surname for the
  // same reason — see `givenNameSetSimilarity`. Partners keep the whole name:
  // there the surname is real evidence, not a shared inheritance.
  const nameSim = kind === "child"
    ? givenSimilarity(an.given, bn.given)
    : nameSimilarity(an, bn) ?? 0;

  if (a.birthYear == null || b.birthYear == null) return nameSim;
  const gap = Math.abs(a.birthYear - b.birthYear);
  // An ABT/EST birth year on either side is an estimate, not an assertion, so
  // it shouldn't count as heavily against the pairing as a gap between two
  // exact dates would — mirrors the wider tolerance dateSimilarity gives
  // approximate dates.
  const tolerance = a.birthApprox || b.birthApprox ? 10 : EXACT_YEAR_TOLERANCE;
  if (gap > tolerance) return Math.max(0, nameSim - 0.25);
  // Within tolerance the year *corroborates* the name and ranks the candidates
  // — it never stands in for a name. Siblings share the year they were born as
  // readily as the surname, so without this guard a shared 1803 lifted
  // "Katarina"/"Agnes" over the bar and consumed the incoming child her real
  // counterpart Neža needed. For children the name must already carry the
  // pairing on its own; for partners it need only not conflict outright.
  const eligible = kind === "child"
    ? nameSim >= RELATIVE_PAIR_THRESHOLD
    : givenSimilarity(an.given, bn.given) >= PARENT_GIVEN_CONFLICT;
  // Deliberately left above 1 when it lands there: the value ranks candidates
  // for the greedy pairing, and clamping made a child born the same year score
  // exactly as much as one born two years off, leaving which sibling paired to
  // the order they happened to be listed in.
  return eligible ? nameSim + (gap === 0 ? 0.15 : 0.05) : nameSim;
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

/**
 * A row for an event's source citations, shown under its other fields so each
 * side's sources sit in their own column (like any other field) rather than
 * as badges on the event header. The event's own attached links (`_LINK`/`WWW`,
 * distinct from `SOUR` citations) ride along as icons on this same row — but a
 * link already covered by one of that side's citation URLs is dropped, since
 * the citation itself is already clickable to that URL.
 *
 * `mainPool`/`incomingPool` widen the link-to-citation matching to every
 * citation that side keeps on the whole record (see {@link recordCitations}),
 * not just the ones in this row.
 */
function pushSourcesRow(
  rows: FieldRow[],
  key: string,
  label: string,
  main: SourceCitation[] | undefined,
  incoming: SourceCitation[] | undefined,
  mainLinks?: string[],
  incomingLinks?: string[],
  mainPool: SourceCitation[] = [],
  incomingPool: SourceCitation[] = [],
): void {
  const mBase = main ?? [];
  const iBase = incoming ?? [];
  // A plain link that resolves to the exact same archival page as a citation
  // already on the other side is the same record, just not yet itself a
  // citation on this side — show it as that citation (with the other side's
  // title/page) instead of a disconnected new link, so an identical source
  // doesn't read as a conflict needing a merge decision.
  const mRec = reconcileLinksAsCitations(mainLinks, mBase, [...iBase, ...incomingPool]);
  const iRec = reconcileLinksAsCitations(incomingLinks, iBase, [...mBase, ...mainPool]);
  const mRemainingLinks = mRec.remainingLinks;
  const iRemainingLinks = iRec.remainingLinks;
  // When the citation a link matched sits elsewhere on the other side's record
  // (that side cites the page on an event, this one hangs a bare link on the
  // person), it isn't in this row's other column yet — put it there too, so the
  // row reads as agreement instead of offering to import a page the other file
  // already cites.
  const m = withCitations(mRec.sources, iRec.matched);
  const i = withCitations(iRec.sources, mRec.matched);
  const mIcons = linksNotCitedAsSource(mRemainingLinks, m);
  const iIcons = linksNotCitedAsSource(iRemainingLinks, i);
  if (m.length === 0 && i.length === 0 && mIcons.length === 0 && iIcons.length === 0) return;
  rows.push({
    key,
    label,
    // Keep a text form — including the icon-only links — so the default merge
    // choice (main-if-present) and the row's agree/conflict state see them
    // too, not just the citations.
    main: [...m.map((c) => c.title ?? c.sourceId), ...mIcons].join("\n"),
    incoming: [...i.map((c) => c.title ?? c.sourceId), ...iIcons].join("\n"),
    state: sourcesState(m, i, mIcons, iIcons),
    mainSources: m.length ? m : undefined,
    incomingSources: i.length ? i : undefined,
    mainLinkIcons: mIcons.length ? mIcons : undefined,
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
 *
 * `matched` is the subset of `otherSources` that was hit, so the caller can
 * also surface them in the other column when they came from outside the row.
 */
function reconcileLinksAsCitations(
  links: string[] | undefined,
  ownSources: SourceCitation[],
  otherSources: SourceCitation[],
): { sources: SourceCitation[]; matched: SourceCitation[]; remainingLinks: string[] } {
  if (!links?.length || !otherSources.length) {
    return { sources: ownSources, matched: [], remainingLinks: links ?? [] };
  }
  const matched: SourceCitation[] = [];
  const remainingLinks: string[] = [];
  for (const url of links) {
    const key = linkKey(url);
    const match = otherSources.find((c) => c.url && linkKey(c.url) === key);
    if (match) matched.push(match);
    else remainingLinks.push(url);
  }
  return { sources: matched.length ? [...ownSources, ...matched] : ownSources, matched, remainingLinks };
}

/** `sources` plus any of `extra` it doesn't already carry (by citation identity). */
function withCitations(sources: SourceCitation[], extra: SourceCitation[]): SourceCitation[] {
  if (!extra.length) return sources;
  const have = new Set(sources.map(sourceCitationKey));
  const added = extra.filter((c) => {
    const key = sourceCitationKey(c);
    if (have.has(key)) return false;
    have.add(key);
    return true;
  });
  return added.length ? [...sources, ...added] : sources;
}

/**
 * Every citation a record carries at *any* scope — its own plus each event's —
 * as the pool a plain link on the other side is matched against. The two files
 * routinely attach the same archival page at different levels: one cites the
 * parish register on the death event, the other hangs a bare link on the
 * person. Without the whole-record view those never meet and the link reads as
 * a new source to import.
 *
 * Only citations whose URL is the precise cited page (`exact`) qualify. A
 * fallback URL is the holding repository's website, shared by every citation
 * from that archive, so it would match any link to that site and wrongly
 * silence a genuine import.
 */
function recordCitations(record: Individual | Family | undefined): SourceCitation[] {
  if (!record) return [];
  const all = [...(record.sources ?? []), ...record.events.flatMap((e) => e.sources ?? [])];
  return all.filter((c) => c.exact && c.url);
}

/** Compares both citations and icon-only links together: a side "has" the
 * field if either is non-empty, so a links-only difference isn't masked as
 * "agree" just because the citations happen to match (or both be empty). */
function sourcesState(
  main: SourceCitation[],
  incoming: SourceCitation[],
  mainIcons: string[] = [],
  incomingIcons: string[] = [],
): FieldState {
  const m = new Set(main.map(sourceCitationKey));
  const i = new Set(incoming.map(sourceCitationKey));
  const mi = new Set(mainIcons.map(linkKey));
  const ii = new Set(incomingIcons.map(linkKey));
  const mainHas = m.size > 0 || mi.size > 0;
  const incomingHas = i.size > 0 || ii.size > 0;
  if (mainHas && !incomingHas) return "main-only";
  if (!mainHas && incomingHas) return "incoming-only";
  const sameCitations = m.size === i.size && [...m].every((x) => i.has(x));
  const sameIcons = mi.size === ii.size && [...mi].every((x) => ii.has(x));
  return sameCitations && sameIcons ? "agree" : "conflict";
}

function extraNameText(n: import("../gedcom/types").PersonName, t: Translate): string {
  const name = displayName(n);
  return n.type ? `${name} (${nameTypeLabel(n.type, t)})` : name;
}

/** Date rows that carry a person's birth year — birth, else baptism/christening
 *  as a proxy, the same evidence `birthYear` reads. Matches both the plain
 *  `BIRT.date` key and a repeated event's `BIRT.1.date`. */
const BIRTH_DATE_ROW = /^(BIRT|BAPM|CHR)(\.\d+)?\.date$/;

/**
 * Does this row disagree about *who the person is*, rather than about a detail
 * to reconcile? A conflicting given name or surname, or two birth dates naming
 * different years — the same evidence the compare tree paints a node red for
 * (see `nodeStatus` in chart/personTree), so a row and its node agree.
 */
export function isMajorDifference(row: FieldRow): boolean {
  if (row.state !== "conflict") return false;
  if (row.key === "given" || row.key === "surname") return true;
  if (!BIRTH_DATE_ROW.test(row.key)) return false;
  const mainYear = parseDate(row.main).year;
  const incomingYear = parseDate(row.incoming).year;
  return mainYear !== undefined && incomingYear !== undefined && mainYear !== incomingYear;
}

function stateOf(key: string, main: string, incoming: string): FieldState {
  if (main && !incoming) return "main-only";
  if (!main && incoming) return "incoming-only";
  const keyFn = key.endsWith(".place")
    ? placeCompareKey
    : key.endsWith(".date")
      ? dateCompareKey
      : compareKey;
  return keyFn(main) === keyFn(incoming) ? "agree" : "conflict";
}


/** Events that can occur at most once per person — always paired with the incoming side, never score-gated. */
const SINGLE_EVENT_TAGS = new Set(["BIRT", "DEAT", "BURI", "_FNRL", "_INTE"]);

export function orderedEventTags(
  main?: Individual,
  compare?: Individual,
): Array<{ tag: string; mainIdx: number; compareIdx: number; keyIdx: number; multi: boolean }> {
  const mEvents = main?.events ?? [];
  const cEvents = compare?.events ?? [];

  const mByTag = new Map<string, GedEvent[]>();
  const cByTag = new Map<string, GedEvent[]>();
  for (const e of mEvents) { const a = mByTag.get(e.tag) ?? []; a.push(e); mByTag.set(e.tag, a); }
  for (const e of cEvents) { const a = cByTag.get(e.tag) ?? []; a.push(e); cByTag.set(e.tag, a); }

  const allTags = new Set([...mByTag.keys(), ...cByTag.keys()]);
  type Instance = { tag: string; mainIdx: number; compareIdx: number; keyIdx: number; multi: boolean };
  const instances: Instance[] = [];

  for (const tag of allTags) {
    const mTagEvs = mByTag.get(tag) ?? [];
    const cTagEvs = cByTag.get(tag) ?? [];
    const multi = Math.max(mTagEvs.length, cTagEvs.length) > 1;

    if (!multi) {
      const mIdx = mTagEvs.length > 0 ? 0 : -1;
      const cIdx = cTagEvs.length > 0 ? 0 : -1;
      // When at least one side has a dated event and the pair scores too low, show them separately.
      // Birth/death/burial happen at most once per person, so they're always the same
      // event regardless of score — no splitting for those tags.
      // Only require one side to have a date so that a dated main event paired with a
      // clearly different-place compare event (no date) is still split correctly.
      if (mIdx >= 0 && cIdx >= 0
          && !SINGLE_EVENT_TAGS.has(tag)
          && (mTagEvs[0].date?.year != null || cTagEvs[0].date?.year != null)
          && eventPairScore(mTagEvs[0], cTagEvs[0]) < MIN_EVENT_PAIR_SCORE) {
        instances.push({ tag, mainIdx: 0, compareIdx: -1, keyIdx: 0, multi: true });
        instances.push({ tag, mainIdx: -1, compareIdx: 0, keyIdx: 1, multi: true });
      } else {
        instances.push({ tag, mainIdx: mIdx, compareIdx: cIdx, keyIdx: 0, multi: false });
      }
    } else {
      // Pair events by date+place similarity instead of positional index.
      const pairs = pairEventsByDatePlace(mTagEvs, cTagEvs);
      const usedM = new Set(pairs.map(p => p.mi));
      const usedC = new Set(pairs.map(p => p.ci));
      let keyIdx = 0;
      for (const { mi, ci } of pairs) instances.push({ tag, mainIdx: mi, compareIdx: ci, keyIdx: keyIdx++, multi: true });
      for (let mi = 0; mi < mTagEvs.length; mi++) if (!usedM.has(mi)) instances.push({ tag, mainIdx: mi, compareIdx: -1, keyIdx: keyIdx++, multi: true });
      for (let ci = 0; ci < cTagEvs.length; ci++) if (!usedC.has(ci)) instances.push({ tag, mainIdx: -1, compareIdx: ci, keyIdx: keyIdx++, multi: true });
    }
  }

  // Anchors for placing undated life-zone events (RESI, OCCU, …) between birth
  // and death rather than before all dated events — see `lifespanAnchors`.
  const anchors = lifespanAnchors([...mEvents, ...cEvents]);

  instances.sort((a, b) => {
    const me = a.mainIdx >= 0 ? (mByTag.get(a.tag) ?? [])[a.mainIdx] : undefined;
    const ce = a.compareIdx >= 0 ? (cByTag.get(a.tag) ?? [])[a.compareIdx] : undefined;
    const me2 = b.mainIdx >= 0 ? (mByTag.get(b.tag) ?? [])[b.mainIdx] : undefined;
    const ce2 = b.compareIdx >= 0 ? (cByTag.get(b.tag) ?? [])[b.compareIdx] : undefined;
    const dateA = zoneSortKey(me?.date ?? ce?.date, a.tag, anchors);
    const dateB = zoneSortKey(me2?.date ?? ce2?.date, b.tag, anchors);
    if (dateA !== dateB) return dateA - dateB;
    const posA = EVENT_ORDER.indexOf(a.tag);
    const posB = EVENT_ORDER.indexOf(b.tag);
    return (posA === -1 ? 999 : posA) - (posB === -1 ? 999 : posB) || a.keyIdx - b.keyIdx;
  });

  return instances;
}

/** Birth-adjacent tags that should always sort before any dated event. */
const BIRTH_ZONE_TAGS = new Set(["BIRT", "BAPM", "CHR", "FCOM", "CONF", "ADOP"]);

/**
 * Life-zone tags that can only occur while the person is alive, so they must
 * always sort before a known death/burial/cremation date even when their own
 * (often imprecise) date would otherwise rank later. WILL/PROB are excluded:
 * probate routinely happens after death, so their date should be trusted as-is.
 */
export const LIFE_ZONE_TAGS = new Set([
  "OCCU", "EDUC", "GRAD", "RETI", "_MILT", "_MILI",
  "TITL", "DSCR", "RELI", "NATI", "RACE", "NCHI", "NOBI", "LATR", "DEED", "_MEDC", "ILL",
  "RESI", "EMIG", "IMMI", "NATU", "CENS",
]);

/** Death/burial/funeral/interment/cremation tags — the terminal events a
 *  life-zone event must precede. */
export const DEATH_ZONE_TAGS = new Set(["DEAT", "CREM", "BURI", "_INTE", "_FNRL"]);

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
 * Symmetric to `clampBeforeDeathZone`: a birth-adjacent event (BAPM, CHR, …)
 * can only occur at/after birth, so it must never sort before a known birth
 * date — even when its own date is genuinely earlier. This happens when the
 * date being sorted comes from the *other* side of a comparison (e.g. a compare
 * record's precise 1859 christening ranked against a main's fuzzy `ABT 1862`
 * birth) or when a precise christening outranks a year-only birth in the same
 * record (a year-only date sorts to the end of its year; see `dateToSortKey`).
 * Clamps to just after the birth key, keeping birth-zone tags in `EVENT_ORDER`.
 */
export function clampAfterBirthZone(tag: string, key: number, maxBirthKey: number | undefined): number {
  if (BIRTH_ZONE_TAGS.has(tag) && maxBirthKey != null && key < maxBirthKey) {
    const pos = EVENT_ORDER.indexOf(tag);
    return maxBirthKey + (pos >= 0 ? pos : 5);
  }
  return key;
}

/**
 * Lifespan anchors used to place undated events relative to a person's known
 * birth/death dates — shared by the comparison view (`orderedEventTags`) and
 * the Edit view's event list so both order events identically.
 *  - `minBirthKey` — earliest known BIRT date key (anchors the BIRT row itself, so
 *    a life-zone event that's after the *earliest* birth never slips before the
 *    birth row just because the other side's record carries a later birth date).
 *  - `maxBirthKey` — latest known BIRT date key (anchors undated birth-zone tags).
 *  - `minDeathKey` — earliest known death-zone date key (clamps imprecise
 *    life-zone dates just before it).
 *  - `midLifeKey` — mid-point between birth and death, where undated life-zone
 *    events (RESI, OCCU, …) sort.
 */
export interface LifespanAnchors {
  midLifeKey: number;
  minBirthKey: number | undefined;
  maxBirthKey: number | undefined;
  minDeathKey: number | undefined;
}

/** Derive `LifespanAnchors` from a person's (and optionally a compare's) events. */
export function lifespanAnchors(events: { tag: string; date?: GedDate }[]): LifespanAnchors {
  const birthKeys = events
    .filter((e) => e.tag === "BIRT" && e.date?.year != null)
    .map((e) => dateToSortKey(e.date));
  const deathKeys = events
    .filter((e) => DEATH_ZONE_TAGS.has(e.tag) && e.date?.year != null)
    .map((e) => dateToSortKey(e.date));
  const minBirthKey = birthKeys.length > 0 ? Math.min(...birthKeys) : undefined;
  const maxBirthKey = birthKeys.length > 0 ? Math.max(...birthKeys) : undefined;
  const maxDeathKey = deathKeys.length > 0 ? Math.max(...deathKeys) : undefined;
  const minDeathKey = deathKeys.length > 0 ? Math.min(...deathKeys) : undefined;
  const midLifeKey =
    minBirthKey != null && maxDeathKey != null ? (minBirthKey + maxDeathKey) / 2
    : minBirthKey != null ? minBirthKey + 30 * 10_000
    : maxDeathKey != null ? maxDeathKey - 30 * 10_000
    : 15_000_000; // ~year 1500 fallback
  return { midLifeKey, minBirthKey, maxBirthKey, minDeathKey };
}

/**
 * Sort key for an event with the given date/tag. When the event has a date,
 * returns the precision-aware date key (clamped before any known death date for
 * life-zone tags, and after any known birth date for birth-zone tags). When
 * undated, uses zone-based placement:
 *  - Birth-zone tags (BIRT, BAPM, …): pinned just after the known birth date
 *    (so e.g. an undated christening still sorts after a dated birth), or
 *    key 0–5 when no birth date is known at all.
 *  - Death-zone tags (DEAT, CREM, BURI, _INTE, _FNRL): key 99_999_995–99_999_999, always last.
 *  - Life-zone tags (RESI, OCCU, …): key near `midLifeKey`, between birth and death.
 */
export function zoneSortKey(d: GedDate | undefined, tag: string, a: LifespanAnchors): number {
  if (d?.year != null) {
    const key = clampBeforeDeathZone(tag, dateToSortKey(d), a.minDeathKey);
    // The BIRT row anchors at the earliest birth evidence across the compared
    // pair: when the two records disagree (e.g. main `ABT 1820` vs compare
    // `1 NOV 1818`), the comparator picks the main date for the row, which can
    // let a contemporaneous life-zone event from the other side (a `1818`
    // residence) sort ahead of the birth. Clamping down to `minBirthKey` keeps
    // the birth row first while still letting a genuinely pre-birth event lead.
    if (tag === "BIRT" && a.minBirthKey != null && key > a.minBirthKey) return a.minBirthKey;
    return clampAfterBirthZone(tag, key, a.maxBirthKey);
  }
  const pos = EVENT_ORDER.indexOf(tag);
  if (BIRTH_ZONE_TAGS.has(tag)) {
    return a.maxBirthKey != null ? a.maxBirthKey + (pos >= 0 ? pos : 5) + 1 : (pos >= 0 ? pos : 5);
  }
  // Undated terminal events, in the order they happen: what becomes of the body
  // in sequence (a cremation precedes the laying to rest of the ashes), then
  // the funeral service, which a record may place after any of them.
  if (tag === "_FNRL") return 99_999_999;
  if (tag === "_INTE") return 99_999_998;
  if (tag === "BURI") return 99_999_997;
  if (tag === "CREM") return 99_999_996;
  if (tag === "DEAT") return 99_999_995;
  return a.midLifeKey + (pos === -1 ? 500 : pos * 1_000);
}


/** Minimum score for two events to be considered the same event. Below this they are shown separately. */
const MIN_EVENT_PAIR_SCORE = 0.6;

/** Greedy bipartite matching of events by date+place similarity. */
function pairEventsByDatePlace(
  mainEvents: GedEvent[],
  compareEvents: GedEvent[],
): { mi: number; ci: number }[] {
  const cands: { mi: number; ci: number; score: number }[] = [];
  for (let mi = 0; mi < mainEvents.length; mi++) {
    for (let ci = 0; ci < compareEvents.length; ci++) {
      const score = eventPairScore(mainEvents[mi], compareEvents[ci]);
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

/** The comparable content of an event, for the identical-pair fast path. */
function eventContentKey(e: GedEvent): string {
  return [e.type ?? "", e.value ?? "", e.date?.raw ?? "", e.place?.raw ?? "", e.address?.raw ?? "", e.note ?? ""].join("\x1f");
}

function eventPairScore(me: GedEvent, ce: GedEvent): number {
  // Two events with identical content are the same event, full stop. Without
  // this, two *undated* copies can never pair (missing dates cap the score
  // below the threshold), so comparing overlapping files showed the incoming
  // copy as a separate "incoming-only" event — and a confirm with default
  // choices then imported it as a duplicate.
  if (eventContentKey(me) === eventContentKey(ce)) return 1;
  return datePairSim(me.date, ce.date) * 0.6 + eventPlaceSim(me, ce) * 0.4;
}

/** Year-based date similarity: 1.0 for gap ≤ 1 year, decays to 0 beyond 10 years.
 *  Range qualifiers (FROM..TO, BET..AND) use their full span: overlapping ranges
 *  score 1.0 so an exact year that falls inside a FROM-TO period is a strong match. */
function datePairSim(a: GedDate | undefined, b: GedDate | undefined): number {
  if (a?.year == null || b?.year == null) return 0.3;
  const hasRange = (d: GedDate) => (d.qualifier === "range" || d.qualifier === "between") && d.year2 != null;
  const aLo = a.year;
  const aHi = hasRange(a) ? a.year2! : a.year;
  const bLo = b.year;
  const bHi = hasRange(b) ? b.year2! : b.year;
  if (aLo <= bHi && bLo <= aHi) return 1.0; // ranges overlap (or one point is inside the other)
  const gap = Math.max(aLo, bLo) - Math.min(aHi, bHi); // positive gap between non-overlapping ranges
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
