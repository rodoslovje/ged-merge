import { INDI_EVENT_TAGS } from "../eventTags";
import { childrenByTag, firstChild, hasChild, removeChildren } from "../node";
import type { Family, GedNode, Individual } from "../types";
import {
  EVENT_CHILD_ORDER, EVENT_LINK_TAG, FAM_CHILD_ORDER, INDI_CHILD_ORDER,
  insertOrdered, markEventTouched, setOrRemoveValue,
} from "./shared";
import { attachSourceCitation } from "./sources";

export interface EventFieldUpdate {
  /** New direct value on the event line (e.g. occupation text), or `""` to remove. */
  value?: string;
  /** New DATE value, or `""` to remove the date. Omit to leave unchanged. */
  date?: string;
  /** New PLAC value, or `""` to remove the place. Omit to leave unchanged. */
  place?: string;
  /** New ADDR value, or `""` to remove the address. Omit to leave unchanged. */
  address?: string;
  /** New NOTE value, or `""` to remove the first inline note. Omit to leave unchanged. */
  note?: string;
  /** New AGNC value (recording agency, e.g. parish), or `""` to remove it. Omit to leave unchanged. */
  agency?: string;
  /** New TYPE value (event sub-type, e.g. "religious"), or `""` to remove it. Omit to leave unchanged. */
  type?: string;
  /** New CAUS value (cause, e.g. of death), or `""` to remove it. Omit to leave unchanged. */
  cause?: string;
  /** New set of links, replacing all existing ones. `[]` removes them all. */
  links?: string[];
  /** Attach a new `SOUR` citation pointer (with optional `PAGE`) — the `SOUR`
   * (and `OBJE`) records themselves must already exist in the dataset.
   * `pageObjeXref` additionally links the cited page's image on the event
   * beside the citation (the "on events" page-media style). */
  addSource?: { sourceXref: string; page?: string; pageObjeXref?: string };
}

function setLinks(event: GedNode, links: string[]): void {
  removeChildren(event, EVENT_LINK_TAG);
  for (const link of links) {
    const trimmed = link.trim();
    if (!trimmed) continue;
    insertOrdered(
      event,
      { level: event.level + 1, tag: EVENT_LINK_TAG, value: trimmed, children: [] },
      EVENT_CHILD_ORDER,
    );
  }
}

/** Apply date/place/address/links to an existing event node; remove the node if it becomes empty. */
export function applyEventNodeUpdate(record: GedNode, eventNode: GedNode, update: EventFieldUpdate): void {
  if (update.value !== undefined) eventNode.value = update.value.trim() || undefined;
  if (update.date !== undefined) setOrRemoveValue(eventNode, "DATE", update.date, EVENT_CHILD_ORDER);
  if (update.place !== undefined) setOrRemoveValue(eventNode, "PLAC", update.place, EVENT_CHILD_ORDER);
  if (update.address !== undefined) setOrRemoveValue(eventNode, "ADDR", update.address, EVENT_CHILD_ORDER);
  if (update.note !== undefined) setOrRemoveValue(eventNode, "NOTE", update.note, EVENT_CHILD_ORDER);
  if (update.agency !== undefined) setOrRemoveValue(eventNode, "AGNC", update.agency, EVENT_CHILD_ORDER);
  if (update.type !== undefined) setOrRemoveValue(eventNode, "TYPE", update.type, EVENT_CHILD_ORDER);
  if (update.cause !== undefined) setOrRemoveValue(eventNode, "CAUS", update.cause, EVENT_CHILD_ORDER);
  if (update.links !== undefined) setLinks(eventNode, update.links);
  if (update.addSource) {
    attachSourceCitation(eventNode, update.addSource.sourceXref, update.addSource.page, EVENT_CHILD_ORDER);
    const pageObje = update.addSource.pageObjeXref;
    if (pageObje && !childrenByTag(eventNode, "OBJE").some((c) => c.value?.trim() === pageObje)) {
      insertOrdered(eventNode, { level: eventNode.level + 1, tag: "OBJE", value: pageObje, children: [] }, EVENT_CHILD_ORDER);
    }
  }
  if (eventNode.children.length === 0 && eventNode.value === undefined) {
    const i = record.children.indexOf(eventNode);
    if (i !== -1) record.children.splice(i, 1);
  }
}

