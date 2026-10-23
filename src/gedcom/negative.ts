import { parseDateNode } from "./phrase";
import { firstChild } from "./node";
import type { GedcomVersion, GedEvent, GedNode, NegativeAssertion } from "./types";

/**
 * GEDCOM 7's negative assertion, `NO`: the file states that an event did *not*
 * happen — `1 NO MARR` (never married), `1 NO CHR` (never christened) —
 * optionally over a period (`2 DATE FROM 1700 TO 1720`), with its own notes and
 * citations. It is evidence, not a gap: "no marriage is recorded" and "there was
 * no marriage" are different findings.
 *
 * 5.5.1 has no such structure; the version migration keeps it as `_NO`, which
 * this module reads alike and the upgrade turns back into `NO`.
 */

/** The tags a negative assertion goes by — 7.0's own, and the 5.5.1 stand-in. */
export const NO_TAGS: readonly string[] = ["NO", "_NO"];

/** Individual events the editor offers to deny — GEDCOM 7's event-type
 *  enumeration as far as the app models the events (attributes cannot be
 *  denied: "never had an occupation" is `OCCU` with nothing in it). */
export const NO_INDI_EVENT_TAGS: readonly string[] = [
  "BIRT", "BAPM", "CHR", "FCOM", "CONF", "ADOP", "GRAD", "RETI",
  "EMIG", "IMMI", "NATU", "CENS", "WILL", "PROB", "DEAT", "CREM", "BURI",
];

/** Family events the editor offers to deny. */
export const NO_FAM_EVENT_TAGS: readonly string[] = ["MARR", "ENGA", "DIV"];

/** Read one `NO`/`_NO` line, or nothing when it names no event. */
export function parseNegativeAssertion(node: GedNode): NegativeAssertion | undefined {
  const tag = node.value?.trim().toUpperCase();
  if (!tag) return undefined;
  const out: NegativeAssertion = { tag, raw: node };
  const date = parseDateNode(firstChild(node, "DATE"));
  if (date) out.date = date;
  const note = firstChild(node, "NOTE")?.value?.trim();
  if (note && !/^@[^@]+@$/.test(note)) out.note = note;
  return out;
}

/** The record's negative assertions, in file order. */
export function negativeAssertionsOf(record: GedNode): NegativeAssertion[] {
  const out: NegativeAssertion[] = [];
  for (const child of record.children) {
    if (!NO_TAGS.includes(child.tag)) continue;
    const a = parseNegativeAssertion(child);
    if (a) out.push(a);
  }
  return out;
}

/** The years a negative assertion's `DATE` spans, open-ended where it is. */
function yearSpan(a: NegativeAssertion): [number, number] {
  const d = a.date;
  if (!d || d.year === undefined) return [-Infinity, Infinity];
  switch (d.qualifier) {
    case "before":
    case "to":
      return [-Infinity, d.year];
    case "after":
    case "from":
      return [d.year, Infinity];
    case "between":
    case "range":
      return [d.year, d.year2 ?? d.year];
    default:
      return [d.year, d.year];
  }
}

/**
 * Whether a recorded event contradicts the assertion: same tag, and either the
 * assertion covers all time or the event's year falls inside its period. An
 * undated event against a dated assertion is no contradiction — it may well
 * have happened outside the period.
 */
export function contradicts(a: NegativeAssertion, event: GedEvent): boolean {
  if (event.tag !== a.tag) return false;
  if (!a.date || a.date.year === undefined) return true;
  const year = event.date?.year;
  if (year === undefined) return false;
  const [from, to] = yearSpan(a);
  return year >= from && year <= to;
}

/** Where a new assertion goes in the record: after the last one, else ahead of
 *  the record's links and attachments (an `INDI`'s family pointers included),
 *  so it sits with the events it speaks about. */
const AFTER_EVENTS = new Set(["FAMC", "FAMS", "ASSO", "WWW", "URL", "_URL", "OBJE", "NOTE", "SNOTE", "SOUR", "CHAN", "CREA", "_UPD"]);

/** Write a negative assertion for `eventTag` on the record — `NO` in a 7.0
 *  file, the `_NO` stand-in otherwise. Does nothing when the record already
 *  says so. */
export function addNegativeAssertion(record: GedNode, eventTag: string, version: GedcomVersion): void {
  const tag = eventTag.toUpperCase();
  if (negativeAssertionsOf(record).some((a) => a.tag === tag)) return;
  insertNegativeAssertion(record, { level: record.level + 1, tag: version === "7.0" ? "NO" : "_NO", value: tag, children: [] });
}

/** Place an assertion line in the record, beside its kind (see above). */
export function insertNegativeAssertion(record: GedNode, node: GedNode): void {
  const kids = record.children;
  let at = -1;
  for (let i = kids.length - 1; i >= 0; i--) if (NO_TAGS.includes(kids[i].tag)) { at = i + 1; break; }
  if (at === -1) {
    at = kids.findIndex((c) => AFTER_EVENTS.has(c.tag));
    if (at === -1) at = kids.length;
  }
  kids.splice(at, 0, node);
}

/** Remove every negative assertion for `eventTag` from the record. */
export function removeNegativeAssertion(record: GedNode, eventTag: string): void {
  const tag = eventTag.toUpperCase();
  record.children = record.children.filter((c) => !(NO_TAGS.includes(c.tag) && c.value?.trim().toUpperCase() === tag));
}
