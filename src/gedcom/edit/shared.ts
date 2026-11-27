import { FAM_EVENT_TAG_ORDER, INDI_EVENT_TAG_ORDER, carriesLineValue, isOccurrenceFlag } from "../eventTags";
import { firstChild, removeChildren } from "../node";
import type { GedNode } from "../types";

/** Trailing links/media/note/sources block shared by every child-order list.
 *  `ASSO` leads it: the people a record or event names belong with its own
 *  content, ahead of the links and citations that document it. */
const ATTACHMENT_CHILD_ORDER = ["ASSO", "WWW", "URL", "_URL", "_WEBTAG", "OBJE", "NOTE", "SOUR"];

/** Canonical sub-tag order within an event (BIRT/DEAT/RESI/…) node. */
export const EVENT_CHILD_ORDER = [
  // A family event's spouses (`2 HUSB` / `3 AGE`) lead it, as the standard's
  // FAMILY_EVENT_DETAIL has them; the contact lines follow their address.
  // TEMP/STAT/FAMC are an LDS ordinance's: its temple beside its date, as the
  // standard lists them, and its status and sealed-to family after the rest.
  "HUSB", "WIFE",
  "TYPE", "DATE", "SDATE", "_SDATE", "TEMP", "PLAC", "ADDR", "PHON", "EMAIL", "FAX", "AGE", "AGNC", "CAUS", "STAT", "FAMC", ...ATTACHMENT_CHILD_ORDER,
];

/** Canonical order of the labelled lines under an event's `ADDR`. */
export const ADDR_CHILD_ORDER = ["CONT", "ADR1", "ADR2", "ADR3", "CITY", "STAE", "POST", "CTRY"];

/** Canonical order under an `AGE` line (7.0's free-text form of it). */
export const AGE_CHILD_ORDER = ["PHRASE"];

/** Canonical top-level field order within an INDI record. */
export const INDI_CHILD_ORDER = [
  "NAME", "SEX",
  ...INDI_EVENT_TAG_ORDER,
  "FAMC", "FAMS",
  ...ATTACHMENT_CHILD_ORDER,
];

/** Canonical top-level field order within a FAM record. */
export const FAM_CHILD_ORDER = [
  "HUSB", "WIFE", "CHIL",
  ...FAM_EVENT_TAG_ORDER,
  ...ATTACHMENT_CHILD_ORDER,
];

/** Canonical sub-tag order within an `ASSO` node. The two dialects name their
 *  role differently (`ROLE` in 7.0, `RELA` in 5.5.1) and only one of each pair
 *  is ever present; notes and citations close it, as they do everywhere else. */
export const ASSO_CHILD_ORDER = ["PHRASE", "TYPE", "ROLE", "RELA", "NOTE", "SNOTE", "SOUR"];

/** Canonical sub-tag order within a `NAME` node. */
export const NAME_CHILD_ORDER = ["NPFX", "GIVN", "NICK", "SPFX", "SURN", "_MARNM", "NSFX", "TYPE", "NOTE", "SOUR"];

/** Links attached to an event are plain `WWW` lines. */
export const EVENT_LINK_TAG = "WWW";

/**
 * Every tag whose line IS a link, wherever links are edited or merged —
 * record-level and event-level alike. One list on purpose: the editors used
 * to each keep their own subset, so a `_LINK` (or an event-level `URL`) showed
 * as a link but survived "remove", and committing then wrote a duplicate
 * `WWW` beside it. The builder's LINK_TAGS additionally includes `FILE` for
 * URL *detection*; it is deliberately absent here — FILE lines are media and
 * must never be swept by a link edit. `_WEBTAG` carries its URL on a child
 * line and is removed as a whole block.
 */
export const EDITABLE_LINK_TAGS = ["WWW", "URL", "_URL", "_LINK", "_WEBTAG"] as const;

/**
 * Flag an event node as added or modified, so save-time audit stamping
 * (`stampChanCrea`) writes CHAN/CREA onto exactly this event. "new" wins over
 * "changed": once an event is created in this session, later field edits to it
 * keep it marked "new" (it still warrants a CREA, not just a CHAN bump).
 */
export function markEventTouched(node: GedNode, kind: "new" | "changed"): void {
  if (node.auditStamp === "new") return;
  node.auditStamp = kind;
}

/** Clear every event-level audit mark on the record. Maintenance passes reuse
 *  edit helpers that call {@link markEventTouched}, but a mechanical change
 *  must not refresh event CHANs at save time — so the batch's marks are swept
 *  off the records it touched (see `applyToolPatches`). */
