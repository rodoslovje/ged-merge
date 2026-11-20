import type { Dataset, Family, GedDate, GedNode, Individual, Sex } from "../gedcom/types";
import { todayDate } from "../gedcom/age";
import { birthParentFamilies } from "../gedcom/couple";
import {
  DEATH_TAGS, birthDateOf, deathDateOf,
  isDeceased,
} from "../gedcom/lifespan";
import { addEventNode, setEventField, setFamilyEventField } from "../gedcom/edit/events";
import { addAdditionalName, setAdditionalName, setMarriedName } from "../gedcom/edit/names";
import { familiesByMarriage } from "../gedcom/familySort";
import { inferNameVariants } from "../normalize/nameVariants";
import type { FormatOverrides } from "../normalize/formatOverrides";
import { allowsChild } from "./conformance/allows";
import { rebuildFamily, rebuildIndividual } from "../gedcom/edit/cache";
import { collectMediaRefs, detectMediaMode } from "../gedcom/media";
import { clearObjeNodeCache, isPointer, objeNodesFor } from "../gedcom/source";
import { bumpSourceCacheVersion } from "../gedcom/edit/cache";
import { cloneNode, firstChild, childrenByTag } from "../gedcom/node";
import { unionMarriage, type UnionMarriage } from "../gedcom/union";
import { previewBirthEstimateDates, previewMarriageEstimates } from "./estimates";
import { isPrivateNode } from "../gedcom/private";
import { NOTE_TAGS } from "../gedcom/builder";
import {
  attachInlineMedia,
  attachMediaPointer,
  createMediaRecord,
  findSharedMediaByFile,
} from "../gedcom/edit/media";
import { EVENT_CHILD_ORDER, INDI_CHILD_ORDER, insertOrdered, insertRecord, markEventTouched, nextXref, removeRecordsByXref } from "../gedcom/edit/shared";
import { carriesLineValue, isNonStandardTag, isOccurrenceFlag } from "../gedcom/eventTags";
import { marriedSurnamesOf } from "../match/relatives";
import { foldSearch, matchesTerms, queryTerms, startSearchIndex, type SearchRow } from "../ui/globalSearch";
import { finish, sliced, type BuildSteps, type SlicedBuild } from "./sliced";
import { patchesFromSnapshots, snapshotRecords, type RecordPatch } from "../ui/historyTypes";

/**
 * Batch actions (Tools → Normalize & batch): filter the whole file with
 * composable criteria, then apply one action to every match — attach a media
 * placeholder, cite a source, or remove a media reference. Pure functions;
 * the panel applies the returned patches through the app's undo stack.
 *
 * Extending:
 *  - a new filter = a new {@link BatchCriterion} union member + a case in
 *    {@link matchesBatch} (+ its editor row in `BatchSection`);
 *  - a new action = a new {@link BatchActionSpec} union member + a case in
 *    {@link applyBatchAction} (+ its editor in `BatchSection`).
 */

// ── Filter criteria ─────────────────────────────────────────────────────────

/** Which side of the home person's family a relative is on. */
export type LineSide = "maternal" | "paternal";

/** One composable filter; a person matches when every active criterion holds. */
export type BatchCriterion =
  /** Text match over the name; `part` narrows it to the given name or the
   *  surname only (absent = anywhere, incl. lifespan — the search haystack). */
  | { kind: "name"; text: string; part?: "given" | "surname" }
  /** Presence of a name part rather than its text: the primary name's given
   *  name or surname (the fields the Edit view shows), or any married surname
   *  (inline `_MARNM` or a separate `TYPE married` name). */
  | { kind: "nameField"; field: "given" | "surname" | "married"; mode: "has" | "lacks" }
  | { kind: "sex"; value: Sex }
  | { kind: "birthYear"; from?: number; to?: number }
  /** Age in whole years — at death for the deceased, to today for everyone
   *  else; people without the needed date never qualify. */
  | { kind: "age"; op: "lt" | "gte"; years: number }
  /** `true` selects people with no death evidence in the file, `false` the deceased. */
  | { kind: "living"; value: boolean }
  /** Presence of one event/attribute on the person, by its GEDCOM tag —
   *  `lacks BIRT` finds everyone without a birth record. The sentinel
   *  {@link ANY_VENDOR_EVENT} tag matches any non-standard (`_`) event. A
   *  non-empty `text` narrows the events to those whose name (`TYPE`) or value
   *  contains it — `has EVEN "Graduation"`, `has OCCU "farmer"`. */
  | { kind: "event"; tag: string; mode: "has" | "lacks"; text?: string }
  /** The cause recorded on the person's death (`DEAT`/`CAUS`): `has` with no
   *  text finds any recorded cause, with text a cause containing it; `lacks`
   *  the opposite. */
  | { kind: "deathCause"; mode: "has" | "lacks"; text?: string }
  /** Presence of one event across the person's unions, by its GEDCOM tag —
   *  `lacks MARR`, next to a "has a partner" filter, finds the couples the file
   *  never married. The sentinel {@link ANY_EVENT} tag matches a union carrying
   *  any event at all, so `lacks` finds the unions nothing is recorded about.
   *  `has` means one union carries it, `lacks` that none does; people with no
   *  union at all count as lacking everything. `undated` finds a union whose
   *  event is recorded without a date (a union without the event at all is
   *  `lacks`'s question), `estimated` one whose event is dated
   *  only by an estimate (ABT, CAL, EST, BEF, AFT, BET) — both look at each
   *  union on its own, and people with no union match neither. A non-empty
   *  `text` narrows the events to those whose name (`TYPE`) or value contains
   *  it — `has EVEN "Partners"` finds the unions a custom event calls partners. */
  | { kind: "familyEvent"; tag: string; mode: FamilyEventMode; text?: string }
  /** Blood-line relationship to the start person (see {@link computeKinship}). */
  | { kind: "kinship"; rel: "ancestor" | "descendant" | "blood" | "notBlood" }
  /** Presence of a close relative in the file: a partner in some union (a
   *  family that names a second spouse), a child, or a named parent. Unlike
   *  `kinship` this needs no start person. */
  | { kind: "relation"; rel: "spouse" | "children" | "parents"; mode: "has" | "lacks" }
  | { kind: "place"; text: string }
  /** Text anywhere in the person's notes — record-level or on an event.
   *  Matched against the verbatim note text, so a note that is nothing but a
   *  URL ("https://web.facebook.com/…") is findable by any part of it. */
  | { kind: "note"; text: string }
  /** Text anywhere in the person's record — any field, shared notes included
   *  (see `personFullText`); every term must appear, in any order. */
  | { kind: "anyField"; text: string }
  /** The person's own record flagged private, or not. */
  | { kind: "private"; value: boolean }
  /** Whether any note the person carries is flagged private — which is a
   *  different question from the person being private, and the one that finds
   *  the records whose links stay out of publishing. */
  | { kind: "privateNote"; mode: "has" | "lacks" }
  /** `none`/`any` look at the person's whole media tray; `has`/`lacks` test one
   *  specific image, identified by shared-record xref and/or `FILE` value. */
  | { kind: "media"; mode: "none" | "any" | "has" | "lacks"; xref?: string; file?: string }
  /** `none`/`any` look at every citation the person carries; `eventHas` /
   *  `eventLacks` ask whether one event — the person's own or one of their
   *  unions' (a marriage) — cites a source: `eventLacks BIRT` finds the
   *  births still to document, whether or not the birth is recorded at all. */
  | { kind: "sources"; mode: "none" | "any" | "eventHas" | "eventLacks"; tag?: string }
  | { kind: "line"; side: LineSide };