/** Whether the update sets at least one non-blank field — i.e. applying it to
 *  a brand-new event node would leave the node non-empty. */
function eventUpdateHasContent(update: EventFieldUpdate): boolean {
  return (
    !!update.value?.trim() || !!update.date?.trim() || !!update.place?.trim() ||
    !!update.address?.trim() || !!update.note?.trim() || !!update.agency?.trim() ||
    !!update.type?.trim() || !!update.cause?.trim() ||
    !!update.links?.some((l) => l.trim()) || !!update.addSource
  );
}

/**
 * Update an event's date, place, address and/or links — finding (or
 * creating) the event subtree, e.g. `1 BIRT`/`1 MARR` with `2 DATE`/`2 PLAC`/
 * `2 ADDR`/`2 WWW` children. Fields set to `""`/`[]` remove the corresponding
 * lines; an event left with no children and no value is removed entirely.
 */
function setRecordEventField(record: GedNode, tag: string, update: EventFieldUpdate, order: string[]): GedNode | undefined {
  let event = firstChild(record, tag);
  const isNewEvent = !event;
  if (!event) {
    if (!eventUpdateHasContent(update)) return undefined;
    event = { level: record.level + 1, tag, children: [] };
    insertOrdered(record, event, order);
  }
  applyEventNodeUpdate(record, event, update);
  // `applyEventNodeUpdate` removes the node from `record.children` if the
  // update left it empty — don't hand back a now-detached node.
  if (!record.children.includes(event)) return undefined;
  markEventTouched(event, isNewEvent ? "new" : "changed");
  return event;
}

/** Update an individual event's date, place, address and/or links — see
 * `setRecordEventField`. Returns the event node touched (or created), or
 * `undefined` if there was nothing to set and no event already existed. */
export function setEventField(indi: Individual, tag: string, update: EventFieldUpdate): GedNode | undefined {
  return setRecordEventField(indi.raw, tag, update, INDI_CHILD_ORDER);
}

/** Update an individual event at position `index` in `indi.events` (0-based). */
export function setEventFieldAtIndex(indi: Individual, index: number, update: EventFieldUpdate): void {
  const eventNodes = indi.raw.children.filter((c) => INDI_EVENT_TAGS.has(c.tag));
  const eventNode = eventNodes[index];
  if (eventNode) {
    applyEventNodeUpdate(indi.raw, eventNode, update);
    if (indi.raw.children.includes(eventNode)) markEventTouched(eventNode, "changed");
  }
}

/** Change the tag of an individual event at position `index` in `indi.events`
 * (e.g. turn an Occupation into an Education event) in place, keeping its
 * position among siblings — e.g. an imported file that orders events
 * chronologically rather than by `INDI_CHILD_ORDER` keeps that order, instead
 * of the retagged event jumping to its tag's canonical position. No-op if
 * the event doesn't exist or the tag is unchanged. */
export function changeEventTagAtIndex(indi: Individual, index: number, newTag: string): void {
  const eventNodes = indi.raw.children.filter((c) => INDI_EVENT_TAGS.has(c.tag));
  const eventNode = eventNodes[index];
  if (!eventNode || eventNode.tag === newTag) return;
  eventNode.tag = newTag;
  markEventTouched(eventNode, "changed");
}

/** Remove an individual event at position `index` in `indi.events` (0-based). */
export function removeEventAtIndex(indi: Individual, index: number): void {
  const eventNodes = indi.raw.children.filter((c) => INDI_EVENT_TAGS.has(c.tag));
  const eventNode = eventNodes[index];
  if (eventNode) {
    const i = indi.raw.children.indexOf(eventNode);
    if (i !== -1) indi.raw.children.splice(i, 1);
  }
}

