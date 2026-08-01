import type { Dataset, GedNode, Individual, Sex } from "../gedcom/types";
import { todayDate } from "../gedcom/age";
import { birthDateOf, deathDateOf, isDeceased } from "../gedcom/lifespan";
import { collectMediaRefs, detectMediaMode } from "../gedcom/media";
import { clearObjeNodeCache, isPointer } from "../gedcom/source";
import { bumpSourceCacheVersion } from "../gedcom/edit/cache";
import { firstChild } from "../gedcom/node";
import {
  attachInlineMedia,
  attachMediaPointer,
  createMediaRecord,
  findSharedMediaByFile,
} from "../gedcom/edit/media";
import { INDI_CHILD_ORDER, insertOrdered, insertRecord, nextXref } from "../gedcom/edit/shared";
import { buildSearchRows, foldSearch, type SearchRow } from "../ui/globalSearch";
import { cloneRaw, patchesFromSnapshots, snapshotRecords, type RecordPatch } from "../ui/historyTypes";

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
  | { kind: "name"; text: string }
  | { kind: "sex"; value: Sex }
  | { kind: "birthYear"; from?: number; to?: number }
  /** Age in whole years — at death for the deceased, to today for everyone
   *  else; people without the needed date never qualify. */
  | { kind: "age"; op: "lt" | "gte"; years: number }
  /** `true` selects people with no death evidence in the file, `false` the deceased. */
  | { kind: "living"; value: boolean }
  /** Presence of one event/attribute on the person, by its GEDCOM tag —
   *  `lacks BIRT` finds everyone without a birth record. */
  | { kind: "event"; tag: string; mode: "has" | "lacks" }
  /** Blood-line relationship to the start person (see {@link computeKinship}). */
  | { kind: "kinship"; rel: "ancestor" | "descendant" | "blood" | "notBlood" }
  | { kind: "place"; text: string }
  /** `none`/`any` look at the person's whole media tray; `has`/`lacks` test one
   *  specific image, identified by shared-record xref and/or `FILE` value. */
  | { kind: "media"; mode: "none" | "any" | "has" | "lacks"; xref?: string; file?: string }
  | { kind: "sources"; mode: "none" | "any" }
  | { kind: "line"; side: LineSide };

/** Every criterion kind, for the panel's "add filter" picker. */
export const BATCH_CRITERION_KINDS: BatchCriterion["kind"][] = [
  "name", "sex", "birthYear", "age", "living", "event", "place", "media", "sources", "kinship", "line",
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
  return buildSearchRows(dataset.individuals, nameOf).map((row) => {
    const indi = dataset.individuals.get(row.id)!;
    const refs = collectMediaRefs(indi.raw, dataset.records);
    const d = deathDateOf(indi);
    return {
      ...row,
      deathYear: d?.year,
      age: ageOf(indi, now),
      deceased: isDeceased(indi),
      eventTags: indi.events.map((e) => e.tag),
      mediaXrefs: refs.filter((r) => r.xref).map((r) => r.xref!),
      mediaFiles: refs.map((r) => r.file.toLowerCase()),
      mediaCount: refs.length,
    };
  });
}

/** Cross-cutting lookups the rows can't carry themselves. */
export interface BatchContext {
  /** Maternal/paternal classification relative to the home person, or null
   *  when no home person is set (a `line` criterion then matches nobody). */
  lineSides: Map<string, LineSide> | null;
  /** Blood-line sets relative to the start person, or null when no start
   *  person is set (a `kinship` criterion then matches nobody). */
  kinship: KinshipSets | null;
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
  const parentsOf = (id: string): string[] => {
    const out: string[] = [];
    for (const famId of ds.individuals.get(id)?.childOf ?? []) {
      const fam = ds.families.get(famId);
      if (!fam) continue;
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

/** Whether one specific image (by shared xref and/or file) is in the row's tray. */
function hasMedia(row: BatchRow, xref?: string, file?: string): boolean {
  if (xref && row.mediaXrefs.includes(xref)) return true;
  if (file && row.mediaFiles.includes(file.toLowerCase())) return true;
  return false;
}

/** True when the person passes every criterion (empty list matches everyone). */
export function matchesBatch(row: BatchRow, criteria: BatchCriterion[], ctx: BatchContext): boolean {
  for (const c of criteria) {
    switch (c.kind) {
      case "name": {
        const terms = foldSearch(c.text).split(/\s+/).filter(Boolean);
        if (!terms.every((t) => row.searchText.includes(t))) return false;
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
      case "event":
        if (c.mode === "has" ? !row.eventTags.includes(c.tag) : row.eventTags.includes(c.tag)) return false;
        break;
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
      case "media":
        if (c.mode === "none" && row.mediaCount > 0) return false;
        if (c.mode === "any" && row.mediaCount === 0) return false;
        if (c.mode === "has" && !hasMedia(row, c.xref, c.file)) return false;
        if (c.mode === "lacks" && hasMedia(row, c.xref, c.file)) return false;
        break;
      case "sources":
        if (c.mode === "none" ? row.hasSources : !row.hasSources) return false;
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
  | { kind: "removeMedia"; xref?: string; file?: string };

export const BATCH_ACTION_KINDS: BatchActionSpec["kind"][] = ["addMedia", "addSource", "removeMedia"];

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
export function applyBatchAction(ds: Dataset, ids: string[], action: BatchActionSpec): BatchApplyResult {
  switch (action.kind) {
    case "addMedia":
      return addMediaBatch(ds, ids, action);
    case "addSource":
      return addSourceBatch(ds, ids, action);
    case "removeMedia":
      return removeMediaBatch(ds, ids, action);
  }
}

function addMediaBatch(
  ds: Dataset,
  ids: string[],
  action: { xref?: string; file: string; title?: string },
): BatchApplyResult {
  const extra: RecordPatch[] = [];
  // Resolve the shared record to point at: the picked one, else one already
  // holding this file, else (in shared-mode files) a newly created record.
  let shared: GedNode | undefined =
    (action.xref && ds.records.find((r) => r.tag === "OBJE" && r.xref === action.xref)) ||
    findSharedMediaByFile(ds.records, action.file) ||
    undefined;
  if (!shared && detectMediaMode(ds.records) === "shared") {
    shared = createMediaRecord(ds.records, action.file, action.title);
    extra.push({ type: "record", id: shared.xref!, before: null, after: cloneRaw(shared) });
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
    extra.push({ type: "record", id: sourXref, before: null, after: cloneRaw(rec) });
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
      const rec = ds.records.find((r) => r.tag === "OBJE" && r.xref === val);
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
  for (const p of created) {
    const i = ds.records.findIndex((r) => r.xref === p.id);
    if (i !== -1) ds.records.splice(i, 1);
  }
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
