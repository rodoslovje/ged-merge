import { FAM_EVENT_TAG_ORDER, INDI_EVENT_TAG_ORDER } from "../eventTags";
import { firstChild, removeChildren } from "../node";
import type { GedNode } from "../types";

/** Trailing links/media/note/sources block shared by every child-order list. */
const ATTACHMENT_CHILD_ORDER = ["WWW", "URL", "_URL", "_WEBTAG", "OBJE", "NOTE", "SOUR"];

/** Canonical sub-tag order within an event (BIRT/DEAT/RESI/…) node. */
export const EVENT_CHILD_ORDER = [
  "TYPE", "DATE", "PLAC", "ADDR", "AGE", "AGNC", "CAUS", ...ATTACHMENT_CHILD_ORDER,
];

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

/** Canonical sub-tag order within a `NAME` node. */
export const NAME_CHILD_ORDER = ["NPFX", "GIVN", "NICK", "SPFX", "SURN", "_MARNM", "NSFX", "TYPE", "NOTE", "SOUR"];

/** Links attached to an event are plain `WWW` lines. */
export const EVENT_LINK_TAG = "WWW";

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
 *  (merge's gap-filling allocator, undo restoring a deleted record). */
function noteInsertedXref(records: GedNode[], xref: string | undefined): void {
  const m = xref?.match(/^@([A-Za-z]+)(\d+)@$/);
  if (!m) return;
  const maxes = maxXrefCache.get(records);
  if (!maxes) return; // no cache yet — the first nextXref scan will see it
  const cur = maxes.get(m[1]);
  if (cur !== undefined && parseInt(m[2], 10) > cur) maxes.set(m[1], parseInt(m[2], 10));
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

/** Re-insert a record at the position it held before a deletion (undo of a
 * delete), keeping the file's record order — and thus the minimal diff against
 * the original — intact. Falls back to {@link insertRecord}'s grouping when no
 * index is known, and never inserts past `TRLR`. */
export function insertRecordAt(records: GedNode[], record: GedNode, index: number | undefined): void {
  if (index === undefined || index > records.length) {
    insertRecord(records, record);
    return;
  }
  noteInsertedXref(records, record.xref);
  const trlrIndex = records.findIndex((r) => r.tag === "TRLR");
  records.splice(trlrIndex === -1 ? index : Math.min(index, trlrIndex), 0, record);
}