/** How the family-event criterion tests a union's event. */
export type FamilyEventMode = "has" | "lacks" | "undated" | "estimated";

/** Sentinel `tag` for the event criterion: any non-standard (`_`) event. */
export const ANY_VENDOR_EVENT = "_*";
/** Sentinel `tag` for the family-event criterion: any event whatsoever. */
export const ANY_EVENT = "*";

/** Every criterion kind, for the panel's "add filter" picker. */
export const BATCH_CRITERION_KINDS: BatchCriterion["kind"][] = [
  "name", "nameField", "sex", "birthYear", "age", "living", "event", "deathCause", "familyEvent", "place", "note", "anyField", "media",
  "sources", "relation", "kinship", "line", "private", "privateNote",
];

/**
 * One filterable projection of an individual — the global search's row plus
 * the death/media facts batch criteria need, precomputed once per file version
 * so re-filtering is a cheap array scan.
 */
export interface BatchRow extends SearchRow {
  deathYear?: number;
  /** Whole years from dated birth to death (deceased) or to today (living);
   *  undefined when the needed date is missing. */
  age?: number;
  deceased: boolean;
  /** Tags of the person's lifted events/attributes (BIRT, OCCU, …). */
  eventTags: string[];
  /** The same events with their folded name (`TYPE`) and value, for the
   *  event criterion's text. */
  events: { tag: string; text: string }[];
  /** Folded causes of the person's death records, joined (empty when none). */
  deathCause: string;
  /** The same across every union the person is a partner in (MARR, DIV, `_MSTAT`, …). */
  familyEventTags: string[];
  /** Tags of the person's events, and their unions' events, that cite a source. */
  sourcedEventTags: string[];
  /** Per union, its events with how they are dated — for the `undated` and
   *  `estimated` family-event tests, which judge each union on its own. */
  unionEvents: { tag: string; dated: boolean; estimated: boolean; text: string }[][];
  /** Folded given names / surnames across every name form, for scoped matching. */
  givenText: string;
  surnameText: string;
  /** Whether the *primary* name fills its given-name / surname field, and
   *  whether the person carries any married surname (see {@link marriedSurnamesOf}). */
  hasGiven: boolean;
  hasSurname: boolean;
  hasMarriedName: boolean;
  /** A partner in some union, a child, a named parent — see the `relation` criterion. */
  hasSpouse: boolean;
  hasChildren: boolean;
  hasParents: boolean;
  /** The person's own record is flagged private (`PRIV` / `_PRIV` / `RESN`). */
  private: boolean;
  /** At least one note the person carries is flagged private — their own or one
   *  on an event, inline or in the shared record a pointer note names. */
  hasPrivateNote: boolean;
  /** Shared media record xrefs this person's tray references (record + events). */
  mediaXrefs: string[];
  /** Lower-cased `FILE` values of the tray's media (inline and resolved shared). */
  mediaFiles: string[];
  mediaCount: number;
}

/** Whole years lived — to the structured death date for the deceased, to
 *  today for people without death evidence (month/day-aware when both sides
 *  record them; year difference otherwise). Deliberately uncapped, unlike
 *  `ageBetween`: an impossibly old "living" person is a finding, not noise —
 *  it usually means a missing death record. */
export function ageOf(indi: Individual, now: Date): number | undefined {
  const b = birthDateOf(indi);
  const d = isDeceased(indi) ? deathDateOf(indi) : todayDate(now);
  if (b?.year === undefined || d?.year === undefined) return undefined;
  let age = d.year - b.year;
  if (b.month !== undefined && d.month !== undefined) {
    if (d.month < b.month) age--;
    else if (d.month === b.month && b.day !== undefined && d.day !== undefined && d.day < b.day) age--;
  }
  return Math.max(0, age);
}

/** Build the batch rows for a dataset (see {@link BatchRow}). `nameOf` is the
 *  caller's display-name formatter, as in `buildSearchRows`. */
export function buildBatchRows(
  dataset: Dataset,
  nameOf: (indi: Individual) => string,
  now: Date = new Date(),
): BatchRow[] {
  return finish(batchRowSteps(dataset, nameOf, now));
}

/** {@link buildBatchRows} in slices, for the panel: on a file of half a
 *  million people the rows take seconds, which the page must not stand still for. */
export function startBatchRows(
  dataset: Dataset,
  nameOf: (indi: Individual) => string,
  now: Date = new Date(),
): SlicedBuild<BatchRow[]> {
  return sliced(batchRowSteps(dataset, nameOf, now));
}

/** Rows finished between two points the build can pause at. */
const ROW_CHUNK = 256;
/** Share of the whole build the search rows beneath the batch rows take. */
const SEARCH_SHARE = 0.35;
/** Work the search index does between two pauses, in ms. */
const SEARCH_SLICE_MS = 4;