export function clearEventAuditStamps(record: GedNode): void {
  for (const c of record.children) {
    if (c.auditStamp !== undefined) c.auditStamp = undefined;
  }
}

/** Remove the *first* direct child with `tag` (single-valued fields). Distinct
 *  from node's `removeChildren`, which removes every match. */
export function removeChild(node: GedNode, tag: string): void {
  const i = node.children.findIndex((c) => c.tag === tag);
  if (i !== -1) node.children.splice(i, 1);
}

/**
 * Insert `child` among `parent.children` at the position implied by `order`.
 * Tags not listed in `order` are left where they are (new children with an
 * unlisted tag go last).
 */
export function insertOrdered(parent: GedNode, child: GedNode, order: string[]): void {
  const tagRank = order.indexOf(child.tag);
  if (tagRank === -1) {
    parent.children.push(child);
    return;
  }
  // A tag the record already carries joins its own group, right after the last
  // of them. The canonical order ranks tags against each other and says nothing
  // about two children sharing one — and in a record that opens with a vendor
  // tag the order does not know (`1 _UID` before `1 NAME`), the rank scan below
  // would otherwise splice the new child at index 0, ahead of its own kind: a
  // second NAME landing there becomes the *primary* name, and the editors that
  // address an additional name by position then write over the real one.
  const lastSame = parent.children.map((c) => c.tag).lastIndexOf(child.tag);
  if (lastSame !== -1) {
    parent.children.splice(lastSame + 1, 0, child);
    return;
  }
  const rank = (tag: string) => {
    const i = order.indexOf(tag);
    return i === -1 ? Infinity : i;
  };
  const insertAt = parent.children.findIndex((c) => rank(c.tag) > tagRank);
  if (insertAt === -1) parent.children.push(child);
  else parent.children.splice(insertAt, 0, child);
}

/**
 * Insert `child` right after the last same-tag sibling — keeping e.g. a new
 * page `OBJE` grouped with the existing ones — else at the end but ahead of
 * the record's *trailing* run of `beforeTags` children (REPO, CHAN/CREA
 * bookkeeping). Only a run at the very end counts: a vendor record that puts
 * REPO first ("1 REPO / 1 TITL …") still gets the child appended after its
 * descriptive fields, not spliced to index 0. Unlike `insertOrdered` this is
 * safe on records with vendor tags in arbitrary positions: it never reorders
 * what's already there.
 */
export function insertGrouped(parent: GedNode, child: GedNode, beforeTags: readonly string[]): void {
  for (let i = parent.children.length - 1; i >= 0; i--) {
    if (parent.children[i].tag === child.tag) {
      parent.children.splice(i + 1, 0, child);
      return;
    }
  }
  let insertAt = parent.children.length;
  while (insertAt > 0 && beforeTags.includes(parent.children[insertAt - 1].tag)) insertAt--;
  parent.children.splice(insertAt, 0, child);
}

export function getOrCreateChild(node: GedNode, tag: string, order: string[]): GedNode {
  let child = firstChild(node, tag);
  if (!child) {
    child = { level: node.level + 1, tag, children: [] };
    insertOrdered(node, child, order);
  }
  return child;
}

/**
 * Set `node`'s `tag` child to `value`, or remove it when `value` is blank.
 * Treats `tag` as single-valued: collapses every matching child down to (at
 * most) one, so a leftover duplicate — e.g. left behind by a "both" merge
 * choice that appended an incoming NOTE alongside the existing one — can't
 * resurface as the field's value after the first one is edited or cleared.
 */
export function setOrRemoveValue(node: GedNode, tag: string, value: string, order: string[]): void {
  const trimmed = value.trim();
  if (!trimmed) {
    removeChildren(node, tag);
    return;
  }
  getOrCreateChild(node, tag, order).value = trimmed;
  let seenFirst = false;
  node.children = node.children.filter((c) => {
    if (c.tag !== tag) return true;
    if (!seenFirst) { seenFirst = true; return true; }
    return false;
  });
}

/**
 * Highest allocated `@<prefix><n>@` number per prefix, so `nextXref` doesn't
 * rescan every record per allocation (O(N) each on an index-scale file). The
 * cache only ever *over*estimates: removals (deletes, undo of a create) leave
 * gaps, which is safe — a fresh number is still unused. Insertions are covered
 * because they all funnel through `nextXref` itself or `insertRecord` (which
 * records the inserted xref below).
 */
const maxXrefCache = new WeakMap<GedNode[], Map<string, number>>();

