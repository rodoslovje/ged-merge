import { buildFamily, buildIndividual, buildMediaLinks, buildNoteIndex, INDI_EVENT_TAGS, type MediaLinks, type NoteIndex } from "./builder";
import { buildSourceContext, clearObjeNodeCache, isPointer, type SourceContext } from "./source";
import { birthSortKey } from "./lifespan";
import { childrenByTag, firstChild, hasChild, removeChildren } from "./node";
import type { Dataset, Family, GedNode, Individual, Sex } from "./types";

/**
 * In-place mutation helpers for the Edit mode.
 *
 * Each helper mutates an individual's raw `GedNode` tree directly — the same
 * tree `serializeGedcom` walks — so edits round-trip with minimal diffs. After
 * mutating, call `rebuildIndividual` to re-derive the typed `Individual` (and
 * update `dataset.individuals`) without rebuilding the whole dataset.
 */

/** Canonical sub-tag order within an event (BIRT/DEAT/RESI/…) node. */
export const EVENT_CHILD_ORDER = [
  "TYPE", "DATE", "PLAC", "ADDR", "AGE", "AGNC", "CAUS", "WWW", "URL", "_URL", "_WEBTAG", "OBJE", "NOTE", "SOUR",
];

/** Canonical top-level field order within an INDI record. */
export const INDI_CHILD_ORDER = [
  "NAME", "SEX",
  "BIRT", "BAPM", "CHR", "CONF", "ADOP", "FCOM",
  "OCCU", "EDUC", "RETI",
  "RESI", "EMIG", "IMMI", "NATU", "CENS",
  "WILL", "PROB",
  "EVEN",
  "DEAT", "BURI", "CREM",
  "FAMC", "FAMS",
  "WWW", "URL", "_URL", "_WEBTAG", "OBJE", "NOTE", "SOUR",
];

/** Canonical top-level field order within a FAM record. */
export const FAM_CHILD_ORDER = [
  "HUSB", "WIFE", "CHIL",
  "MARR", "ENGA", "SEPA", "MARB", "MARL", "DIV",
  "WWW", "URL", "_URL", "_WEBTAG", "OBJE", "NOTE", "SOUR",
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
   * (and `OBJE`) records themselves must already exist in the dataset. */
  addSource?: { sourceXref: string; page?: string };
}

/** Remove the *first* direct child with `tag` (single-valued fields). Distinct
 *  from node's `removeChildren`, which removes every match. */