function* batchRowSteps(
  dataset: Dataset,
  nameOf: (indi: Individual) => string,
  now: Date,
): BuildSteps<BatchRow[]> {
  // Which shared NOTE records are private, so a pointer note can be judged
  // without re-scanning the records for every person that names one.
  const privateNoteXrefs = new Set(
    dataset.records.filter((r) => NOTE_TAGS.includes(r.tag) && r.xref && isPrivateNode(r)).map((r) => r.xref!),
  );
  const hasPrivateNote = (raw: GedNode): boolean => {
    for (const child of raw.children) {
      if (NOTE_TAGS.includes(child.tag)) {
        const v = child.value?.trim();
        if (v && isPointer(v) ? privateNoteXrefs.has(v) : isPrivateNode(child)) return true;
      }
      // Events carry notes of their own, and a note under one is as private as
      // a note on the record.
      if (hasPrivateNote(child)) return true;
    }
    return false;
  };
  const index = startSearchIndex(dataset.individuals, nameOf);
  while (!index.step(SEARCH_SLICE_MS)) yield index.progress * SEARCH_SHARE;
  const searchRows = index.rows;
  const rows: BatchRow[] = [];
  for (let i = 0; i < searchRows.length; i++) {
    if (i > 0 && i % ROW_CHUNK === 0) yield SEARCH_SHARE + (1 - SEARCH_SHARE) * (i / searchRows.length);
    const row = searchRows[i];
    const indi = dataset.individuals.get(row.id)!;
    const refs = collectMediaRefs(indi.raw, dataset.records);
    const d = deathDateOf(indi);
    const unions = indi.spouseOf.map((id) => dataset.families.get(id)).filter((f) => f !== undefined);
    rows.push({
      ...row,
      deathYear: d?.year,
      age: ageOf(indi, now),
      deceased: isDeceased(indi),
      eventTags: indi.events.map((e) => e.tag),
      events: indi.events.map((e) => ({ tag: e.tag, text: eventText(e) })),
      deathCause: foldSearch(indi.events.filter((e) => e.tag === "DEAT").map((e) => e.cause ?? "").join(" ").trim()),
      familyEventTags: [...new Set(unions.flatMap((f) => f.events.map((e) => e.tag)))],
      sourcedEventTags: [...new Set([indi.raw, ...unions.map((f) => f.raw)].flatMap(citingEventTags))],
      unionEvents: unions.map((f) =>
        f.events.map((e) => ({
          tag: e.tag,
          dated: e.date?.year !== undefined,
          estimated: isEstimatedDate(e.date),
          text: eventText(e),
        })),
      ),
      givenText: foldSearch(indi.names.map((n) => n.given ?? "").join(" ")),
      surnameText: foldSearch(indi.names.map((n) => n.surname ?? "").join(" ")),
      hasGiven: !!indi.names[0]?.given?.trim(),
      hasSurname: !!indi.names[0]?.surname?.trim(),
      hasMarriedName: marriedSurnamesOf(indi).length > 0,
      // A lone spouse in a family isn't a partner — single-parent families and
      // half-built unions name one side only.
      hasSpouse: unions.some((f) => [f.husband, f.wife].some((s) => s && s !== indi.id)),
      hasChildren: unions.some((f) => f.children.length > 0),
      hasParents: indi.childOf.some((id) => {
        const f = dataset.families.get(id);
        return !!(f?.husband || f?.wife);
      }),
      private: !!indi.private,
      hasPrivateNote: hasPrivateNote(indi.raw),
      mediaXrefs: refs.filter((r) => r.xref).map((r) => r.xref!),
      mediaFiles: refs.map((r) => r.file.toLowerCase()),
      mediaCount: refs.length,
    });
  }
  return rows;
}

/** Cross-cutting lookups the rows can't carry themselves. */
export interface BatchContext {
  /** Maternal/paternal classification relative to the home person, or null
   *  when no home person is set (a `line` criterion then matches nobody). */
  lineSides: Map<string, LineSide> | null;
  /** Blood-line sets relative to the start person, or null when no start
   *  person is set (a `kinship` criterion then matches nobody). */
  kinship: KinshipSets | null;
  /** The person's whole record as folded text, built on first ask (see
   *  `fullTextLookup`) — only an `anyField` criterion reads it. */
  fullText: (id: string) => string;
}

/** Blood-line classification of the whole file relative to the start person. */
export interface KinshipSets {
  /** Transitive parents of the start person. */
  ancestors: Set<string>;
  /** Transitive children of the start person. */
  descendants: Set<string>;
  /** The start person, their ancestors, and every descendant of an ancestor
   *  (siblings, cousins, …) — everyone related by blood, not by marriage. */
  blood: Set<string>;
}

/** Compute {@link KinshipSets} for a start person, or null if they're unknown. */
export function computeKinship(ds: Dataset, startId: string): KinshipSets | null {
  if (!ds.individuals.has(startId)) return null;
  // Blood lines run through birth families only: an adoptive or foster
  // family (by its PEDI) makes no one an ancestor.
  const parentsOf = (id: string): string[] => {
    const indi = ds.individuals.get(id);
    const out: string[] = [];
    for (const fam of indi ? birthParentFamilies(indi, ds) : []) {
      if (fam.husband) out.push(fam.husband);
      if (fam.wife) out.push(fam.wife);
    }
    return out;
  };
  const childrenOf = (id: string): string[] => {
    const out: string[] = [];
    for (const famId of ds.individuals.get(id)?.spouseOf ?? []) {
      const fam = ds.families.get(famId);
      if (fam) out.push(...fam.children);
    }
    return out;
  };
  const sweep = (seeds: string[], next: (id: string) => string[]): Set<string> => {
    const seen = new Set(seeds);
    const queue = [...seeds];
    for (let head = 0; head < queue.length; head++) {
      for (const id of next(queue[head])) {
        if (!seen.has(id)) {
          seen.add(id);
          queue.push(id);
        }
      }
    }
    return seen;
  };
  const ancestors = sweep(parentsOf(startId), parentsOf);
  return {
    ancestors,
    descendants: sweep(childrenOf(startId), childrenOf),
    blood: sweep([startId, ...ancestors], childrenOf),
  };
}

/** Tags of a record's events that carry a source citation of their own. */
function citingEventTags(record: GedNode): string[] {
  return record.children.filter((ev) => ev.children.some((c) => c.tag === "SOUR")).map((ev) => ev.tag);
}

/** A date that only estimates the moment: about/calculated/estimated, before,
 *  after or between — the qualifiers a researcher writes when the record is
 *  missing. Periods (FROM/TO) and phrases are not estimates. */
export function isEstimatedDate(d: GedDate | undefined): boolean {
  if (d?.year === undefined) return false;
  return d.qualifier === "about" || d.qualifier === "before" || d.qualifier === "after" || d.qualifier === "between";
}