function xrefCacheFor(records: GedNode[]): Map<string, number> {
  let maxes = maxXrefCache.get(records);
  if (!maxes) {
    maxes = new Map();
    maxXrefCache.set(records, maxes);
  }
  return maxes;
}

/** Keep the cached max in step with an xref inserted without `nextXref`
 *  (merge's gap-filling allocator, undo restoring a deleted record, a
 *  cleanup run transplanting records it created in a cloned forest). */
export function noteInsertedXref(records: GedNode[], xref: string | undefined): void {
  const m = xref?.match(/^@([A-Za-z]+)(\d+)@$/);
  if (!m) return;
  const maxes = maxXrefCache.get(records);
  if (!maxes) return; // no cache yet — the first nextXref scan will see it
  const cur = maxes.get(m[1]);
  if (cur !== undefined && parseInt(m[2], 10) > cur) maxes.set(m[1], parseInt(m[2], 10));
}

/**
 * Forget the cached maxima for a record list refilled wholesale — a normalize
 * run adopting the records it made in a cloned forest, a pass put back. The
 * cache knows only what went through `nextXref` or {@link noteInsertedXref},
 * and such a refill tells it nothing: the next id handed out was one a record
 * just adopted already carried, and the file got two records under it.
 */
export function forgetXrefCache(records: GedNode[]): void {
  maxXrefCache.delete(records);
}

/** Find the next unused `@<prefix><n>@` xref among the top-level records. */
export function nextXref(
  records: GedNode[],
  prefix: string,
  /** Xrefs promised elsewhere (e.g. to a pending shared-record import) that a
   *  fresh id must skip over even though no record carries them yet. */
  reserved?: ReadonlySet<string>,
): string {
  const maxes = xrefCacheFor(records);
  let max = maxes.get(prefix);
  if (max === undefined) {
    const re = new RegExp(`^@${prefix}(\\d+)@$`);
    max = 0;
    for (const r of records) {
      const m = r.xref?.match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  let next = max + 1;
  if (reserved) while (reserved.has(`@${prefix}${next}@`)) next++;
  maxes.set(prefix, next);
  return `@${prefix}${next}@`;
}

/** Append a new top-level record after the last existing record of the same
 * tag (so e.g. new `SOUR`/`OBJE` records stay grouped with the others rather
 * than scattering at the file's end), or just before `TRLR` (or at the very
 * end, if there's none) when no record of that tag exists yet. */
export function insertRecord(records: GedNode[], record: GedNode): void {
  noteInsertedXref(records, record.xref);
  let lastSameTag = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].tag === record.tag) { lastSameTag = i; break; }
  }
  if (lastSameTag !== -1) {
    records.splice(lastSameTag + 1, 0, record);
    return;
  }
  const trlrIndex = records.findIndex((r) => r.tag === "TRLR");
  if (trlrIndex === -1) records.push(record);
  else records.splice(trlrIndex, 0, record);
}

/**
 * {@link insertRecord} for many records at once, in one rebuild of the list:
 * each lands where inserting them one by one, in order, would put it — after
 * the last record of its tag, or before `TRLR` — without a splice per record,
 * which over a large file moves the whole list each time.
 */
export function insertRecords(records: GedNode[], added: readonly GedNode[]): void {
  if (!added.length) return;
  if (added.length === 1) return insertRecord(records, added[0]);
  for (const r of added) noteInsertedXref(records, r.xref);
  const lastOfTag = new Map<string, number>();
  records.forEach((r, i) => lastOfTag.set(r.tag, i));
  const trlr = records.findIndex((r) => r.tag === "TRLR");
  const end = trlr === -1 ? records.length - 1 : trlr - 1;
  // Records of a tag the list has none of go before TRLR, grouped by tag in
  // the order the tags first come — as each one after the first would follow
  // the first of its tag.
  const newTags = new Map<string, GedNode[]>();
  // Position each group goes after (-1: the very start), keyed by that index.
  const after = new Map<number, GedNode[]>();
  for (const r of added) {
    const at = lastOfTag.get(r.tag);
    if (at === undefined) {
      let group = newTags.get(r.tag);
      if (!group) newTags.set(r.tag, (group = []));
      group.push(r);
      continue;
    }
    let group = after.get(at);
    if (!group) after.set(at, (group = []));
    group.push(r);
  }
  if (newTags.size) {
    const tail = after.get(end) ?? [];
    after.set(end, [...tail, ...[...newTags.values()].flat()]);
  }
  const out: GedNode[] = [];
  for (const r of after.get(-1) ?? []) out.push(r);
  records.forEach((r, i) => {
    out.push(r);
    for (const a of after.get(i) ?? []) out.push(a);
  });
  records.length = 0;
  for (const r of out) records.push(r);
}

