import { EVENT_CHILD_ORDER, FAM_CHILD_ORDER, INDI_CHILD_ORDER, insertOrdered } from "./edit";
import { ALL_EVENT_TAGS, changeStampNode, isChangeStampEvent } from "./eventTags";
import { firstChild, hasChild } from "./node";
import type { ChanCreaUsage, GedNode } from "./types";
import { UPD_STAMP_TYPE } from "./vendorTags";

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

/**
 * Format the moment as a MyHeritage `_UPD` stamp: `10 AUG 2026 01:57:49 GMT
 * -0500`. The offset is this machine's, not the one the file happens to carry
 * — the stamp says when the edit actually happened, and every reader of the
 * field takes the zone from the value itself.
 */
export function nowUpdStamp(date: Date = new Date()): string {
  const minutesEast = -date.getTimezoneOffset();
  const pad = (n: number) => String(n).padStart(2, "0");
  const abs = Math.abs(minutesEast);
  const offset = `${minutesEast < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
  return `${todayGedcom(date)} ${nowGedcomTime(date)} GMT ${offset}`;
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

/**
 * Refresh the record's MyHeritage `_UPD` change stamp, adding one in the
 * file's own form when the record carries none yet. A record that already
 * stamps itself with the event spelling keeps it — only the timestamp moves,
 * so the file's shape survives the save it did not ask us to change.
 */
function upsertUpd(record: GedNode, stamp: string, form: "tag" | "event", order: string[]): void {
  const existing = changeStampNode(record);
  if (existing) {
    existing.value = stamp;
    return;
  }
  if (form === "event") {
    const even = makeNode(record.level + 1, "EVEN", stamp);
    even.children = [makeNode(even.level + 1, "TYPE", UPD_STAMP_TYPE)];
    insertOrdered(record, even, order);
    return;
  }
  insertOrdered(record, makeNode(record.level + 1, UPD_STAMP_TYPE, stamp), order);
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
 * - `usage`: which CHAN/CREA variants the main file already uses (detected
 *   on load) — only writes timestamps the main itself already employs.
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
 *
 * A file that stamps changes MyHeritage's way instead — `_UPD` rather than
 * CHAN — has that refreshed on the same records, in the same breath and by the
 * same rule, so one file never ends up with half its records claiming a
 * last-touched time from before this session. `updStamp` carries the value
 * (from `nowUpdStamp()`); the two conventions are independent, and a file
 * using both gets both.
 */
export function stampChanCrea(
  records: GedNode[],
  changedIds: Set<string>,
  newIds: Set<string>,
  usage: ChanCreaUsage,
  today: string,
  now: string,
  updStamp: string = nowUpdStamp(),
): void {
  if (!usage.recordChan && !usage.recordCrea && !usage.eventChan && !usage.eventCrea && !usage.recordUpd) return;

  for (const record of records) {
    const xref = record.xref;
    if (!xref || !changedIds.has(xref)) continue;
    if (record.tag !== "INDI" && record.tag !== "FAM") continue;

    const order = record.tag === "INDI" ? INDI_CHILD_ORDER : FAM_CHILD_ORDER;
    const isNew = newIds.has(xref);

    if (usage.recordChan) upsertChan(record, today, now, order);
    if (usage.recordCrea && isNew) insertCreaIfAbsent(record, today, now, order);
    if (usage.recordUpd) upsertUpd(record, updStamp, usage.recordUpd, order);

    if (usage.eventChan || usage.eventCrea) {
      for (const child of record.children) {
        // The `_UPD` event is the record's change stamp, already refreshed
        // above — stamping it as an event would date the bookkeeping twice.
        if (!ALL_EVENT_TAGS.has(child.tag) || isChangeStampEvent(child)) continue;
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