/** Whether one specific image (by shared xref and/or file) is in the row's tray. */
function hasMedia(row: BatchRow, xref?: string, file?: string): boolean {
  if (xref && row.mediaXrefs.includes(xref)) return true;
  if (file && row.mediaFiles.includes(file.toLowerCase())) return true;
  return false;
}

/** An event's name (`TYPE`) and line value, folded for matching. */
function eventText(e: { type?: string; value?: string }): string {
  return foldSearch([e.type, e.value].filter(Boolean).join(" "));
}

/** A criterion's optional text as folded search terms — every one must appear. */
function textTerms(text: string | undefined): string[] {
  return foldSearch(text ?? "").split(/\s+/).filter(Boolean);
}

/** True when the person passes every criterion (empty list matches everyone). */
export function matchesBatch(row: BatchRow, criteria: BatchCriterion[], ctx: BatchContext): boolean {
  for (const c of criteria) {
    switch (c.kind) {
      case "name": {
        const hay =
          c.part === "given" ? row.givenText : c.part === "surname" ? row.surnameText : row.searchText;
        const terms = foldSearch(c.text).split(/\s+/).filter(Boolean);
        if (!terms.every((t) => hay.includes(t))) return false;
        break;
      }
      case "nameField": {
        const has =
          c.field === "given" ? row.hasGiven : c.field === "surname" ? row.hasSurname : row.hasMarriedName;
        if (c.mode === "has" ? !has : has) return false;
        break;
      }
      case "sex":
        if (row.sex !== c.value) return false;
        break;
      case "birthYear":
        if (row.birthYear === undefined) return false;
        if (c.from !== undefined && row.birthYear < c.from) return false;
        if (c.to !== undefined && row.birthYear > c.to) return false;
        break;
      case "age":
        if (row.age === undefined) return false;
        if (c.op === "lt" ? row.age >= c.years : row.age < c.years) return false;
        break;
      case "living":
        if (row.deceased === c.value) return false;
        break;
      case "event": {
        const terms = textTerms(c.text);
        const has = row.events.some(
          (e) =>
            (c.tag === ANY_VENDOR_EVENT ? isNonStandardTag(e.tag) : e.tag === c.tag) &&
            terms.every((t) => e.text.includes(t)),
        );
        if (c.mode === "has" ? !has : has) return false;
        break;
      }
      case "deathCause": {
        const terms = textTerms(c.text);
        const has = row.deathCause !== "" && terms.every((t) => row.deathCause.includes(t));
        if (c.mode === "has" ? !has : has) return false;
        break;
      }
      case "familyEvent": {
        const terms = textTerms(c.text);
        const of = (events: BatchRow["unionEvents"][number]) =>
          events.filter(
            (e) => (c.tag === ANY_EVENT || e.tag === c.tag) && terms.every((t) => e.text.includes(t)),
          );
        if (c.mode === "undated" || c.mode === "estimated") {
          const ok = c.mode === "undated"
            ? row.unionEvents.some((u) => of(u).length > 0 && !of(u).some((e) => e.dated))
            : row.unionEvents.some((u) => of(u).some((e) => e.estimated));
          if (!ok) return false;
          break;
        }
        const has = row.unionEvents.some((u) => of(u).length > 0);
        if (c.mode === "has" ? !has : has) return false;
        break;
      }
      case "relation": {
        const has =
          c.rel === "spouse" ? row.hasSpouse : c.rel === "children" ? row.hasChildren : row.hasParents;
        if (c.mode === "has" ? !has : has) return false;
        break;
      }
      case "kinship": {
        const k = ctx.kinship;
        if (!k) return false;
        const ok =
          c.rel === "ancestor" ? k.ancestors.has(row.id)
          : c.rel === "descendant" ? k.descendants.has(row.id)
          : c.rel === "blood" ? k.blood.has(row.id)
          : !k.blood.has(row.id);
        if (!ok) return false;
        break;
      }
      case "place":
        if (!row.placeText.includes(foldSearch(c.text))) return false;
        break;
      case "note":
        if (!row.noteText.includes(foldSearch(c.text))) return false;
        break;
      case "anyField":
        if (!matchesTerms(ctx.fullText(row.id), queryTerms(c.text))) return false;
        break;
      case "private":
        if (row.private !== c.value) return false;
        break;
      case "privateNote":
        if (c.mode === "has" ? !row.hasPrivateNote : row.hasPrivateNote) return false;
        break;
      case "media":
        if (c.mode === "none" && row.mediaCount > 0) return false;
        if (c.mode === "any" && row.mediaCount === 0) return false;
        if (c.mode === "has" && !hasMedia(row, c.xref, c.file)) return false;
        if (c.mode === "lacks" && hasMedia(row, c.xref, c.file)) return false;
        break;
      case "sources":
        if (c.mode === "eventHas" || c.mode === "eventLacks") {
          const has = !!c.tag && row.sourcedEventTags.includes(c.tag);
          if (c.mode === "eventHas" ? !has : has) return false;
        } else if (c.mode === "none" ? row.hasSources : !row.hasSources) return false;
        break;
      case "line":
        if (ctx.lineSides?.get(row.id) !== c.side) return false;
        break;
    }
  }
  return true;
}

// ── Maternal/paternal line classification ───────────────────────────────────

/** Relationship-graph distances from `startId`, never stepping through `excludeId`. */
function relationDistances(ds: Dataset, startId: string, excludeId: string): Map<string, number> {
  const dist = new Map<string, number>([[startId, 0]]);
  let frontier = [startId];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      const d = dist.get(id)!;
      const indi = ds.individuals.get(id);
      if (!indi) continue;
      const visit = (nid: string | undefined) => {
        if (!nid || nid === excludeId || dist.has(nid)) return;
        dist.set(nid, d + 1);
        next.push(nid);
      };
      for (const famId of indi.childOf) {
        const fam = ds.families.get(famId);
        if (!fam) continue;
        visit(fam.husband);
        visit(fam.wife);
        for (const cid of fam.children) visit(cid);
      }
      for (const famId of indi.spouseOf) {
        const fam = ds.families.get(famId);
        if (!fam) continue;
        visit(fam.husband);
        visit(fam.wife);
        for (const cid of fam.children) visit(cid);
      }
    }
    frontier = next;
  }
  return dist;
}

