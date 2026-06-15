import { buildFamily, buildIndividual, buildMediaLinks } from "./builder";
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
const INDI_CHILD_ORDER = [
  "NAME", "SEX",
  "BIRT", "CHR", "BAPM", "DEAT", "BURI", "CREM", "RESI",
  "FAMC", "FAMS",
  "WWW", "URL", "_URL", "_WEBTAG", "OBJE", "NOTE", "SOUR",
];

/** Canonical top-level field order within a FAM record. */
const FAM_CHILD_ORDER = [
  "HUSB", "WIFE", "CHIL",
  "MARR", "ENGA", "MARB", "MARL", "DIV",
  "WWW", "URL", "_URL", "_WEBTAG", "OBJE", "NOTE", "SOUR",
];

/** Canonical sub-tag order within a `NAME` node. */
const NAME_CHILD_ORDER = ["NPFX", "GIVN", "NICK", "SPFX", "SURN", "NSFX", "TYPE", "NOTE", "SOUR"];

/** Links attached to an event are plain `WWW` lines. */
const EVENT_LINK_TAG = "WWW";

export interface EventFieldUpdate {
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
function insertOrdered(parent: GedNode, child: GedNode, order: string[]): void {
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

/**
 * Update an event's date, place, address and/or links — finding (or
 * creating) the event subtree, e.g. `1 BIRT`/`1 MARR` with `2 DATE`/`2 PLAC`/
 * `2 ADDR`/`2 WWW` children. Fields set to `""`/`[]` remove the corresponding
 * lines; an event left with no children and no value is removed entirely.
 */
function setRecordEventField(record: GedNode, tag: string, update: EventFieldUpdate, order: string[]): void {
  let event = findChild(record, tag);

  const hasContent =
    !!update.date?.trim() || !!update.place?.trim() || !!update.address?.trim() ||
    !!update.links?.some((l) => l.trim());
  if (!event) {
    if (!hasContent) return;
    event = { level: record.level + 1, tag, children: [] };
    insertOrdered(record, event, order);
  }

  if (update.date !== undefined) setOrRemoveValue(event, "DATE", update.date, EVENT_CHILD_ORDER);
  if (update.place !== undefined) setOrRemoveValue(event, "PLAC", update.place, EVENT_CHILD_ORDER);
  if (update.address !== undefined) setOrRemoveValue(event, "ADDR", update.address, EVENT_CHILD_ORDER);
  if (update.links !== undefined) setLinks(event, update.links);

  if (event.children.length === 0 && event.value === undefined) removeChild(record, tag);
}

/** Update an individual event's date, place, address and/or links — see
 * `setRecordEventField`. */
export function setEventField(indi: Individual, tag: string, update: EventFieldUpdate): void {
  setRecordEventField(indi.raw, tag, update, INDI_CHILD_ORDER);
}

/** Update a family event's (e.g. `1 MARR`) date, place, address and/or
 * links — see `setRecordEventField`. */
export function setFamilyEventField(fam: Family, tag: string, update: EventFieldUpdate): void {
  setRecordEventField(fam.raw, tag, update, FAM_CHILD_ORDER);
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