/** Re-insert a previously-removed event at the end of same-tag events.
 * Uses the last same-tag node (just appended by addEventNode) so it is safe
 * even when multiple events share the same tag. */
export function restoreEvent(indi: Individual, tag: string, data: EventFieldUpdate): void {
  addEventNode(indi, tag);
  const sameTagNodes = indi.raw.children.filter((c) => INDI_EVENT_TAGS.has(c.tag) && c.tag === tag);
  const newNode = sameTagNodes[sameTagNodes.length - 1];
  if (newNode) {
    applyEventNodeUpdate(indi.raw, newNode, data);
    if (indi.raw.children.includes(newNode)) markEventTouched(newNode, "new");
  }
}

/** Materialize the first edit to an incoming-only ("extra") merge-preview
 * row into its own brand-new event node — unlike `setEventField`, this never
 * reuses an existing same-tag node. Two unresolved incoming events that share
 * a tag (e.g. two pending RESI rows) get edited independently, so editing one
 * can't silently overwrite the node just created for the other. Returns the
 * new node, or `undefined` if there was nothing to set. */
export function addEventField(indi: Individual, tag: string, update: EventFieldUpdate): GedNode | undefined {
  if (!eventUpdateHasContent(update)) return undefined;
  addEventNode(indi, tag);
  const sameTagNodes = childrenByTag(indi.raw, tag);
  const newNode = sameTagNodes[sameTagNodes.length - 1];
  applyEventNodeUpdate(indi.raw, newNode, update);
  if (!indi.raw.children.includes(newNode)) return undefined;
  markEventTouched(newNode, "new");
  return newNode;
}

/** Append a new empty event node for `tag` to an individual record, inserting
 * it after the last existing event of the same tag (or in canonical order). */
export function addEventNode(indi: Individual, tag: string): void {
  const same = childrenByTag(indi.raw, tag);
  const event: GedNode = { level: indi.raw.level + 1, tag, children: [] };
  markEventTouched(event, "new");
  if (same.length > 0) {
    const lastIdx = indi.raw.children.indexOf(same[same.length - 1]);
    indi.raw.children.splice(lastIdx + 1, 0, event);
  } else {
    insertOrdered(indi.raw, event, INDI_CHILD_ORDER);
  }
}

/** Update a family event's (e.g. `1 MARR`) date, place, address and/or
 * links — see `setRecordEventField`. */
export function setFamilyEventField(fam: Family, tag: string, update: EventFieldUpdate): void {
  setRecordEventField(fam.raw, tag, update, FAM_CHILD_ORDER);
}

/** Change a family event's tag (e.g. turn an Engagement into a Marriage) in
 * place, keeping its position among siblings (see `changeEventTagAtIndex`).
 * No-op if the event doesn't exist, the tag is unchanged, or another event
 * with `newTag` already exists on the family (renaming into it would
 * silently shadow that other event). */
export function changeFamilyEventTag(fam: Family, oldTag: string, newTag: string): void {
  if (oldTag === newTag) return;
  const eventNode = firstChild(fam.raw, oldTag);
  if (!eventNode || hasChild(fam.raw, newTag)) return;
  eventNode.tag = newTag;
  markEventTouched(eventNode, "changed");
}

/** Append a new empty family event node for `tag`. */
export function addFamilyEventNode(fam: Family, tag: string): void {
  const event: GedNode = { level: fam.raw.level + 1, tag, children: [] };
  markEventTouched(event, "new");
  insertOrdered(fam.raw, event, FAM_CHILD_ORDER);
}

/** Remove a family event by tag (e.g. "ENGA", "SEPA", "DIV"). */
export function removeFamilyEvent(fam: Family, tag: string): void {
  const i = fam.raw.children.findIndex((c) => c.tag === tag);
  if (i !== -1) fam.raw.children.splice(i, 1);
}