/**
 * Classify every relative of the home person as maternal- or paternal-line:
 * the side whose parent reaches them strictly sooner in a BFS over the
 * relationship graph that never steps through the home person (so "via the
 * mother" can't sneak back around through home). People reachable from both
 * parents at the same distance (full siblings, own descendants married in)
 * and people connected only through home (spouse, descendants) are on
 * neither line and get no entry. Returns null when home or both parents
 * are unknown.
 */
export function computeLineSides(ds: Dataset, homeId: string): Map<string, LineSide> | null {
  const home = ds.individuals.get(homeId);
  if (!home) return null;
  let father: string | undefined;
  let mother: string | undefined;
  for (const famId of home.childOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    father ??= fam.husband;
    mother ??= fam.wife;
  }
  if (!father && !mother) return null;
  const fromMother = mother ? relationDistances(ds, mother, homeId) : new Map<string, number>();
  const fromFather = father ? relationDistances(ds, father, homeId) : new Map<string, number>();
  const sides = new Map<string, LineSide>();
  const seen = new Set([...fromMother.keys(), ...fromFather.keys()]);
  for (const id of seen) {
    if (id === homeId) continue;
    const m = fromMother.get(id);
    const f = fromFather.get(id);
    if (m !== undefined && (f === undefined || m < f)) sides.set(id, "maternal");
    else if (f !== undefined && (m === undefined || f < m)) sides.set(id, "paternal");
  }
  return sides;
}

// ── Actions ─────────────────────────────────────────────────────────────────

/** One mass action, applied to every selected person. */
export type BatchActionSpec =
  /** Attach an image: an existing one (`xref` and/or `file`) or a new one
   *  (`file` with no matching record — created in the file's media style).
   *  People who already carry this image are skipped. */
  | { kind: "addMedia"; xref?: string; file: string; title?: string }
  /** Cite a source on the person record: an existing `SOUR` record (`xref`) or
   *  a new one created from `title`. People already citing it are skipped. */
  | { kind: "addSource"; xref?: string; title?: string; page?: string }
  /** Remove every reference to one image (by xref and/or file) from the person
   *  record and its events. The shared media record itself is kept. */
  | { kind: "removeMedia"; xref?: string; file?: string }
  /** Add an undated death (`1 DEAT Y` — death asserted, no details). People
   *  already carrying death evidence (death/burial/cremation) are skipped. */
  | { kind: "markDeceased" }
  /** Write an estimated birth year as `BIRT` → `DATE ABT <year>` (rounded to
   *  the nearest 5, so estimates read as the rough guesses they are), derived
   *  from dated immediate relatives (see {@link estimateBirthYear} — the same
   *  estimate the privacy check explains). Undated siblings anchor on the
   *  nearest dated sibling in the family's child order, `SIBLING_STEP` per
   *  position, rounded the same way (see the sibling pass in
   *  `previewBirthEstimates`). People with any dated birth/baptism event, and people with no dated
   *  close relative, are skipped. Estimates are computed before anything is
   *  written, so one run never chains an estimate off another — re-running
   *  reaches one relative-hop further. */
  | { kind: "estimateBirth" }
  /** Record each person's married surnames, taken from their partners: every
   *  union contributes its partner's surname, in marriage order, skipping the
   *  person's own surname and any they carry already. Written in the file's own
   *  convention — a separate `TYPE married` name per union, or one comma-joined
   *  inline `_MARNM`, whichever the file uses (see {@link inferNameVariants});
   *  a file with neither gets the standard record form. People whose partners
   *  contribute nothing new are skipped. The action writes what is selected:
   *  whether a union looks like a marriage ({@link unionMarriage}) decides only
   *  which rows the panel leaves unchecked. */
  | { kind: "addMarriedName" }
  /** Date each recorded but undated marriage of the selected people with the strongest
   *  estimate the family supports — `BEF` the oldest exactly dated child, else
   *  `ABT` from an estimated child or from the spouses' births (see
   *  {@link previewMarriageEstimates}). A family is written once even when
   *  both partners are selected. */
  | { kind: "estimateMarriage" }
  /** Re-tag every `fromTag` event to `toTag`, keeping the whole substructure
   *  (dates, places, sources). The line value stays where the target holds
   *  one (`carriesLineValue`) and becomes a note where it does not. When the
   *  target is a generic `EVEN`/`FACT`, `type` writes its `TYPE` name (unless
   *  one exists already). People without a `fromTag` event are skipped. */
  | { kind: "convertEvent"; fromTag: string; toTag: string; type?: string };

export const BATCH_ACTION_KINDS: BatchActionSpec["kind"][] = [
  "addMedia", "addSource", "removeMedia", "markDeceased", "estimateBirth", "estimateMarriage", "addMarriedName", "convertEvent",
];

export interface BatchApplyResult {
  /** Undo-stack patches for every record the action changed or created. */
  patches: RecordPatch[];
  /** People actually modified. */
  changed: number;
  /** People skipped because the action would be a no-op for them. */
  skipped: number;
}

/**
 * Apply one batch action to the given individuals, mutating the dataset in
 * place (the app's tool convention) and returning the patches for one undo
 * entry. No-op targets are skipped, so re-running an action never duplicates
 * media links or citations.
 */
export function applyBatchAction(
  ds: Dataset,
  ids: string[],
  action: BatchActionSpec,
  /** The version new lines are written in — the target's. */
  version: "5.5.1" | "7.0",
  /** The target's format choices: a strict target writes a married name as a
   *  name of its own, whatever the file's habit. */
  overrides?: FormatOverrides,
): BatchApplyResult {
  switch (action.kind) {
    case "addMedia":
      return addMediaBatch(ds, ids, action, version);
    case "addSource":
      return addSourceBatch(ds, ids, action);
    case "removeMedia":
      return removeMediaBatch(ds, ids, action);
    case "markDeceased":
      return markDeceasedBatch(ds, ids);
    case "estimateBirth":
      return estimateBirthBatch(ds, ids);
    case "estimateMarriage":
      return estimateMarriageBatch(ds, ids);
    case "addMarriedName":
      return addMarriedNameBatch(ds, ids, version, overrides);
    case "convertEvent":
      return convertEventBatch(ds, ids, action, version);
  }
}

