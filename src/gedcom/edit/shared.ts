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

/** Find the next unused `@<prefix><n>@` xref among the top-level records. */
export function nextXref(records: GedNode[], prefix: string): string {
  const re = new RegExp(`^@${prefix}(\\d+)@$`);
  let max = 0;
  for (const r of records) {
    const m = r.xref?.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `@${prefix}${max + 1}@`;
}

/** Append a new top-level record after the last existing record of the same
 * tag (so e.g. new `SOUR`/`OBJE` records stay grouped with the others rather
 * than scattering at the file's end), or just before `TRLR` (or at the very
 * end, if there's none) when no record of that tag exists yet. */
export function insertRecord(records: GedNode[], record: GedNode): void {
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
