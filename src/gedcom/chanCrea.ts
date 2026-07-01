import { EVENT_CHILD_ORDER, FAM_CHILD_ORDER, INDI_CHILD_ORDER, insertOrdered } from "./edit";
import { firstChild, hasChild } from "./node";
import type { ChanCreaUsage, GedNode } from "./types";

const ALL_EVENT_TAGS = new Set([
  "BIRT", "DEAT", "BAPM", "CHR", "BURI", "CREM", "MARR", "RESI",
  "CONF", "ADOP", "FCOM",
  "OCCU", "EDUC", "RETI",
  "EMIG", "IMMI", "NATU", "CENS",
  "WILL", "PROB",
  "EVEN",
  "DIV", "ENGA", "SEPA", "MARB", "MARL",
]);

/** Format today's date as GEDCOM standard: `D MON YYYY` (e.g. `24 JUN 2026`). */
export function todayGedcom(date: Date = new Date()): string {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

/** Format the current time as GEDCOM standard: `HH:MM:SS` (e.g. `09:05:42`). */
export function nowGedcomTime(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function makeNode(level: number, tag: string, value?: string): GedNode {
  const n: GedNode = { level, tag, children: [] };
  if (value !== undefined) n.value = value;
  return n;
}

function upsertDateChild(parent: GedNode, today: string, now: string): void {
  let dateNode = firstChild(parent, "DATE");
  if (dateNode) {
    dateNode.value = today;
  } else {
    dateNode = makeNode(parent.level + 1, "DATE", today);
    parent.children.unshift(dateNode);
  }
  // Refresh a TIME stamp only when the record already carries one.
  const time = firstChild(dateNode, "TIME");
  if (time) time.value = now;
}

function upsertChan(record: GedNode, today: string, now: string, order: string[]): void {
  let chan = firstChild(record, "CHAN");
  if (!chan) {
    chan = makeNode(record.level + 1, "CHAN");
    insertOrdered(record, chan, order);
  }
  upsertDateChild(chan, today, now);
}

function insertCreaIfAbsent(record: GedNode, today: string, now: string, order: string[]): void {
  if (hasChild(record, "CREA")) return;
  const crea = makeNode(record.level + 1, "CREA");
  insertOrdered(record, crea, order);
  upsertDateChild(crea, today, now);
}

/**
 * Stamp CHAN/CREA audit timestamps onto changed records in place.
 *
 * - `changedIds`: xrefs of all records modified by this save (edits + merge).
 * - `newIds`: xrefs of brand-new records added during this merge (get CREA).
 * - `usage`: which CHAN/CREA variants the master file already uses (detected
 *   on load) — only writes timestamps the master itself already employs.
 * - `today`: GEDCOM-formatted date string (from `todayGedcom()`).
 * - `now`: GEDCOM-formatted time string (from `nowGedcomTime()`) — only written
 *   onto DATE nodes that already carry a TIME subordinate.
 *
 * Record-level: updates/adds CHAN on every changed record; adds CREA only to
 * wholly new records. Event-level: stamps only the events this save actually
 * touched — every event on a wholly new record, plus any event the edit/merge
 * flagged via `auditStamp` (`markEventTouched`). A modified event gets its CHAN
 * refreshed (added if absent); a newly added event also gets a CREA. Untouched
 * events are left exactly as they were. The marker is cleared as it's consumed.
 */
export function stampChanCrea(
  records: GedNode[],
  changedIds: Set<string>,
  newIds: Set<string>,
  usage: ChanCreaUsage,
  today: string,
  now: string,
): void {
  if (!usage.recordChan && !usage.recordCrea && !usage.eventChan && !usage.eventCrea) return;

  for (const record of records) {
    const xref = record.xref;
    if (!xref || !changedIds.has(xref)) continue;
    if (record.tag !== "INDI" && record.tag !== "FAM") continue;

    const order = record.tag === "INDI" ? INDI_CHILD_ORDER : FAM_CHILD_ORDER;
    const isNew = newIds.has(xref);

    if (usage.recordChan) upsertChan(record, today, now, order);
    if (usage.recordCrea && isNew) insertCreaIfAbsent(record, today, now, order);

    if (usage.eventChan || usage.eventCrea) {
      for (const child of record.children) {
        if (!ALL_EVENT_TAGS.has(child.tag)) continue;
        // A brand-new record's events are all new; otherwise rely on the marker
        // the edit/merge left on exactly the events it added or modified.
        const stamp = isNew ? "new" : child.auditStamp;
        child.auditStamp = undefined; // consume — keeps the live edit tree clean
        if (!stamp) continue;
        if (usage.eventChan) {
          const existingChan = firstChild(child, "CHAN");
          if (existingChan) upsertDateChild(existingChan, today, now);
          else upsertChan(child, today, now, EVENT_CHILD_ORDER);
        }
        if (usage.eventCrea && stamp === "new") {
          insertCreaIfAbsent(child, today, now, EVENT_CHILD_ORDER);
        }
      }
    }
  }
}