/** Re-tag `fromTag` events to `toTag` (see the {@link BatchActionSpec} member). */
function convertEventBatch(
  ds: Dataset,
  ids: string[],
  action: { fromTag: string; toTag: string; type?: string },
  version: "5.5.1" | "7.0",
): BatchApplyResult {
  const { fromTag, toTag } = action;
  if (!fromTag || !toTag || fromTag === toTag) return { patches: [], changed: 0, skipped: ids.length };
  // Where the target tag may stand. A vendor tag can sit on people and on
  // families alike, but the standard tag it becomes belongs to one of them:
  // an occupation written onto a family is a line out of place. An extension
  // is no one's to refuse.
  const fits = (record: "INDI" | "FAM") => toTag.startsWith("_") || allowsChild(version, [record], toTag);
  const onPeople = fits("INDI");
  const onFamilies = fits("FAM");
  // A family event (`SEPA`) is the couple's: converted in every union a
  // picked person is a partner in, each union once.
  const famIds = [...new Set(ids.flatMap((id) => ds.individuals.get(id)?.spouseOf ?? []))];
  const snap = snapshotRecords(ds, ids, famIds);
  const type = action.type?.trim();
  const convert = (node: GedNode) => {
    node.tag = toTag;
    if (type && (toTag === "EVEN" || toTag === "FACT") && !node.children.some((c) => c.tag === "TYPE")) {
      node.children.unshift({ level: node.level + 1, tag: "TYPE", value: type, children: [] });
    }
    // A target with no line value of its own (a burial) cannot hold the
    // text the old tag carried there (`1 _INTE Žale`), so it becomes the
    // event's note instead of being lost. The bare `Y` flag says only that
    // the event happened, which the event now says by itself.
    const value = node.value?.trim();
    if (value && !carriesLineValue(toTag)) {
      if (!isOccurrenceFlag(value)) {
        insertOrdered(node, { level: node.level + 1, tag: "NOTE", value, children: [] }, EVENT_CHILD_ORDER);
      }
      node.value = undefined;
    }
    markEventTouched(node, "changed");
  };
  const doneFams = new Set<string>();
  let changed = 0;
  let skipped = 0;
  for (const id of ids) {
    const indi = ds.individuals.get(id);
    if (!indi) continue;
    const nodes = onPeople ? childrenByTag(indi.raw, fromTag) : [];
    let touched = nodes.length > 0;
    nodes.forEach(convert);
    // The typed record must follow the raw tree, or the panel's own filters
    // (`event has _FNRL`) still find the person after the conversion.
    if (nodes.length) rebuildIndividual(ds, indi);
    for (const famId of indi.spouseOf) {
      // Already converted from the partner's side: still this person's change.
      if (doneFams.has(famId)) { touched = true; continue; }
      const fam = ds.families.get(famId);
      if (!fam) continue;
      const famNodes = onFamilies ? childrenByTag(fam.raw, fromTag) : [];
      if (famNodes.length === 0) continue;
      touched = true;
      doneFams.add(famId);
      famNodes.forEach(convert);
      rebuildFamily(ds, fam);
    }
    if (touched) changed++;
    else skipped++;
  }
  return { patches: changed > 0 ? patchesFromSnapshots(ds, snap) : [], changed, skipped };
}

/** Add `1 DEAT Y` in canonical position to everyone without death evidence;
 *  the already-deceased are skipped, so re-running is a no-op. */
function markDeceasedBatch(ds: Dataset, ids: string[]): BatchApplyResult {
  const snap = snapshotRecords(ds, ids, []);
  let changed = 0;
  let skipped = 0;
  for (const id of ids) {
    const indi = ds.individuals.get(id);
    if (!indi) continue;
    if (indi.raw.children.some((c) => (DEATH_TAGS as readonly string[]).includes(c.tag))) {
      skipped++;
      continue;
    }
    addEventNode(indi, "DEAT");
    const deat = childrenByTag(indi.raw, "DEAT").pop()!;
    deat.value = "Y";
    // Rebuild, or `isDeceased` (and so the `living` filter) still says alive.
    rebuildIndividual(ds, indi);
    changed++;
  }
  return { patches: changed > 0 ? patchesFromSnapshots(ds, snap) : [], changed, skipped };
}

// The estimates themselves are shared with the health check's row fixes.
export { previewBirthEstimates, previewBirthEstimateDates, previewMarriageEstimates } from "./estimates";

/** Write `BIRT` → `DATE ABT <estimated year>` for everyone without any dated
 *  birth-proxy event (see the {@link BatchActionSpec} member). All estimates
 *  are derived from the pre-run state first, then written — no chaining. */
function estimateBirthBatch(ds: Dataset, ids: string[]): BatchApplyResult {
  const estimates = previewBirthEstimateDates(ds, ids);
  const skipped = ids.filter((id) => ds.individuals.has(id) && !estimates.has(id)).length;
  const snap = snapshotRecords(ds, [...estimates.keys()], []);
  for (const [id, date] of estimates) {
    const indi = ds.individuals.get(id)!;
    setEventField(indi, "BIRT", { date });
    rebuildIndividual(ds, indi);
  }
  return {
    patches: estimates.size > 0 ? patchesFromSnapshots(ds, snap) : [],
    changed: estimates.size,
    skipped,
  };
}

/** Write the marriage estimates (see {@link previewMarriageEstimates}). A
 *  person counts as changed when any of their unions was written. */
function estimateMarriageBatch(ds: Dataset, ids: string[]): BatchApplyResult {
  const estimates = previewMarriageEstimates(ds, ids);
  const snap = snapshotRecords(ds, [], estimates.keys());
  for (const [famId, date] of estimates) {
    const fam = ds.families.get(famId)!;
    setFamilyEventField(fam, "MARR", { date });
    rebuildFamily(ds, fam);
  }
  const present = ids.filter((id) => ds.individuals.has(id));
  const changed = present.filter((id) => ds.individuals.get(id)!.spouseOf.some((f) => estimates.has(f))).length;
  return {
    patches: estimates.size > 0 ? patchesFromSnapshots(ds, snap) : [],
    changed,
    skipped: present.length - changed,
  };
}

// How married a union looks lives with the GEDCOM model (the Relatives panel
// reads it too); re-exported for this module's own users.
export { unionMarriage, type UnionMarriage } from "../gedcom/union";

/**
 * The children's-surname reading of an otherwise undocumented union: a child
 * carrying the father's surname says the couple were treated as married, while
 * children carrying only the mother's are the classic record of a birth out of
 * wedlock. Returns `unknown` unless the children speak clearly.
 *
 * This leans on the patrilineal convention — true of the parish-register
 * material these files come from, not of naming everywhere — so it is only
 * ever consulted where {@link unionMarriage} found nothing recorded.
 */
