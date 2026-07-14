import { childrenByTag } from "../node";
import type { GedNode, Individual, Sex } from "../types";
import { getOrCreateChild, INDI_CHILD_ORDER, insertOrdered, NAME_CHILD_ORDER, removeChild, setOrRemoveValue } from "./shared";

/**
 * Keep a NAME node's `GIVN`/`SURN` sub-tag in sync with the edited name *only
 * when the file already carries it* (MacFamilyTree and similar write these
 * structured parts alongside the slash value). Updating in place stops them
 * going stale and contradicting the edited name, while not adding a sub-tag to
 * files that never had one keeps the output in the source's house style — and
 * avoids sprinkling GIVN/SURN onto slash-form-only files. An emptied part is
 * removed (a bare `GIVN`/`SURN` is meaningless).
 */
function syncNamePart(node: GedNode, tag: "GIVN" | "SURN", value: string): void {
  if (!node.children.some((c) => c.tag === tag)) return;
  setOrRemoveValue(node, tag, value, NAME_CHILD_ORDER);
}

/**
 * Write `given`/`surname` into a NAME node's slash-form value. The slash value
 * is the source of truth (it's what `parseName` reads first); any existing
 * `GIVN`/`SURN` sub-tags are updated to match so they can't drift out of sync.
 */
function writeNameValue(node: GedNode, given: string, surname: string): void {
  // `/` is the slash-form's surname delimiter and has no escape in GEDCOM —
  // a part containing one would corrupt the value ("Janez/Ivan /Novak/" reads
  // back with surname "Ivan "). Replace it with a space to keep the name legible.
  const g = given.replace(/\s*\/\s*/g, " ").trim();
  const s = surname.replace(/\s*\/\s*/g, " ").trim();
  node.value = s ? `${g} /${s}/`.trim() : g;
  syncNamePart(node, "GIVN", g);
  syncNamePart(node, "SURN", s);
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
 * main file follows the `_MARNM` convention. */
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
 * married-surname sub-tag — used when the main follows the `_MARNM` convention
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