const positionCaches = new WeakMap<GedNode[], WeakMap<GedNode, number>>();

/**
 * Where `node` sits in `records`: the position it was last found at, checked
 * by identity and searched for nearby when the records before it have moved by
 * a few (a chain of merges removing one record per step), else an identity
 * search of the list — native, far cheaper than a walk comparing xrefs.
 */
export function recordPosition(records: GedNode[], node: GedNode): number | undefined {
  let positions = positionCaches.get(records);
  if (!positions) positionCaches.set(records, (positions = new WeakMap()));
  const cached = positions.get(node);
  let i: number | undefined;
  if (cached !== undefined) {
    for (let d = 0; d <= 64 && i === undefined; d++) {
      if (records[cached - d] === node) i = cached - d;
      else if (records[cached + d] === node) i = cached + d;
    }
  }
  if (i === undefined) {
    const found = records.indexOf(node);
    if (found !== -1) i = found;
  }
  if (i !== undefined) positions.set(node, i);
  return i;
}

/**
 * Take records out of `records` in place, in one pass however many go: for
 * each xref listed, the first record carrying it (listed twice, the first
 * two), as a `findIndex` + `splice` per xref would — which over a large file
 * is a walk of the whole list per record removed. Returns the removed records
 * in file order.
 */
export function removeRecordsByXref(
  records: GedNode[],
  xrefs: Iterable<string>,
  /** Only records it accepts count (a tag filter); default every one. */
  accept?: (record: GedNode) => boolean,
): GedNode[] {
  const pending = new Map<string, number>();
  for (const x of xrefs) pending.set(x, (pending.get(x) ?? 0) + 1);
  const removed: GedNode[] = [];
  if (!pending.size) return removed;
  let w = 0;
  for (let r = 0; r < records.length; r++) {
    const rec = records[r];
    const left = rec.xref !== undefined ? pending.get(rec.xref) : undefined;
    if (left && (!accept || accept(rec))) {
      removed.push(rec);
      if (left > 1) pending.set(rec.xref!, left - 1);
      else pending.delete(rec.xref!);
      continue;
    }
    if (w !== r) records[w] = rec;
    w++;
  }
  records.length = w;
  return removed;
}

/** Re-insert a record at the position it held before a deletion (undo of a
 * delete), keeping the file's record order — and thus the minimal diff against
 * the original — intact. Falls back to {@link insertRecord}'s grouping when no
 * index is known, and never inserts past `TRLR`. */
export function insertRecordAt(
  records: GedNode[],
  record: GedNode,
  index: number | undefined,
  /** Where `TRLR` sits, carried between the inserts of one batch so each
   *  does not search the whole list for it again (-1: none; unset: unknown). */
  trlr?: { at?: number },
): void {
  if (index === undefined || index > records.length) {
    insertRecord(records, record);
    if (trlr) trlr.at = undefined;
    return;
  }
  noteInsertedXref(records, record.xref);
  const trlrIndex = trlr?.at ?? records.findIndex((r) => r.tag === "TRLR");
  const at = trlrIndex === -1 ? index : Math.min(index, trlrIndex);
  records.splice(at, 0, record);
  if (trlr) trlr.at = trlrIndex === -1 ? -1 : trlrIndex + 1;
}

/**
 * Re-tag an event line to `toTag`, keeping everything beneath it. A generic
 * `EVEN`/`FACT` target is named by `type` (unless the line has a `TYPE`
 * already). A target with no line value of its own (a burial) cannot hold the
 * text the old tag carried there (`1 _INTE Žale`), so that becomes the event's
 * note instead of being lost; the bare `Y` flag says only that the event
 * happened, which the event now says by itself.
 */
export function retagEvent(node: GedNode, toTag: string, type: string | undefined): void {
  node.tag = toTag;
  if (type && (toTag === "EVEN" || toTag === "FACT") && !node.children.some((c) => c.tag === "TYPE")) {
    node.children.unshift({ level: node.level + 1, tag: "TYPE", value: type, children: [] });
  }
  const value = node.value?.trim();
  if (value && !carriesLineValue(toTag)) {
    if (!isOccurrenceFlag(value)) {
      insertOrdered(node, { level: node.level + 1, tag: "NOTE", value, children: [] }, EVENT_CHILD_ORDER);
    }
    node.value = undefined;
  }
}