export function unionMarriageByChildren(ds: Dataset, fam: Family): UnionMarriage {
  const father = fam.husband ? ds.individuals.get(fam.husband) : undefined;
  const mother = fam.wife ? ds.individuals.get(fam.wife) : undefined;
  const fatherName = father?.names[0]?.surname?.trim().toLowerCase();
  const motherName = mother?.names[0]?.surname?.trim().toLowerCase();
  if (!fatherName || !motherName || fatherName === motherName) return "unknown";
  let mothers = false;
  for (const cid of fam.children) {
    const surname = ds.individuals.get(cid)?.names[0]?.surname?.trim().toLowerCase();
    if (!surname) continue;
    if (surname === fatherName) return "married";
    if (surname === motherName) mothers = true;
  }
  return mothers ? "unmarried" : "unknown";
}

/** One union's contribution to a person's married surnames. */
export interface MarriedNameSource {
  /** The partner's surname this union stands behind. */
  surname: string;
  /** The union's marriage evidence, the children's reading standing in where
   *  the file records none (see {@link unionMarriageByChildren}). */
  marriage: UnionMarriage;
  /** The verdict came from the children's surnames, not from anything the
   *  union records itself — a guess the panel labels as one. */
  byChildren: boolean;
  /** Already carried by the person — listed for the order and the preview, but
   *  never written again. */
  recorded: boolean;
}

/** A married surname the person already carries, split on the comma the
 *  `_MARNM` convention has to pack several unions into one sub-tag with. */
function recordedMarriedParts(indi: Individual): string[] {
  return marriedSurnamesOf(indi).flatMap((s) => s.split(",").map((p) => p.trim()).filter(Boolean));
}

/**
 * The married surnames the {@link BatchActionSpec} `addMarriedName` action
 * would leave a person carrying — one entry per union that stands behind one,
 * in marriage order ({@link familiesByMarriage}), each with the union's
 * marriage evidence so the panel can leave the doubtful ones unchecked. Names
 * the person already carries are listed too (`recorded`), so the preview reads
 * as the end state; people who would gain nothing get no entry at all. Pure
 * dry-run, shared with the panel's per-row preview.
 */
export function previewMarriedNames(ds: Dataset, ids: string[]): Map<string, MarriedNameSource[]> {
  const names = new Map<string, MarriedNameSource[]>();
  for (const id of ids) {
    const indi = ds.individuals.get(id);
    if (!indi) continue;
    const own = indi.names[0]?.surname?.trim().toLowerCase();
    // A recorded married name is the researcher's data — never rewritten, only
    // added to, so a second marriage still reaches a person who carries the
    // first husband's name already.
    const recorded = new Set(recordedMarriedParts(indi).map((s) => s.toLowerCase()));
    const seen = new Set<string>();
    const sources: MarriedNameSource[] = [];
    for (const fam of familiesByMarriage(ds, indi.spouseOf)) {
      if (fam.husband !== indi.id && fam.wife !== indi.id) continue;
      const otherId = fam.husband === indi.id ? fam.wife : fam.husband;
      const surname = otherId ? ds.individuals.get(otherId)?.names[0]?.surname?.trim() : undefined;
      // A partner sharing the person's own surname adds nothing — the display
      // rule that hides such a married name would hide this one too.
      if (!surname || surname.toLowerCase() === own || seen.has(surname.toLowerCase())) continue;
      seen.add(surname.toLowerCase());
      const status = unionMarriage(fam);
      const byChildren = status === "unknown" ? unionMarriageByChildren(ds, fam) : status;
      sources.push({
        surname,
        marriage: byChildren,
        byChildren: status === "unknown" && byChildren !== "unknown",
        recorded: recorded.has(surname.toLowerCase()),
      });
    }
    if (sources.some((s) => !s.recorded)) names.set(id, sources);
  }
  return names;
}

/** Why a married surname is doubtful: the union says the couple were partners
 *  (or never married), its children carry the mother's surname, or nothing in
 *  the file speaks of a marriage at all. */
export type MarriedNameDoubt = "partners" | "children" | "noMarriage";

/** The panel's reading of one person's {@link MarriedNameSource} list. */
export interface MarriedNameVerdict {
  /** Every married surname the person would end up with, in union order. */
  surnames: string[];
  /** The strongest doubt over the surnames that would be *added*, else null. */
  doubt: MarriedNameDoubt | null;
  /** A recorded marriage backs at least one of the added surnames — enough to
   *  leave the row checked, even when another union is doubtful. */
  evidenced: boolean;
}

export function readMarriedNames(sources: MarriedNameSource[]): MarriedNameVerdict {
  const pending = sources.filter((s) => !s.recorded);
  const doubt: MarriedNameDoubt | null =
    pending.some((s) => s.marriage === "unmarried" && !s.byChildren) ? "partners"
      : pending.some((s) => s.marriage === "unmarried") ? "children"
        : pending.some((s) => s.marriage === "unknown") ? "noMarriage"
          : null;
  return {
    surnames: sources.map((s) => s.surname),
    doubt,
    evidenced: pending.some((s) => s.marriage === "married"),
  };
}

/** Write every union's partner surname as a married name, in marriage order
 *  and in the file's own convention (see the {@link BatchActionSpec} member). */
function addMarriedNameBatch(ds: Dataset, ids: string[], version: "5.5.1" | "7.0", overrides?: FormatOverrides): BatchApplyResult {
  const names = previewMarriedNames(ds, ids);
  const skipped = ids.filter((id) => ds.individuals.has(id) && !names.has(id)).length;
  const snap = snapshotRecords(ds, [...names.keys()], []);
  // The file's habit, unless the target says otherwise: a strict target asks
  // for name records, and a file's `_MARNM` habit is then no reason to write
  // more of them for the health check to flag.
  const habit = inferNameVariants(ds).married;
  const target: typeof habit = overrides?.names === "records" && habit.form === "tag" ? { form: "record", type: "married" } : habit;
  for (const [id, sources] of names) {
    const indi = ds.individuals.get(id)!;
    if (target.form === "tag") {
      // One `_MARNM` sub-tag is all this convention has, so several unions
      // share it comma-joined — the way the app displays a set of them anyway.
      // Names answering no union (the researcher's own) keep the tail.
      const union = new Set(sources.map((s) => s.surname.toLowerCase()));
      const orphans = recordedMarriedParts(indi).filter((s) => !union.has(s.toLowerCase()));
      setMarriedName(indi, [...sources.map((s) => s.surname), ...orphans].join(", "));
    } else {
      for (const { surname, recorded } of sources) {
        if (recorded) continue;
        // The surname-only `1 NAME /Novak/` + `2 TYPE married` pair the standard
        // (and every file observed) uses — the given name stays on the primary.
        addAdditionalName(indi, target.form === "record" ? target.type! : "married", version);
        const added = childrenByTag(indi.raw, "NAME").length - 2;
        setAdditionalName(indi, added, { given: "", surname }, version);
      }
    }
    rebuildIndividual(ds, indi);
  }
  return { patches: names.size > 0 ? patchesFromSnapshots(ds, snap) : [], changed: names.size, skipped };
}

