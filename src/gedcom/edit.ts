import { buildFamily, buildIndividual, buildMediaLinks, INDI_EVENT_TAGS } from "./builder";
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
const EVENT_CHILD_ORDER = [
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
const NAME_CHILD_ORDER = ["NPFX", "GIVN", "NICK", "SPFX", "SURN", "NSFX", "TYPE", "NOTE", "SOUR"];

/** Links attached to an event are plain `WWW` lines. */
const EVENT_LINK_TAG = "WWW";

export interface EventFieldUpdate {
  /** New direct value on the event line (e.g. occupation text), or `""` to remove. */
  value?: string;
  /** New DATE value, or `""` to remove the date. Omit to leave unchanged. */
  date?: string;
  /** New PLAC value, or `""` to remove the place. Omit to leave unchanged. */
  place?: string;
  /** New ADDR value, or `""` to remove the address. Omit to leave unchanged. */
  address?: string;
  /** New set of links, replacing all existing ones. `[]` removes them all. */
  links?: string[];
}

function findChild(node: GedNode, tag: string): GedNode | undefined {
  return node.children.find((c) => c.tag === tag);
}

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
  let child = findChild(node, tag);
  if (!child) {
    child = { level: node.level + 1, tag, children: [] };
    insertOrdered(node, child, order);
  }
  return child;
}

/** Set `node`'s `tag` child to `value`, or remove it when `value` is blank. */
function setOrRemoveValue(node: GedNode, tag: string, value: string, order: string[]): void {
  const trimmed = value.trim();
  if (!trimmed) {
    removeChild(node, tag);
    return;
  }
  getOrCreateChild(node, tag, order).value = trimmed;
}