function removeChild(node: GedNode, tag: string): void {
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

function getOrCreateChild(node: GedNode, tag: string, order: string[]): GedNode {
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
function setOrRemoveValue(node: GedNode, tag: string, value: string, order: string[]): void {
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
  if (update.addSource) attachSourceCitation(eventNode, update.addSource.sourceXref, update.addSource.page, EVENT_CHILD_ORDER);
  if (eventNode.children.length === 0 && eventNode.value === undefined) {
    const i = record.children.indexOf(eventNode);
    if (i !== -1) record.children.splice(i, 1);
  }
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
  const hasContent =
    !!update.value?.trim() || !!update.date?.trim() || !!update.place?.trim() ||
    !!update.address?.trim() || !!update.note?.trim() || !!update.agency?.trim() ||
    !!update.type?.trim() || !!update.cause?.trim() ||
    !!update.links?.some((l) => l.trim()) || !!update.addSource;
  if (!event) {
    if (!hasContent) return undefined;
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
  const hasContent =
    !!update.value?.trim() || !!update.date?.trim() || !!update.place?.trim() ||
    !!update.address?.trim() || !!update.note?.trim() || !!update.agency?.trim() ||
    !!update.type?.trim() || !!update.cause?.trim() ||
    !!update.links?.some((l) => l.trim()) || !!update.addSource;
  if (!hasContent) return undefined;
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

/**
 * Write `given`/`surname` into a NAME node's slash-form value and drop any
 * `GIVN`/`SURN` sub-tags. The slash value is the single source of truth (it's
 * what `parseName` reads first), so leaving the structured sub-tags behind would
 * let them go stale and contradict the edited name — always remove them.
 */
function writeNameValue(node: GedNode, given: string, surname: string): void {
  node.value = surname ? `${given} /${surname}/`.trim() : given;
  removeChildren(node, ["GIVN", "SURN"]);
}

/** Set (or clear) the individual's primary `NAME` line. */
export function setName(indi: Individual, name: { given?: string; surname?: string }): void {
  const record = indi.raw;
  const given = (name.given ?? "").trim();
  const surname = (name.surname ?? "").trim();

  if (!given && !surname) {
    removeChild(record, "NAME");
    return;
  }
  writeNameValue(getOrCreateChild(record, "NAME", INDI_CHILD_ORDER), given, surname);
}

function nameNodes(indi: Individual): GedNode[] {
  return childrenByTag(indi.raw, "NAME");
}

/** Set (or clear) the primary `NAME`'s `NICK` (nickname) sub-tag. */
export function setNickname(indi: Individual, nickname: string): void {
  const node = nameNodes(indi)[0];
  if (!node) return;
  setOrRemoveValue(node, "NICK", nickname, NAME_CHILD_ORDER);
}

/** Set (or clear) the primary `NAME`'s `_MARNM` (married surname) sub-tag — the
 * inline alternative to a separate `TYPE married` NAME record, used when the
 * master file follows the `_MARNM` convention. */
export function setMarriedName(indi: Individual, surname: string): void {
  const node = nameNodes(indi)[0];
  if (!node) return;
  setOrRemoveValue(node, "_MARNM", surname, NAME_CHILD_ORDER);
}

export interface NameVariantUpdate {
  given?: string;
  surname?: string;
  /** `2 TYPE` value (e.g. "married", "maiden", "aka"). */
  type?: string;
}

/**
 * Update an additional name — `index` 0 is `indi.names[1]` (the second
 * `1 NAME` record), 1 is `indi.names[2]`, etc.
 */
export function setAdditionalName(indi: Individual, index: number, update: NameVariantUpdate): void {
  const node = nameNodes(indi)[index + 1];
  if (!node) return;

  if (update.given !== undefined || update.surname !== undefined) {
    const current = indi.names[index + 1];
    const given = (update.given ?? current?.given ?? "").trim();
    const surname = (update.surname ?? current?.surname ?? "").trim();
    writeNameValue(node, given, surname);
  }
  if (update.type !== undefined) setOrRemoveValue(node, "TYPE", update.type, NAME_CHILD_ORDER);
}

/**
 * Fold an additional `1 NAME` record into the primary name's inline `_MARNM`
 * married-surname sub-tag — used when the master follows the `_MARNM` convention
 * and the user marks an added name as "married". The additional record is
 * removed and its surname moved onto `_MARNM`; a name with no surname is just
 * dropped (an empty married name is meaningless). See `setAdditionalName` for
 * indexing.
 */
export function foldAdditionalNameToMarnm(indi: Individual, index: number): void {
  const surname = indi.names[index + 1]?.surname?.trim();
  removeAdditionalName(indi, index);
  if (surname) setMarriedName(indi, surname);
}

/** Append a new additional `1 NAME` record with the given `2 TYPE`. */
export function addAdditionalName(indi: Individual, type: string): void {
  const node: GedNode = { level: indi.raw.level + 1, tag: "NAME", value: "", children: [] };
  insertOrdered(indi.raw, node, INDI_CHILD_ORDER);
  setOrRemoveValue(node, "TYPE", type, NAME_CHILD_ORDER);
}

/** Remove an additional `1 NAME` record — see `setAdditionalName` for indexing. */
export function removeAdditionalName(indi: Individual, index: number): void {
  const node = nameNodes(indi)[index + 1];
  if (!node) return;
  const i = indi.raw.children.indexOf(node);
  if (i !== -1) indi.raw.children.splice(i, 1);
}

/** Set (or, for "U", remove) the individual's `SEX` line. */
export function setSex(indi: Individual, sex: Sex): void {
  if (sex === "U") {
    removeChild(indi.raw, "SEX");
    return;
  }
  getOrCreateChild(indi.raw, "SEX", INDI_CHILD_ORDER).value = sex;
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

/** Add a `FAMC`/`FAMS` pointer from an individual to a family. */
function addFamilyLink(indi: Individual, tag: "FAMC" | "FAMS", famId: string): void {
  insertOrdered(indi.raw, { level: indi.raw.level + 1, tag, value: famId, children: [] }, INDI_CHILD_ORDER);
}

/** Set a family's `HUSB`/`WIFE` pointer to an individual. */
function setFamilySpouse(fam: Family, tag: "HUSB" | "WIFE", indiId: string): void {
  getOrCreateChild(fam.raw, tag, FAM_CHILD_ORDER).value = indiId;
}

/** Append a `CHIL` pointer to a family. */
/**
 * Add a `CHIL` pointer to a family, inserted among the existing children in
 * birth order (year, then month/day). A child with no known birth date — e.g.
 * a brand-new empty individual — goes after the dated children, at the end of
 * the `CHIL` block. The position is found by comparing birth keys against the
 * existing children only, so an already-sorted list stays sorted.
 */
function addFamilyChild(dataset: Dataset, fam: Family, childId: string): void {
  const node: GedNode = { level: fam.raw.level + 1, tag: "CHIL", value: childId, children: [] };
  const key = birthSortKey(dataset.individuals.get(childId));
  // Insert before the first existing CHIL that was born later than this child.
  const before = fam.raw.children.find(
    (c) => c.tag === "CHIL" && c.value !== undefined && birthSortKey(dataset.individuals.get(c.value)) > key,
  );
  if (!before) {
    insertOrdered(fam.raw, node, FAM_CHILD_ORDER);
    return;
  }
  fam.raw.children.splice(fam.raw.children.indexOf(before), 0, node);
}

/** Create a new, empty `INDI` record (with just a `SEX` line, if known) and add it to the dataset. */
export function addIndividual(dataset: Dataset, sex: Sex): Individual {
  const xref = nextXref(dataset.records, "I");
  const raw: GedNode = { level: 0, xref, tag: "INDI", children: [] };
  if (sex !== "U") raw.children.push({ level: 1, tag: "SEX", value: sex, children: [] });
  insertRecord(dataset.records, raw);
  return rebuildIndividual(dataset, { id: xref, raw } as Individual);
}

/** Create a new, empty `FAM` record and add it to the dataset. */
export function addFamily(dataset: Dataset): Family {
  const xref = nextXref(dataset.records, "F");
  const raw: GedNode = { level: 0, xref, tag: "FAM", children: [] };
  insertRecord(dataset.records, raw);
  return rebuildFamily(dataset, { id: xref, raw } as Family);
}

/**
 * Add a new, empty father (or mother) to `person`. If `fam` is given (an
 * existing parent family missing that role), the new individual fills its
 * `HUSB`/`WIFE` slot; otherwise a new family is created and linked via
 * `FAMC`/`HUSB`/`WIFE`. Returns the new individual so the caller can navigate
 * to it for editing.
 */
export function addParent(dataset: Dataset, person: Individual, fam: Family | undefined, role: "father" | "mother"): Individual {
  const sex: Sex = role === "father" ? "M" : "F";
  const tag: "HUSB" | "WIFE" = role === "father" ? "HUSB" : "WIFE";
  const parent = addIndividual(dataset, sex);

  if (!fam) {
    fam = addFamily(dataset);
    addFamilyChild(dataset, fam, person.id);
    addFamilyLink(person, "FAMC", fam.id);
    rebuildIndividual(dataset, person);
  }
  setFamilySpouse(fam, tag, parent.id);
  addFamilyLink(parent, "FAMS", fam.id);
  rebuildFamily(dataset, fam);
  return rebuildIndividual(dataset, parent);
}

/**
 * Add a new, empty partner to `person`. If `fam` is given (an existing spouse
 * family missing the other `HUSB`/`WIFE` slot), the new individual fills it;
 * otherwise a new family is created with `person` in the slot matching their
 * sex. Returns the new individual so the caller can navigate to it.
 */
export function addPartner(dataset: Dataset, person: Individual, fam: Family | undefined): Individual {
  const personTag: "HUSB" | "WIFE" = fam ? (fam.husband === person.id ? "HUSB" : "WIFE") : person.sex === "F" ? "WIFE" : "HUSB";
  const partnerTag: "HUSB" | "WIFE" = personTag === "HUSB" ? "WIFE" : "HUSB";
  const partner = addIndividual(dataset, partnerTag === "HUSB" ? "M" : "F");

  if (!fam) {
    fam = addFamily(dataset);
    setFamilySpouse(fam, personTag, person.id);
    addFamilyLink(person, "FAMS", fam.id);
    rebuildIndividual(dataset, person);
  }
  setFamilySpouse(fam, partnerTag, partner.id);
  addFamilyLink(partner, "FAMS", fam.id);
  rebuildFamily(dataset, fam);
  return rebuildIndividual(dataset, partner);
}

/**
 * Add a new, empty child to `person`. If `fam` is given, the child is added
 * there; otherwise a new spouse family is created for `person` first.
 * Returns the new individual so the caller can navigate to it.
 */
export function addChild(dataset: Dataset, person: Individual, fam: Family | undefined): Individual {
  const child = addIndividual(dataset, "U");

  if (!fam) {
    fam = addFamily(dataset);
    setFamilySpouse(fam, person.sex === "F" ? "WIFE" : "HUSB", person.id);
    addFamilyLink(person, "FAMS", fam.id);
    rebuildIndividual(dataset, person);
  }
  addFamilyChild(dataset, fam, child.id);
  addFamilyLink(child, "FAMC", fam.id);
  rebuildFamily(dataset, fam);
  return rebuildIndividual(dataset, child);
}

/**
 * Connect an existing individual as a parent of `person`.
 * If `fam` is given (an existing parent family missing that role), the
 * individual fills its HUSB/WIFE slot; otherwise a new family is created.
 */
export function connectExistingParent(
  dataset: Dataset,
  person: Individual,
  parentId: string,
  fam: Family | undefined,
  role: "father" | "mother",
): void {
  const tag: "HUSB" | "WIFE" = role === "father" ? "HUSB" : "WIFE";
  const parent = dataset.individuals.get(parentId);
  if (!parent) return;

  if (!fam) {
    fam = addFamily(dataset);
    addFamilyChild(dataset, fam, person.id);
    if (!person.raw.children.some((c) => c.tag === "FAMC" && c.value === fam!.id))
      addFamilyLink(person, "FAMC", fam.id);
    rebuildIndividual(dataset, person);
  }
  setFamilySpouse(fam, tag, parentId);
  if (!parent.raw.children.some((c) => c.tag === "FAMS" && c.value === fam!.id))
    addFamilyLink(parent, "FAMS", fam.id);
  rebuildFamily(dataset, fam);
  rebuildIndividual(dataset, parent);
}

/**
 * Connect an existing individual as a partner of `person`.
 * If `fam` is given (an existing spouse family missing the other role),
 * the individual fills that slot; otherwise a new family is created.
 */
export function connectExistingPartner(
  dataset: Dataset,
  person: Individual,
  partnerId: string,
  fam: Family | undefined,
): void {
  const partner = dataset.individuals.get(partnerId);
  if (!partner) return;

  const personTag: "HUSB" | "WIFE" = fam
    ? fam.husband === person.id ? "HUSB" : "WIFE"
    : person.sex === "F" ? "WIFE" : "HUSB";
  const partnerTag: "HUSB" | "WIFE" = personTag === "HUSB" ? "WIFE" : "HUSB";

  if (!fam) {
    fam = addFamily(dataset);
    setFamilySpouse(fam, personTag, person.id);
    if (!person.raw.children.some((c) => c.tag === "FAMS" && c.value === fam!.id))
      addFamilyLink(person, "FAMS", fam.id);
    rebuildIndividual(dataset, person);
  }
  setFamilySpouse(fam, partnerTag, partnerId);
  if (!partner.raw.children.some((c) => c.tag === "FAMS" && c.value === fam!.id))
    addFamilyLink(partner, "FAMS", fam.id);
  rebuildFamily(dataset, fam);
  rebuildIndividual(dataset, partner);
}

/**
 * Connect an existing individual as a child of `person`.
 * If `fam` is given, the child is added there; otherwise a new spouse family
 * is created for `person`.
 */
export function connectExistingChild(
  dataset: Dataset,
  person: Individual,
  childId: string,
  fam: Family | undefined,
): void {
  const child = dataset.individuals.get(childId);
  if (!child) return;

  if (!fam) {
    fam = addFamily(dataset);
    setFamilySpouse(fam, person.sex === "F" ? "WIFE" : "HUSB", person.id);
    if (!person.raw.children.some((c) => c.tag === "FAMS" && c.value === fam!.id))
      addFamilyLink(person, "FAMS", fam.id);
    rebuildIndividual(dataset, person);
  }
  if (!fam.children.includes(childId)) addFamilyChild(dataset, fam, childId);
  if (!child.raw.children.some((c) => c.tag === "FAMC" && c.value === fam!.id))
    addFamilyLink(child, "FAMC", fam.id);
  rebuildFamily(dataset, fam);
  rebuildIndividual(dataset, child);
}

/** Tags used for record-level links (top-level on INDI/FAM records). */
const RECORD_LINK_TAGS = ["WWW", "URL", "_URL", "_WEBTAG"];

/**
 * Remove a family that has fewer than two members — a lone spouse, a single
 * child, or nothing at all. A family needs at least two members (a couple, or
 * a parent/sibling group) to mean anything; once a deletion or detach drops it
 * below that, the now-meaningless `FAM` record (which may still carry only
 * CREA/CHAN/MARR stubs) is dropped via `removeFamily`, which also unlinks the
 * `FAMS`/`FAMC` pointer of any sole surviving member. Returns `true` if it was
 * removed.
 */
export function pruneDegenerateFamily(dataset: Dataset, fam: Family): boolean {
  const memberCount = (fam.husband ? 1 : 0) + (fam.wife ? 1 : 0) + fam.children.length;
  if (memberCount >= 2) return false;
  removeFamily(dataset, fam);
  return true;
}

/** Remove a spouse role (HUSB or WIFE) from a family and the matching FAMS from the individual. */
export function detachSpouseRole(dataset: Dataset, fam: Family, role: "HUSB" | "WIFE"): void {
  const indiId = role === "HUSB" ? fam.husband : fam.wife;
  if (!indiId) return;
  removeChild(fam.raw, role);
  const indi = dataset.individuals.get(indiId);
  if (indi) {
    const i = indi.raw.children.findIndex((c) => c.tag === "FAMS" && c.value === fam.id);
    if (i !== -1) indi.raw.children.splice(i, 1);
    rebuildIndividual(dataset, indi);
  }
  pruneDegenerateFamily(dataset, rebuildFamily(dataset, fam));
}

/** Remove a child from a family's CHIL list and the matching FAMC from the child. */
export function detachChildFromFamily(dataset: Dataset, fam: Family, childId: string): void {
  const ci = fam.raw.children.findIndex((c) => c.tag === "CHIL" && c.value === childId);
  if (ci !== -1) fam.raw.children.splice(ci, 1);
  const child = dataset.individuals.get(childId);
  if (child) {
    const fi = child.raw.children.findIndex((c) => c.tag === "FAMC" && c.value === fam.id);
    if (fi !== -1) child.raw.children.splice(fi, 1);
    rebuildIndividual(dataset, child);
  }
  pruneDegenerateFamily(dataset, rebuildFamily(dataset, fam));
}

/** Fully remove an individual from the dataset, cleaning up all family pointers.
 * Families left with fewer than two members once this person is gone are pruned
 * too (see `pruneDegenerateFamily`), so deleting people out of a family doesn't
 * leave a lone-member or empty `FAM` record behind. */
export function removeIndividual(dataset: Dataset, indi: Individual): void {
  const affectedFamilyIds = new Set([...indi.spouseOf, ...indi.childOf]);
  for (const famId of indi.spouseOf) {
    const fam = dataset.families.get(famId);
    if (!fam) continue;
    if (fam.husband === indi.id) removeChild(fam.raw, "HUSB");
    else if (fam.wife === indi.id) removeChild(fam.raw, "WIFE");
    rebuildFamily(dataset, fam);
  }
  for (const famId of indi.childOf) {
    const fam = dataset.families.get(famId);
    if (!fam) continue;
    const ci = fam.raw.children.findIndex((c) => c.tag === "CHIL" && c.value === indi.id);
    if (ci !== -1) fam.raw.children.splice(ci, 1);
    rebuildFamily(dataset, fam);
  }
  const ri = dataset.records.findIndex((r) => r.xref === indi.id);
  if (ri !== -1) dataset.records.splice(ri, 1);
  dataset.individuals.delete(indi.id);
  for (const famId of affectedFamilyIds) {
    const fam = dataset.families.get(famId);
    if (fam) pruneDegenerateFamily(dataset, fam);
  }
}

/** Fully remove a family from the dataset, cleaning up FAMS/FAMC pointers on all members. */
export function removeFamily(dataset: Dataset, fam: Family): void {
  for (const indiId of [fam.husband, fam.wife]) {
    if (!indiId) continue;
    const indi = dataset.individuals.get(indiId);
    if (!indi) continue;
    const i = indi.raw.children.findIndex((c) => c.tag === "FAMS" && c.value === fam.id);
    if (i !== -1) indi.raw.children.splice(i, 1);
    rebuildIndividual(dataset, indi);
  }
  for (const childId of fam.children) {
    const child = dataset.individuals.get(childId);
    if (!child) continue;
    const i = child.raw.children.findIndex((c) => c.tag === "FAMC" && c.value === fam.id);
    if (i !== -1) child.raw.children.splice(i, 1);
    rebuildIndividual(dataset, child);
  }
  const ri = dataset.records.findIndex((r) => r.xref === fam.id);
  if (ri !== -1) dataset.records.splice(ri, 1);
  dataset.families.delete(fam.id);
}

/** Replace all NOTE records on an individual with the given texts. */
export function setNotes(indi: Individual, notes: string[]): void {
  removeChildren(indi.raw, "NOTE");
  for (const text of notes) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    insertOrdered(indi.raw, { level: indi.raw.level + 1, tag: "NOTE", value: trimmed, children: [] }, INDI_CHILD_ORDER);
  }
}

/** Replace all NOTE records on a family with the given texts. */
export function setFamilyNotes(fam: Family, notes: string[]): void {
  fam.raw.children = fam.raw.children.filter((c) => c.tag !== "NOTE");
  for (const text of notes) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    insertOrdered(fam.raw, { level: fam.raw.level + 1, tag: "NOTE", value: trimmed, children: [] }, FAM_CHILD_ORDER);
  }
}

/** Replace all top-level link records on an individual (WWW/URL/_URL/_WEBTAG). */
export function setIndividualLinks(indi: Individual, links: string[]): void {
  indi.raw.children = indi.raw.children.filter((c) => !RECORD_LINK_TAGS.includes(c.tag));
  for (const link of links) {
    const trimmed = link.trim();
    if (!trimmed) continue;
    insertOrdered(indi.raw, { level: indi.raw.level + 1, tag: "WWW", value: trimmed, children: [] }, INDI_CHILD_ORDER);
  }
}

/** Replace all top-level link records on a family (WWW/URL/_URL/_WEBTAG). */
export function setFamilyLinks(fam: Family, links: string[]): void {
  fam.raw.children = fam.raw.children.filter((c) => !RECORD_LINK_TAGS.includes(c.tag));
  for (const link of links) {
    const trimmed = link.trim();
    if (!trimmed) continue;
    insertOrdered(fam.raw, { level: fam.raw.level + 1, tag: "WWW", value: trimmed, children: [] }, FAM_CHILD_ORDER);
  }
}

/** Fields for a newly authored `SOUR` record — see `createSourceRecord`. */
export interface NewSourceFields {
  title?: string;
  author?: string;
  periodical?: string;
  publisher?: string;
  agency?: string;
  filingNumber?: string;
  note?: string;
  url?: string;
}

/** Create a new top-level `OBJE` record whose `FILE` is `url`/`file` (with an
 * optional `TITL`), and add it to `records`. */
export function createMediaRecord(records: GedNode[], url: string, title?: string): GedNode {
  const raw: GedNode = {
    level: 0,
    xref: nextXref(records, "O"),
    tag: "OBJE",
    children: [{ level: 1, tag: "FILE", value: url, children: [] }],
  };
  const trimmedTitle = title?.trim();
  if (trimmedTitle) raw.children.push({ level: 1, tag: "TITL", value: trimmedTitle, children: [] });
  insertRecord(records, raw);
  bumpSourceCacheVersion(records);
  clearObjeNodeCache(records);
  return raw;
}

// ── Individual photos (OBJE) ────────────────────────────────────────────────
//
// Edit-mode helpers for attaching/removing/reordering a person's photos. The
// inline-vs-shared choice (whether to write an inline `1 OBJE`/`2 FILE` block or
// a `1 OBJE @O@` pointer to a top-level record) is the caller's, driven by the
// master file's detected `MediaMode`; these helpers just realize whichever the
// caller picks.

/** Build an `OBJE` node (a `FILE` plus an optional `TITL`) at `level`. */
function buildObjeNode(level: number, file: string, title?: string): GedNode {
  const node: GedNode = { level, tag: "OBJE", children: [{ level: level + 1, tag: "FILE", value: file, children: [] }] };
  const trimmedTitle = title?.trim();
  if (trimmedTitle) node.children.push({ level: level + 1, tag: "TITL", value: trimmedTitle, children: [] });
  return node;
}

/** The first top-level shared `OBJE` whose `FILE` equals `file` (case-insensitive),
 * so adding a photo already on file reuses its record instead of duplicating it. */
export function findSharedMediaByFile(records: GedNode[], file: string): GedNode | undefined {
  const target = file.trim().toLowerCase();
  if (!target) return undefined;
  for (const rec of records) {
    if (rec.tag !== "OBJE" || !rec.xref) continue;
    const f = firstChild(rec, "FILE")?.value?.trim().toLowerCase();
    if (f === target) return rec;
  }
  return undefined;
}

/** Append a new `OBJE` node after the individual's last existing `OBJE` (so a
 * just-added photo is reliably last among the photos, regardless of where the
 * existing ones sit in the record), or at the canonical position if it's the
 * first. Mirrors `addEventNode`'s "after the last same-tag node" placement. */
function appendMediaNode(indi: Individual, node: GedNode): GedNode {
  const objes = childrenByTag(indi.raw, "OBJE");
  if (objes.length > 0) {
    const lastIdx = indi.raw.children.indexOf(objes[objes.length - 1]);
    indi.raw.children.splice(lastIdx + 1, 0, node);
  } else {
    insertOrdered(indi.raw, node, INDI_CHILD_ORDER);
  }
  return node;
}

/** Add an inline `1 OBJE`/`2 FILE` photo block to an individual (inline mode). */
export function attachInlineMedia(indi: Individual, file: string, title?: string): GedNode {
  return appendMediaNode(indi, buildObjeNode(indi.raw.level + 1, file, title));
}

/** Add a `1 OBJE @O@` pointer to a top-level shared media record (shared mode). */
export function attachMediaPointer(indi: Individual, objeXref: string): GedNode {
  return appendMediaNode(indi, { level: indi.raw.level + 1, tag: "OBJE", value: objeXref, children: [] });
}

/**
 * Remove the `objeIndex`th `OBJE` child of an individual (0-based among its
 * `OBJE` children). If it was a pointer to a top-level shared record, prune
 * that record when nothing else in the dataset still references it.
 */
export function removeIndividualMediaAtIndex(dataset: Dataset, indi: Individual, objeIndex: number): void {
  const node = childrenByTag(indi.raw, "OBJE")[objeIndex];
  if (!node) return;
  const i = indi.raw.children.indexOf(node);
  if (i !== -1) indi.raw.children.splice(i, 1);
  const ptr = node.value?.trim();
  if (ptr && isPointer(ptr)) pruneUnreferencedMedia(dataset, ptr);
}

/**
 * Move an individual's `OBJE` child from position `from` to `to` (0-based among
 * its `OBJE` children), leaving every non-`OBJE` child in place — so a tray
 * reorder doesn't disturb the rest of the record's field order.
 */
export function reorderIndividualMedia(indi: Individual, from: number, to: number): void {
  const slots = indi.raw.children.map((c, i) => (c.tag === "OBJE" ? i : -1)).filter((i) => i >= 0);
  const objes = slots.map((i) => indi.raw.children[i]);
  if (from === to || from < 0 || to < 0 || from >= objes.length || to >= objes.length) return;
  const [moved] = objes.splice(from, 1);
  objes.splice(to, 0, moved);
  slots.forEach((slotIdx, k) => { indi.raw.children[slotIdx] = objes[k]; });
}

/** Editable descriptive fields of a photo (`OBJE`). Each maps to a sub-tag;
 *  an empty/blank value removes that tag. `undefined` leaves it unchanged. */
export interface MediaInfoFields {
  /** Caption — `TITL`. */
  title?: string;
  /** The date the media depicts — `DATE`. */
  date?: string;
  /** Place depicted — `PLAC`. */
  place?: string;
  /** Free-text description — `_DSCR` (the `NOTE` fallback is dropped). */
  description?: string;
}

/**
 * Write a photo's descriptive fields onto its `OBJE` node — either an inline
 * block or a shared top-level record. `TITL`/`DATE`/`PLAC` are normalized to the
 * `OBJE` level (any `TITL` nested on the `FILE` child is removed so it can't go
 * stale), and `description` is stored as `_DSCR` (dropping a `NOTE` that
 * `objeInfoOf` would otherwise read as the description). Blank values clear the
 * tag; omitted fields are left untouched.
 */
export function setMediaInfo(objeNode: GedNode, fields: MediaInfoFields): void {
  const fileNode = firstChild(objeNode, "FILE");
  const set = (tag: string, value: string) => {
    objeNode.children = objeNode.children.filter((c) => c.tag !== tag);
    if (fileNode) fileNode.children = fileNode.children.filter((c) => c.tag !== tag);
    const v = value.trim();
    if (v) objeNode.children.push({ level: objeNode.level + 1, tag, value: v, children: [] });
  };
  if (fields.title !== undefined) set("TITL", fields.title);
  if (fields.date !== undefined) set("DATE", fields.date);
  if (fields.place !== undefined) set("PLAC", fields.place);
  if (fields.description !== undefined) {
    objeNode.children = objeNode.children.filter((c) => c.tag !== "_DSCR" && c.tag !== "NOTE");
    const v = fields.description.trim();
    if (v) objeNode.children.push({ level: objeNode.level + 1, tag: "_DSCR", value: v, children: [] });
  }
}

/**
 * Delete the top-level `OBJE` record `objeXref` if no pointer anywhere in the
 * dataset (on an `INDI`, `FAM`, or `SOUR`) still references it. Mirrors
 * `pruneUnreferencedSource` — a shared photo also cited as a source-page image,
 * or still attached to another person, is left intact.
 */
export function pruneUnreferencedMedia(dataset: Dataset, objeXref: string): void {
  const stack: GedNode[] = [...dataset.records];
  while (stack.length) {
    const node = stack.pop()!;
    // A pointer (value set) referencing this media — its own definition record
    // has no value, so it never counts as a reference to itself.
    if (node.tag === "OBJE" && node.value?.trim() === objeXref) return; // still referenced
    for (const child of node.children) stack.push(child);
  }
  const i = dataset.records.findIndex((r) => r.tag === "OBJE" && r.xref === objeXref);
  if (i !== -1) dataset.records.splice(i, 1);
  bumpSourceCacheVersion(dataset.records);
  clearObjeNodeCache(dataset.records);
}

/**
 * Create a new top-level `SOUR` record from user-entered/parsed fields and,
 * if `url` is given, a backing `OBJE` record for it — the same shape
 * `resolveSourceCitation` already resolves for imported "paginated" sources
 * (a `SOUR` with one linked `OBJE`), so the new citation displays/links
 * exactly like an imported one.
 */
export function createSourceRecord(records: GedNode[], fields: NewSourceFields): GedNode {
  const raw: GedNode = { level: 0, xref: nextXref(records, "S"), tag: "SOUR", children: [] };
  const push = (tag: string, value: string | undefined) => {
    if (value) raw.children.push({ level: 1, tag, value, children: [] });
  };
  push("TITL", fields.title);
  push("AUTH", fields.author);
  push("PERI", fields.periodical);
  push("PUBL", fields.publisher);
  push("AGNC", fields.agency);
  push("FILN", fields.filingNumber);
  push("NOTE", fields.note);
  insertRecord(records, raw);
  bumpSourceCacheVersion(records);
  if (fields.url) {
    const obje = createMediaRecord(records, fields.url);
    raw.children.push({ level: 1, tag: "OBJE", value: obje.xref, children: [] });
  }
  return raw;
}

/** Add a new `OBJE` (linking `url`) to an already-existing `SOUR` record —
 * a new page of a paginated source that's already cited elsewhere. */
export function addObjeToSource(records: GedNode[], sourceXref: string, url: string): GedNode {
  const obje = createMediaRecord(records, url);
  const sourceNode = records.find((r) => r.tag === "SOUR" && r.xref === sourceXref);
  if (sourceNode) sourceNode.children.push({ level: sourceNode.level + 1, tag: "OBJE", value: obje.xref, children: [] });
  return obje;
}

/** Attach a `SOUR` citation pointer (with optional `PAGE`) to `record` — an
 * event node, or a top-level INDI/FAM record — in canonical field order. */
export function attachSourceCitation(record: GedNode, sourceXref: string, page: string | undefined, order: string[]): void {
  const citation: GedNode = { level: record.level + 1, tag: "SOUR", value: sourceXref, children: [] };
  if (page) citation.children.push({ level: record.level + 2, tag: "PAGE", value: page, children: [] });
  insertOrdered(record, citation, order);
}

function sourceCitationNodes(record: GedNode): GedNode[] {
  return childrenByTag(record, "SOUR");
}

/** Fields editable on an existing citation — `NewSourceFields` plus the
 * citation-local `page` and (when known) the specific `OBJE` its resolved
 * `url` came from, so a `url` edit retargets only that page's file. */
export type EditSourceFields = NewSourceFields & { page?: string; objeXref?: string };

/**
 * Update the `index`th `SOUR` citation on `node` (an event node, or a
 * top-level INDI/FAM record) in place. For a citation pointing at a shared
 * `SOUR` record, the bibliographic fields (title/author/.../note) are written
 * to that record — affecting every other citation of the same source, which
 * is correct since they describe the source itself, not this citation of it.
 * `page` is citation-local. `url` retargets `fields.objeXref` (the specific
 * page image this citation resolved to) when known, the source's sole `OBJE`
 * when it has exactly one, or otherwise creates a new `OBJE` for this page —
 * never touching another page's file. For an inline (plain-text) citation,
 * only its own value/page can change (there's no shared record).
 */
export function updateSourceCitation(records: GedNode[], node: GedNode, index: number, fields: EditSourceFields): void {
  const citation = sourceCitationNodes(node)[index];
  if (!citation) return;

  const page = fields.page?.trim();
  citation.children = citation.children.filter((c) => c.tag !== "PAGE");
  if (page) citation.children.push({ level: citation.level + 1, tag: "PAGE", value: page, children: [] });

  const sourceXref = citation.value?.trim();
  if (!sourceXref || !isPointer(sourceXref)) {
    const title = fields.title?.trim();
    if (title) citation.value = title;
    return;
  }

  const sourceNode = records.find((r) => r.tag === "SOUR" && r.xref === sourceXref);
  if (!sourceNode) return;
  const setChild = (tag: string, value: string | undefined) => {
    sourceNode.children = sourceNode.children.filter((c) => c.tag !== tag);
    const trimmed = value?.trim();
    if (trimmed) sourceNode.children.push({ level: sourceNode.level + 1, tag, value: trimmed, children: [] });
  };
  setChild("TITL", fields.title);
  setChild("AUTH", fields.author);
  setChild("PERI", fields.periodical);
  setChild("PUBL", fields.publisher);
  setChild("AGNC", fields.agency);
  setChild("FILN", fields.filingNumber);
  setChild("NOTE", fields.note);

  const url = fields.url?.trim();
  const soleObjeXref = sourceNode.children.filter((c) => c.tag === "OBJE" && c.value).length === 1
    ? firstChild(sourceNode, "OBJE")?.value?.trim()
    : undefined;
  const objeXref = fields.objeXref ?? soleObjeXref;

  if (objeXref) {
    const objeNode = records.find((r) => r.tag === "OBJE" && r.xref === objeXref);
    if (objeNode && url) {
      const fileChild = firstChild(objeNode, "FILE");
      if (fileChild) fileChild.value = url;
      else objeNode.children.unshift({ level: objeNode.level + 1, tag: "FILE", value: url, children: [] });
      bumpSourceCacheVersion(records);
    } else if (objeNode && !url) {
      // Cleared: unlink this page's OBJE from the source, prune it if it's now orphaned.
      sourceNode.children = sourceNode.children.filter((c) => !(c.tag === "OBJE" && c.value?.trim() === objeXref));
      const stillReferenced = records.some((r) => r.tag === "SOUR" && r.children.some((c) => c.tag === "OBJE" && c.value?.trim() === objeXref));
      if (!stillReferenced) {
        const oi = records.findIndex((r) => r.tag === "OBJE" && r.xref === objeXref);
        if (oi !== -1) records.splice(oi, 1);
      }
      bumpSourceCacheVersion(records);
    }
  } else if (url) {
    const obje = createMediaRecord(records, url);
    sourceNode.children.push({ level: sourceNode.level + 1, tag: "OBJE", value: obje.xref, children: [] });
  }
}

/**
 * Remove the `index`th `SOUR` citation from `record` (an event node, or a
 * top-level INDI/FAM record), then delete the cited `SOUR`/`OBJE` records if
 * nothing else in the dataset still references them.
 */
export function removeSourceCitationAtIndex(dataset: Dataset, record: GedNode, index: number): void {
  const node = sourceCitationNodes(record)[index];
  if (!node) return;
  const i = record.children.indexOf(node);
  if (i !== -1) record.children.splice(i, 1);
  const sourceXref = node.value?.trim();
  if (sourceXref) pruneUnreferencedSource(dataset, sourceXref);
}

/**
 * Delete the top-level `SOUR` record `sourceXref` (and any `OBJE` record it
 * alone referenced) if no citation anywhere in the dataset still points at it.
 */
export function pruneUnreferencedSource(dataset: Dataset, sourceXref: string): void {
  const stack: GedNode[] = [...dataset.records];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.tag === "SOUR" && !node.xref && node.value?.trim() === sourceXref) return; // still cited
    for (const child of node.children) stack.push(child);
  }

  const sourceIndex = dataset.records.findIndex((r) => r.tag === "SOUR" && r.xref === sourceXref);
  if (sourceIndex === -1) return;
  const objeXrefs = dataset.records[sourceIndex].children
    .filter((c) => c.tag === "OBJE" && c.value)
    .map((c) => c.value!.trim());
  dataset.records.splice(sourceIndex, 1);

  for (const objeXref of objeXrefs) {
    const stillReferenced = dataset.records.some(
      (r) => r.tag === "SOUR" && r.children.some((c) => c.tag === "OBJE" && c.value?.trim() === objeXref),
    );
    if (!stillReferenced) {
      const oi = dataset.records.findIndex((r) => r.tag === "OBJE" && r.xref === objeXref);
      if (oi !== -1) dataset.records.splice(oi, 1);
    }
  }
  bumpSourceCacheVersion(dataset.records);
}

const sourceCacheVersions = new WeakMap<GedNode[], number>();
const sourceCaches = new WeakMap<GedNode[], { version: number; media: MediaLinks; sourceCtx: SourceContext; noteIndex: NoteIndex }>();

/**
 * Bump `records`' media/source cache version, forcing the next
 * `getMediaAndSourceCtx` call to recompute instead of reusing the cached
 * indexes. Call this from any helper that adds/removes a top-level
 * `SOUR`/`OBJE`/`REPO` record, or changes an existing `OBJE`'s `FILE` value
 * in place (the only ways the cached indexes can go stale, since `sourceIndex`
 * holds live node references and tolerates in-place field edits like a
 * `SOUR`'s `TITL`/`AUTH`/etc.).
 */
export function bumpSourceCacheVersion(records: GedNode[]): void {
  sourceCacheVersions.set(records, (sourceCacheVersions.get(records) ?? 0) + 1);
}

/**
 * Lazily (re)build the shared media-link/source-citation indexes for
 * `records`, reusing the cached pair unless `bumpSourceCacheVersion` marked
 * it stale since the last build. These indexes only depend on the dataset's
 * top-level `SOUR`/`OBJE`/`REPO` records, which most edits (a name, an event,
 * a note, …) never touch, so recomputing them from scratch on every commit
 * was pure wasted work scaling with the whole file's size.
 */
export function getMediaAndSourceCtx(records: GedNode[]): { media: MediaLinks; sourceCtx: SourceContext; noteIndex: NoteIndex } {
  const version = sourceCacheVersions.get(records) ?? 0;
  const cached = sourceCaches.get(records);
  if (cached && cached.version === version) return cached;
  const fresh = { version, media: buildMediaLinks(records), sourceCtx: buildSourceContext(records), noteIndex: buildNoteIndex(records) };
  sourceCaches.set(records, fresh);
  return fresh;
}

/**
 * Re-derive the typed `Individual` from its (mutated) raw node and store it
 * back in `dataset.individuals`. Cheaper than rebuilding the whole dataset.
 */
export function rebuildIndividual(dataset: Dataset, indi: Individual): Individual {
  const { media, sourceCtx, noteIndex } = getMediaAndSourceCtx(dataset.records);
  const rebuilt = buildIndividual(indi.raw, media, sourceCtx, noteIndex);
  dataset.individuals.set(rebuilt.id, rebuilt);
  return rebuilt;
}

/**
 * Re-derive the typed `Family` from its (mutated) raw node and store it back
 * in `dataset.families`. Cheaper than rebuilding the whole dataset.
 */
export function rebuildFamily(dataset: Dataset, fam: Family): Family {
  const { media, sourceCtx, noteIndex } = getMediaAndSourceCtx(dataset.records);
  const rebuilt = buildFamily(fam.raw, media, sourceCtx, noteIndex);
  dataset.families.set(rebuilt.id, rebuilt);
  return rebuilt;
}