function addMediaBatch(
  ds: Dataset,
  ids: string[],
  action: { xref?: string; file: string; title?: string },
  version: "5.5.1" | "7.0",
): BatchApplyResult {
  const extra: RecordPatch[] = [];
  // Resolve the shared record to point at: the picked one, else one already
  // holding this file, else (in shared-mode files) a newly created record.
  let shared: GedNode | undefined =
    (action.xref && ds.records.find((r) => r.tag === "OBJE" && r.xref === action.xref)) ||
    findSharedMediaByFile(ds.records, action.file) ||
    undefined;
  if (!shared && detectMediaMode(ds.records, version) === "shared") {
    shared = createMediaRecord(ds.records, action.file, version, action.title);
    extra.push({ type: "record", id: shared.xref!, before: null, after: cloneNode(shared) });
  }
  const snap = snapshotRecords(ds, ids, []);
  let changed = 0;
  let skipped = 0;
  for (const id of ids) {
    const indi = ds.individuals.get(id);
    if (!indi) continue;
    const refs = collectMediaRefs(indi.raw, ds.records);
    const already =
      (shared?.xref && refs.some((r) => r.xref === shared.xref)) ||
      refs.some((r) => r.file.toLowerCase() === action.file.toLowerCase());
    if (already) {
      skipped++;
      continue;
    }
    if (shared?.xref) attachMediaPointer(indi.raw, shared.xref);
    else attachInlineMedia(indi.raw, action.file, action.title);
    changed++;
  }
  // A record created for an action that then changed nobody would be an
  // orphan — only keep it when at least one person now points at it.
  const patches = changed > 0 ? [...extra, ...patchesFromSnapshots(ds, snap)] : rollbackCreated(ds, extra);
  return { patches, changed, skipped };
}

function addSourceBatch(
  ds: Dataset,
  ids: string[],
  action: { xref?: string; title?: string; page?: string },
): BatchApplyResult {
  const extra: RecordPatch[] = [];
  let sourXref = action.xref;
  if (!sourXref || !ds.records.some((r) => r.tag === "SOUR" && r.xref === sourXref)) {
    const title = action.title?.trim();
    if (!title) return { patches: [], changed: 0, skipped: ids.length };
    const rec: GedNode = {
      level: 0,
      xref: nextXref(ds.records, "S"),
      tag: "SOUR",
      children: [{ level: 1, tag: "TITL", value: title, children: [] }],
    };
    insertRecord(ds.records, rec);
    bumpSourceCacheVersion(ds.records);
    sourXref = rec.xref!;
    extra.push({ type: "record", id: sourXref, before: null, after: cloneNode(rec) });
  }
  const snap = snapshotRecords(ds, ids, []);
  let changed = 0;
  let skipped = 0;
  const page = action.page?.trim();
  for (const id of ids) {
    const indi = ds.individuals.get(id);
    if (!indi) continue;
    const already = indi.raw.children.some((c) => c.tag === "SOUR" && c.value?.trim() === sourXref);
    if (already) {
      skipped++;
      continue;
    }
    const node: GedNode = { level: indi.raw.level + 1, tag: "SOUR", value: sourXref, children: [] };
    if (page) node.children.push({ level: node.level + 1, tag: "PAGE", value: page, children: [] });
    insertOrdered(indi.raw, node, INDI_CHILD_ORDER);
    changed++;
  }
  const patches = changed > 0 ? [...extra, ...patchesFromSnapshots(ds, snap)] : rollbackCreated(ds, extra);
  return { patches, changed, skipped };
}

function removeMediaBatch(
  ds: Dataset,
  ids: string[],
  action: { xref?: string; file?: string },
): BatchApplyResult {
  const file = action.file?.toLowerCase();
  // Resolve pointer targets so an inline `FILE` filter also matches pointers
  // to a shared record holding that file.
  const matchesTarget = (obje: GedNode): boolean => {
    const val = obje.value?.trim();
    if (val && isPointer(val)) {
      if (action.xref && val === action.xref) return true;
      if (!file) return false;
      const rec = objeNodesFor(ds.records).get(val);
      return firstChild(rec ?? obje, "FILE")?.value?.trim().toLowerCase() === file;
    }
    return !!file && firstChild(obje, "FILE")?.value?.trim().toLowerCase() === file;
  };
  const snap = snapshotRecords(ds, ids, []);
  let changed = 0;
  let skipped = 0;
  for (const id of ids) {
    const indi = ds.individuals.get(id);
    if (!indi) continue;
    let removed = 0;
    const strip = (container: GedNode) => {
      const before = container.children.length;
      container.children = container.children.filter((c) => c.tag !== "OBJE" || !matchesTarget(c));
      removed += before - container.children.length;
    };
    strip(indi.raw);
    for (const child of indi.raw.children) {
      if (child.tag !== "SOUR" && child.children.length > 0) strip(child);
    }
    if (removed > 0) changed++;
    else skipped++;
  }
  return { patches: patchesFromSnapshots(ds, snap), changed, skipped };
}

/** Undo a record creation that turned out to be unnecessary (no target changed). */
function rollbackCreated(ds: Dataset, created: RecordPatch[]): RecordPatch[] {
  if (created.length === 0) return [];
  removeRecordsByXref(ds.records, created.map((p) => p.id));
  bumpSourceCacheVersion(ds.records);
  clearObjeNodeCache(ds.records);
  return [];
}

// ── Saved filters ───────────────────────────────────────────────────────────

/** A user-named filter (with its action, when one was set) persisted across
 *  sessions, so a recurring chore is one click: load → review matches → apply. */
export interface SavedBatchFilter {
  id: string;
  name: string;
  criteria: BatchCriterion[];
  action?: BatchActionSpec;
}