function setLinks(event: GedNode, links: string[]): void {
  event.children = event.children.filter((c) => c.tag !== EVENT_LINK_TAG);
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
function applyEventNodeUpdate(record: GedNode, eventNode: GedNode, update: EventFieldUpdate): void {
  if (update.value !== undefined) eventNode.value = update.value.trim() || undefined;
  if (update.date !== undefined) setOrRemoveValue(eventNode, "DATE", update.date, EVENT_CHILD_ORDER);
  if (update.place !== undefined) setOrRemoveValue(eventNode, "PLAC", update.place, EVENT_CHILD_ORDER);
  if (update.address !== undefined) setOrRemoveValue(eventNode, "ADDR", update.address, EVENT_CHILD_ORDER);
  if (update.links !== undefined) setLinks(eventNode, update.links);
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
function setRecordEventField(record: GedNode, tag: string, update: EventFieldUpdate, order: string[]): void {
  let event = findChild(record, tag);
  const hasContent =
    !!update.value?.trim() || !!update.date?.trim() || !!update.place?.trim() ||
    !!update.address?.trim() || !!update.links?.some((l) => l.trim());
  if (!event) {
    if (!hasContent) return;
    event = { level: record.level + 1, tag, children: [] };
    insertOrdered(record, event, order);
  }
  applyEventNodeUpdate(record, event, update);
}

/** Update an individual event's date, place, address and/or links — see
 * `setRecordEventField`. */
export function setEventField(indi: Individual, tag: string, update: EventFieldUpdate): void {
  setRecordEventField(indi.raw, tag, update, INDI_CHILD_ORDER);
}

/** Update an individual event at position `index` in `indi.events` (0-based). */
export function setEventFieldAtIndex(indi: Individual, index: number, update: EventFieldUpdate): void {
  const eventNodes = indi.raw.children.filter((c) => INDI_EVENT_TAGS.has(c.tag));
  const eventNode = eventNodes[index];
  if (eventNode) applyEventNodeUpdate(indi.raw, eventNode, update);
}

/** Append a new empty event node for `tag` to an individual record, inserting
 * it after the last existing event of the same tag (or in canonical order). */
export function addEventNode(indi: Individual, tag: string): void {
  const same = indi.raw.children.filter((c) => c.tag === tag);
  const event: GedNode = { level: indi.raw.level + 1, tag, children: [] };
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

/** Append a new empty family event node for `tag`. */
export function addFamilyEventNode(fam: Family, tag: string): void {
  const event: GedNode = { level: fam.raw.level + 1, tag, children: [] };
  insertOrdered(fam.raw, event, FAM_CHILD_ORDER);
}

/** Set (or clear) the individual's primary `NAME` line. */
export function setName(indi: Individual, name: { given?: string; surname?: string }): void {
  const record = indi.raw;
  const given = (name.given ?? "").trim();
  const surname = (name.surname ?? "").trim();
  const value = surname ? `${given} /${surname}/`.trim() : given;

  if (!value) {
    removeChild(record, "NAME");
    return;
  }
  const node = getOrCreateChild(record, "NAME", INDI_CHILD_ORDER);
  node.value = value;
  // The slash-form value is now the source of truth; drop stale sub-tags.
  node.children = node.children.filter((c) => c.tag !== "GIVN" && c.tag !== "SURN");
}

function nameNodes(indi: Individual): GedNode[] {
  return indi.raw.children.filter((c) => c.tag === "NAME");
}

/** Set (or clear) the primary `NAME`'s `NICK` (nickname) sub-tag. */
export function setNickname(indi: Individual, nickname: string): void {
  const node = nameNodes(indi)[0];
  if (!node) return;
  setOrRemoveValue(node, "NICK", nickname, NAME_CHILD_ORDER);
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
    node.value = surname ? `${given} /${surname}/`.trim() : given;
    node.children = node.children.filter((c) => c.tag !== "GIVN" && c.tag !== "SURN");
  }
  if (update.type !== undefined) setOrRemoveValue(node, "TYPE", update.type, NAME_CHILD_ORDER);
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

/** Append a new top-level record just before `TRLR` (or at the end, if there's none). */
export function insertRecord(records: GedNode[], record: GedNode): void {
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
function addFamilyChild(fam: Family, childId: string): void {
  insertOrdered(fam.raw, { level: fam.raw.level + 1, tag: "CHIL", value: childId, children: [] }, FAM_CHILD_ORDER);
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
    addFamilyChild(fam, person.id);
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
  addFamilyChild(fam, child.id);
  addFamilyLink(child, "FAMC", fam.id);
  rebuildFamily(dataset, fam);
  return rebuildIndividual(dataset, child);
}

/** Tags used for record-level links (top-level on INDI/FAM records). */
const RECORD_LINK_TAGS = ["WWW", "URL", "_URL", "_WEBTAG"];

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
  rebuildFamily(dataset, fam);
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
  rebuildFamily(dataset, fam);
}

/** Fully remove an individual from the dataset, cleaning up all family pointers. */
export function removeIndividual(dataset: Dataset, indi: Individual): void {
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
  indi.raw.children = indi.raw.children.filter((c) => c.tag !== "NOTE");
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

/**
 * Re-derive the typed `Individual` from its (mutated) raw node and store it
 * back in `dataset.individuals`. Cheaper than rebuilding the whole dataset.
 */
export function rebuildIndividual(dataset: Dataset, indi: Individual): Individual {
  const media = buildMediaLinks(dataset.records);
  const rebuilt = buildIndividual(indi.raw, media);
  dataset.individuals.set(rebuilt.id, rebuilt);
  return rebuilt;
}

/**
 * Re-derive the typed `Family` from its (mutated) raw node and store it back
 * in `dataset.families`. Cheaper than rebuilding the whole dataset.
 */
export function rebuildFamily(dataset: Dataset, fam: Family): Family {
  const media = buildMediaLinks(dataset.records);
  const rebuilt = buildFamily(fam.raw, media);
  dataset.families.set(rebuilt.id, rebuilt);
  return rebuilt;
}
