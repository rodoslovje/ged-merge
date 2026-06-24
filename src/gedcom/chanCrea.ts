import { EVENT_CHILD_ORDER, FAM_CHILD_ORDER, INDI_CHILD_ORDER, insertOrdered } from "./edit";
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

function makeNode(level: number, tag: string, value?: string): GedNode {
  const n: GedNode = { level, tag, children: [] };
  if (value !== undefined) n.value = value;
  return n;
}

function upsertDateChild(parent: GedNode, today: string): void {
  const existing = parent.children.find((c) => c.tag === "DATE");
  if (existing) {
    existing.value = today;
  } else {
    parent.children.unshift(makeNode(parent.level + 1, "DATE", today));
  }
}

function upsertChan(record: GedNode, today: string, order: string[]): void {
  let chan = record.children.find((c) => c.tag === "CHAN");
  if (!chan) {
    chan = makeNode(record.level + 1, "CHAN");
    insertOrdered(record, chan, order);
  }
  upsertDateChild(chan, today);
}

function insertCreaIfAbsent(record: GedNode, today: string, order: string[]): void {
  if (record.children.some((c) => c.tag === "CREA")) return;
  const crea = makeNode(record.level + 1, "CREA");
  insertOrdered(record, crea, order);
  upsertDateChild(crea, today);
}

/**
 * Stamp CHAN/CREA audit timestamps onto changed records in place.
 *
 * - `changedIds`: xrefs of all records modified by this save (edits + merge).
 * - `newIds`: xrefs of brand-new records added during this merge (get CREA).
 * - `usage`: which CHAN/CREA variants the master file already uses (detected
 *   on load) — only writes timestamps the master itself already employs.
 * - `today`: GEDCOM-formatted date string (from `todayGedcom()`).
 *
 * Record-level: updates/adds CHAN on every changed record; adds CREA only to
 * wholly new records. Event-level: updates any existing CHAN on events inside
 * changed records; adds CHAN+CREA to every event on a wholly new record.
 */
export function stampChanCrea(
  records: GedNode[],
  changedIds: Set<string>,
  newIds: Set<string>,
  usage: ChanCreaUsage,
  today: string,
): void {
  if (!usage.recordChan && !usage.recordCrea && !usage.eventChan && !usage.eventCrea) return;

  for (const record of records) {
    const xref = record.xref;
    if (!xref || !changedIds.has(xref)) continue;
    if (record.tag !== "INDI" && record.tag !== "FAM") continue;

    const order = record.tag === "INDI" ? INDI_CHILD_ORDER : FAM_CHILD_ORDER;
    const isNew = newIds.has(xref);

    if (usage.recordChan) upsertChan(record, today, order);
    if (usage.recordCrea && isNew) insertCreaIfAbsent(record, today, order);

    if (usage.eventChan || usage.eventCrea) {
      for (const child of record.children) {
        if (!ALL_EVENT_TAGS.has(child.tag)) continue;
        if (usage.eventChan) {
          const existingChan = child.children.find((c) => c.tag === "CHAN");
          if (existingChan) {
            upsertDateChild(existingChan, today);
          } else if (isNew) {
            upsertChan(child, today, EVENT_CHILD_ORDER);
          }
        }
        if (usage.eventCrea && isNew) {
          insertCreaIfAbsent(child, today, EVENT_CHILD_ORDER);
        }
      }
    }
  }
}
