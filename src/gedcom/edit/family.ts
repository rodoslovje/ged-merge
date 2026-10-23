import { birthParentFamilies } from "../couple";
import { birthSortKey } from "../lifespan";
import { cloneNode, mergeSubLines, nodeFingerprint, firstChild, hasChild } from "../node";
import type { Dataset, Family, GedNode, Individual, Sex } from "../types";
import { FAM_CHILD_ORDER, getOrCreateChild, INDI_CHILD_ORDER, insertOrdered, insertRecord, nextXref, recordPosition, removeChild, removeRecordsByXref } from "./shared";
import { bumpSourceCacheVersion, rebuildFamily, rebuildIndividual } from "./cache";
import { repointAssociations } from "../assoc";
import { isPointer } from "../uri";
import { clearObjeNodeCache } from "../source";
import { familiesScope, individualsScope, pointerScope, unindexRecord } from "./pointerIndex";

/** Add a `FAMC`/`FAMS` pointer from an individual to a family. */
function addFamilyLink(indi: Individual, tag: "FAMC" | "FAMS", famId: string): void {
  insertOrdered(indi.raw, { level: indi.raw.level + 1, tag, value: famId, children: [] }, INDI_CHILD_ORDER);
}

/** Set a family's `HUSB`/`WIFE` pointer to an individual. */
function setFamilySpouse(fam: Family, tag: "HUSB" | "WIFE", indiId: string): void {
  getOrCreateChild(fam.raw, tag, FAM_CHILD_ORDER).value = indiId;
}

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

/** The family that already records `aId` and `bId` as the couple, if there is
 *  one — what a second parent joining their child should be put into, rather
 *  than a fresh record naming the same two people. `exceptId` skips the family
 *  being filled in. */
function coupleFamily(dataset: Dataset, aId: string, bId: string, exceptId: string): Family | undefined {
  for (const fam of dataset.families.values()) {
    if (fam.id === exceptId) continue;
    if ((fam.husband === aId && fam.wife === bId) || (fam.husband === bId && fam.wife === aId)) return fam;
  }
  return undefined;
}

/** Whether `fam` is nothing more than the stub the previous "add parent" step
 *  left behind — one parent, `childId` as its only child, and no content of its
 *  own (no marriage, events, sources or notes) — so moving the child out and
 *  dropping it loses nothing. A family with other children or anything recorded
 *  about it is real, and is left alone even if it duplicates a couple. */
function isBareParentStub(fam: Family, childId: string): boolean {
  if (fam.children.length !== 1 || fam.children[0] !== childId) return false;
  return fam.raw.children.every((c) => c.tag === "HUSB" || c.tag === "WIFE" || c.tag === "CHIL");
}

/** Everyone `fromIds` descends from (`up`) or who descends from them (down),
 *  read from both sides of the links so a one-sided file is walked as well. */
function lineOf(dataset: Dataset, fromIds: (string | undefined)[], up: boolean): Set<string> {
  // The family side indexed once (a child's CHIL, a parent's HUSB/WIFE).
  const named = new Map<string, string[]>();
  for (const fam of dataset.families.values()) {
    for (const id of up ? fam.children : [fam.husband, fam.wife]) {
      if (!id) continue;
      const list = named.get(id);
      if (list) list.push(fam.id);
      else named.set(id, [fam.id]);
    }
  }
  const seen = new Set<string>();
  const queue = fromIds.filter((id): id is string => !!id);
  while (queue.length) {
    const id = queue.pop()!;
    const indi = dataset.individuals.get(id);
    const famIds = new Set([...((up ? indi?.childOf : indi?.spouseOf) ?? []), ...(named.get(id) ?? [])]);
    for (const famId of famIds) {
      const fam = dataset.families.get(famId);
      if (!fam) continue;
      for (const next of up ? [fam.husband, fam.wife] : fam.children) {
        if (next && !seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
  }
  return seen;
}

/**
 * The people who cannot be connected to `person` as this kind of relative —
 * the picker leaves them out and the connect refuses them. Connecting any of
 * them would write a structure no family can have: the same person as both
 * parents of one family, someone as their own ancestor (a descendant taken as
 * a parent, an ancestor taken as a child), or a child or parent taken as a
 * partner. `fam` is the family the relative joins, when there is one.
 */
export function impossibleRelatives(
  dataset: Dataset,
  person: Individual,
  kind: "father" | "mother" | "partner" | "child",
  fam: Family | undefined,
): Set<string> {
  const out = new Set<string>([person.id]);
  const add = (ids: Iterable<string | undefined>) => { for (const id of ids) if (id) out.add(id); };
  if (kind === "child") {
    // The child becomes the child of both spouses of the family.
    const parents = fam ? [fam.husband, fam.wife, person.id] : [person.id];
    add(parents);
    add(lineOf(dataset, parents, true));
    return out;
  }
  // A parent or partner becomes the parent of the family's children — of
  // `person` too, when the family is their birth family.
  const children = [...(fam?.children ?? []), ...(kind === "partner" ? [] : [person.id])];
  add(children);
  add(lineOf(dataset, children, false));
  if (fam && kind !== "partner") add([kind === "father" ? fam.wife : fam.husband]);
  if (kind === "partner") {
    for (const f of dataset.families.values()) {
      if (f.children.includes(person.id) || person.childOf.includes(f.id)) add([f.husband, f.wife]);
      if (f.husband === person.id || f.wife === person.id || person.spouseOf.includes(f.id)) add(f.children);
    }
  }
  return out;
}

/**
 * Connect an existing individual as a parent of `person`.
 * If `fam` is given (an existing parent family missing that role), the
 * individual fills its HUSB/WIFE slot; otherwise a new family is created.
 *
 * Naming the second parent completes a couple, and that couple may already have
 * a family of their own — the usual case being a child whose father was added a
 * moment ago, creating a stub, and whose mother turns out to be that father's
 * wife. Filling the stub would leave the pair recorded twice, so the child
 * joins the family they already have and the stub goes.
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
  if (!parent || impossibleRelatives(dataset, person, role, fam).has(parentId)) return;

  const otherParentId = fam ? (tag === "HUSB" ? fam.wife : fam.husband) : undefined;
  if (fam && otherParentId && otherParentId !== parentId && isBareParentStub(fam, person.id)) {
    const existing = coupleFamily(dataset, parentId, otherParentId, fam.id);
    if (existing) {
      // Drop the stub first: that unlinks the child's FAMC and the other
      // parent's FAMS to it, leaving only the pointers into the real family.
      removeFamily(dataset, fam);
      if (!existing.children.includes(person.id)) addFamilyChild(dataset, existing, person.id);
      if (!person.raw.children.some((c) => c.tag === "FAMC" && c.value === existing.id))
        addFamilyLink(person, "FAMC", existing.id);
      if (!parent.raw.children.some((c) => c.tag === "FAMS" && c.value === existing.id))
        addFamilyLink(parent, "FAMS", existing.id);
      rebuildFamily(dataset, existing);
      rebuildIndividual(dataset, person);
      rebuildIndividual(dataset, parent);
      return;
    }
  }

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
  if (!partner || impossibleRelatives(dataset, person, "partner", fam).has(partnerId)) return;

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
 *
 * A person is born into exactly one family, so joining this one means leaving
 * whichever birth family they were in: the child is detached from it (and it is
 * dropped if that leaves it below two members). Linking without detaching would
 * write a second `FAMC` — two sets of parents on one person, which the health
 * check flags as `multipleParents`. Adoptive and foster links are left alone,
 * being a legitimate second family. The caller confirms the move first — see
 * EditView's `connectRelative`.
 */
export function connectExistingChild(
  dataset: Dataset,
  person: Individual,
  childId: string,
  fam: Family | undefined,
): void {
  const child = dataset.individuals.get(childId);
  if (!child || impossibleRelatives(dataset, person, "child", fam).has(childId)) return;

  if (!fam) {
    fam = addFamily(dataset);
    setFamilySpouse(fam, person.sex === "F" ? "WIFE" : "HUSB", person.id);
    if (!person.raw.children.some((c) => c.tag === "FAMS" && c.value === fam!.id))
      addFamilyLink(person, "FAMS", fam.id);
    rebuildIndividual(dataset, person);
  }
  // Ids read up front: detaching splices the child's own FAMC lines.
  const leaving = birthParentFamilies(child, dataset)
    .map((f) => f.id)
    .filter((id) => id !== fam!.id);
  for (const id of leaving) {
    const old = dataset.families.get(id);
    if (old) detachChildFromFamily(dataset, old, childId);
  }

  if (!fam.children.includes(childId)) addFamilyChild(dataset, fam, childId);
  if (!child.raw.children.some((c) => c.tag === "FAMC" && c.value === fam!.id))
    addFamilyLink(child, "FAMC", fam.id);
  rebuildFamily(dataset, fam);
  rebuildIndividual(dataset, child);
}

/**
 * Remove a family that has fewer than two members — a lone spouse, a single
 * child, or nothing at all — *and* nothing recorded about it. A family needs at
 * least two members (a couple, or a parent/sibling group) to mean anything;
 * once a deletion or detach drops it below that, the now-meaningless `FAM`
 * record (which may still carry only CREA/CHAN stamps and empty `1 MARR`
 * stubs) is dropped via `removeFamily`, which also unlinks the `FAMS`/`FAMC`
 * pointer of any sole surviving member. Returns `true` if it was removed.
 *
 * A family that still carries content — a marriage date or place, a citation,
 * a note, a divorce — is kept with its one remaining member: the widow's
 * wedding is a fact about her, and the confirm dialog promised to remove the
 * deleted person's relationships, not the marriage record itself.
 */
export function pruneDegenerateFamily(dataset: Dataset, fam: Family): boolean {
  const memberCount = (fam.husband ? 1 : 0) + (fam.wife ? 1 : 0) + fam.children.length;
  if (memberCount >= 2) return false;
  if (!isBareFamily(fam)) return false;
  // Asked of both sides only now that the cheap count has said "too few": a
  // one-sided file can hold a child whose FAMC names the family no CHIL answers.
  if (familyMembers(dataset, fam).length >= 2) return false;
  removeFamily(dataset, fam);
  return true;
}

/** Whether the family record holds nothing beyond member pointers, its own
 *  record stamps and empty stub lines (`1 MARR` with nothing under it). */
function isBareFamily(fam: Family): boolean {
  return fam.raw.children.every(
    (c) =>
      c.tag === "HUSB" || c.tag === "WIFE" || c.tag === "CHIL" || RECORD_OWN_TAGS.has(c.tag) ||
      (!c.value && c.children.length === 0),
  );
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
 * leave a lone-member or empty `FAM` record behind.
 *
 * Every other line naming this person goes with them — an association, an
 * `ALIA`, `ANCI`/`DESI`, a vendor pointer, at any depth: a godparent the file no
 * longer holds cannot stay pointed at from the baptism, or every delete would
 * leave the health check a dangling reference to report. Callers snapshot the
 * holders with `recordsNaming`. */
export function removeIndividual(dataset: Dataset, indi: Individual): void {
  // The person's own FAMS/FAMC lines name their families — but a file can be
  // one-sided (a `CHIL` with no `FAMC` back-link, a `HUSB` without `FAMS`), and
  // a pointer left on such a family would dangle. So the family side is
  // scanned too.
  const affectedFamilyIds = new Set([...indi.spouseOf, ...indi.childOf, ...familiesNaming(dataset, indi.id)]);
  for (const id of repointAssociations(pointerScope(dataset, [indi.id]), indi.id)) {
    const named = dataset.individuals.get(id);
    if (named) rebuildIndividual(dataset, named);
    else {
      const fam = dataset.families.get(id);
      if (fam) rebuildFamily(dataset, fam);
    }
  }
  for (const famId of affectedFamilyIds) {
    const fam = dataset.families.get(famId);
    if (!fam) continue;
    fam.raw.children = fam.raw.children.filter(
      (c) => !((c.tag === "HUSB" || c.tag === "WIFE" || c.tag === "CHIL") && c.value === indi.id),
    );
    rebuildFamily(dataset, fam);
  }
  const ri = recordIndexOf(dataset.records, indi.raw, indi.id);
  if (ri !== -1) unindexRecord(dataset.records, dataset.records.splice(ri, 1)[0]);
  dataset.individuals.delete(indi.id);
  for (const famId of affectedFamilyIds) {
    const fam = dataset.families.get(famId);
    if (fam) pruneDegenerateFamily(dataset, fam);
  }
}

/** Where a person's or family's record sits — found by its node, from a
 *  remembered position (see `recordPosition`), or by its xref as before. */
function recordIndexOf(records: GedNode[], raw: GedNode, xref: string): number {
  if (raw.xref === xref) {
    const i = recordPosition(records, raw);
    if (i !== undefined) return i;
  }
  return records.findIndex((r) => r.xref === xref);
}

/** Shared records a deleted person can leave behind with nobody pointing at
 *  them. `SOUR` is among them as citation removal already treats it (see
 *  `pruneUnreferencedSource`); a `REPO` is an archive and always stays. */
const LEFT_BEHIND_TAGS = new Set(["NOTE", "SNOTE", "OBJE", "SOUR"]);

/** Every pointer value held at any depth below `node`. */
export function pointersHeld(node: GedNode, into = new Set<string>()): Set<string> {
  for (const child of node.children) {
    const v = child.value?.trim();
    if (v && isPointer(v)) into.add(v);
    pointersHeld(child, into);
  }
  return into;
}

/**
 * Delete the shared NOTE/SNOTE/OBJE/SOUR records among `candidates` (the
 * pointers a just-deleted person held) that nothing points at any more, and in
 * turn those only a deleted record pointed at — a note's photo, a source's page
 * image. A record's pointer to itself doesn't keep it. Returns the removed
 * records in removal order, for the caller's undo patches.
 */
export function pruneRecordsLeftBehind(dataset: Dataset, candidates: Iterable<string>): GedNode[] {
  const records = dataset.records;
  const removed: GedNode[] = [];
  let pending = new Set(candidates);
  while (pending.size) {
    const referenced = new Set<string>();
    for (const rec of records) for (const v of pointersHeld(rec)) if (v !== rec.xref && pending.has(v)) referenced.add(v);
    const next = new Set<string>();
    // Taken out in one walk of the list, reported in the order asked.
    const order = [...pending].filter((xref) => !referenced.has(xref));
    const out = removeRecordsByXref(records, order, (r) => LEFT_BEHIND_TAGS.has(r.tag));
    const rank = new Map(order.map((xref, i) => [xref, i]));
    out.sort((a, b) => rank.get(a.xref!)! - rank.get(b.xref!)!);
    for (const rec of out) {
      removed.push(rec);
      pointersHeld(rec, next);
    }
    pending = next;
  }
  if (removed.length) {
    bumpSourceCacheVersion(records);
    clearObjeNodeCache(records);
  }
  return removed;
}

/** Families whose HUSB/WIFE/CHIL lines name `indiId`, whether or not the
 *  person's own record links back to them. */
export function familiesNaming(dataset: Dataset, indiId: string): string[] {
  const ids: string[] = [];
  for (const fam of familiesScope(dataset, [indiId])) {
    if (fam.husband === indiId || fam.wife === indiId || fam.children.includes(indiId)) ids.push(fam.id);
  }
  return ids;
}

/** Everyone the family holds, read from both sides: the people its HUSB/WIFE/CHIL
 *  lines name, and the people whose own FAMS/FAMC lines name it — a one-sided
 *  file can carry either half without the other. */
export function familyMembers(dataset: Dataset, fam: Family): string[] {
  const ids = new Set([fam.husband, fam.wife, ...fam.children].filter((id): id is string => !!id));
  for (const indi of individualsScope(dataset, [fam.id])) {
    if (indi.childOf.includes(fam.id) || indi.spouseOf.includes(fam.id)) ids.add(indi.id);
  }
  return [...ids];
}

/** Fully remove a family from the dataset, cleaning up the FAMS/FAMC pointers
 *  of every record naming it — its listed members and any back-linked only. */
export function removeFamily(dataset: Dataset, fam: Family): void {
  for (const indiId of familyMembers(dataset, fam)) {
    const indi = dataset.individuals.get(indiId);
    if (!indi) continue;
    const kept = indi.raw.children.filter((c) => !((c.tag === "FAMS" || c.tag === "FAMC") && c.value === fam.id));
    if (kept.length === indi.raw.children.length) continue;
    indi.raw.children = kept;
    rebuildIndividual(dataset, indi);
  }
  const ri = recordIndexOf(dataset.records, fam.raw, fam.id);
  if (ri !== -1) unindexRecord(dataset.records, dataset.records.splice(ri, 1)[0]);
  dataset.families.delete(fam.id);
}

/** Lines that belong to the record they sit on, not to the family it describes:
 *  change stamps and record identifiers. A fold leaves the kept record's own
 *  and does not carry the dropped record's over. */
export const RECORD_OWN_TAGS = new Set(["CHAN", "CREA", "_UPD", "RIN", "_UID", "UID"]);

/**
 * Merge family `dropId` into family `keepId` and remove it — for two records
 * of the same couple, whichever way they came about (a duplicate person
 * merged, or a partner added twice by hand).
 *
 * Nothing recorded is lost: the dropped family's children join the kept one in
 * birth order, an empty spouse slot is filled from it, and every other line —
 * marriage and other events, notes, sources, media, custom tags — moves across
 * unless the kept record already holds an identical line, or holds the tag and
 * the line is an empty stub (`1 MARR` with nothing under it). Only the dropped
 * record's own change stamps and identifiers stay behind. Every member's
 * `FAMS`/`FAMC` pointers end up on the kept family alone.
 */
export function foldFamily(dataset: Dataset, keepId: string, dropId: string): void {
  const keep = dataset.families.get(keepId);
  const drop = dataset.families.get(dropId);
  if (!keep || !drop || keepId === dropId) return;

  for (const childId of [...drop.children]) {
    // Asked of the record, not of the typed list: the list is rebuilt only
    // after the loop, so a child listed twice in the dropped family would
    // otherwise be written twice into the kept one.
    // The link's qualifiers (`_FREL`/`_MREL` on the CHIL line, `PEDI` on the
    // child's FAMC) move with it: an adoption is not a birth on the kept record.
    const pointer = (record: GedNode, tag: string, id: string) =>
      record.children.find((c) => c.tag === tag && c.value === id);
    const dropChil = pointer(drop.raw, "CHIL", childId);
    if (pointer(keep.raw, "CHIL", childId)) continue;
    addFamilyChild(dataset, keep, childId);
    if (dropChil) mergeSubLines(pointer(keep.raw, "CHIL", childId)!, dropChil);
    const child = dataset.individuals.get(childId);
    if (child && !pointer(child.raw, "FAMC", keepId)) {
      addFamilyLink(child, "FAMC", keepId);
      const dropFamc = pointer(child.raw, "FAMC", dropId);
      if (dropFamc) mergeSubLines(pointer(child.raw, "FAMC", keepId)!, dropFamc);
      rebuildIndividual(dataset, child);
    }
  }

  for (const role of ["HUSB", "WIFE"] as const) {
    if (hasChild(keep.raw, role)) continue;
    const spouseId = firstChild(drop.raw, role)?.value;
    if (!spouseId) continue;
    setFamilySpouse(keep, role, spouseId);
    const spouse = dataset.individuals.get(spouseId);
    if (spouse && !spouse.raw.children.some((c) => c.tag === "FAMS" && c.value === keepId)) {
      addFamilyLink(spouse, "FAMS", keepId);
      rebuildIndividual(dataset, spouse);
    }
  }

  // Compared on what the line says, not on the object: a node also carries
  // this session's own annotations (an edit stamp, a note of what the line was
  // reshaped from), and a marriage the user happened to edit before merging is
  // the same marriage the other record holds.
  const have = new Set(keep.raw.children.map(nodeFingerprint));
  for (const line of drop.raw.children) {
    if (line.tag === "HUSB" || line.tag === "WIFE" || line.tag === "CHIL") continue;
    if (RECORD_OWN_TAGS.has(line.tag)) continue;
    if (have.has(nodeFingerprint(line))) continue;
    const stub = !line.value && line.children.length === 0;
    if (stub && hasChild(keep.raw, line.tag)) continue;
    insertOrdered(keep.raw, cloneNode(line), FAM_CHILD_ORDER);
  }

  // A person a one-sided file links to the dropped family from their own side
  // only (a FAMC the family never lists) moves with it too: removeFamily would
  // otherwise unlink them, and they would lose their parents or their marriage.
  for (const id of familyMembers(dataset, drop)) {
    const indi = dataset.individuals.get(id);
    if (!indi) continue;
    let moved = false;
    for (const line of indi.raw.children) {
      if ((line.tag !== "FAMC" && line.tag !== "FAMS") || line.value !== dropId) continue;
      const kept = indi.raw.children.find((c) => c.tag === line.tag && c.value === keepId);
      if (kept) mergeSubLines(kept, line);
      else { line.value = keepId; moved = true; }
    }
    if (moved) rebuildIndividual(dataset, indi);
  }

  // Every other line naming the dropped family — an `ASSO @F2@`, an adoption's
  // `FAMC` under its event, a vendor `_` pointer — names the kept one now, the
  // two records being one family. A line left pointing at its own record (the
  // kept family's association with its twin) goes.
  const repoint = (record: GedNode, node: GedNode, depth: number): boolean => {
    let changed = false;
    const kept: GedNode[] = [];
    for (const child of node.children) {
      const memberLine = record.tag === "INDI" && depth === 0 && (child.tag === "FAMC" || child.tag === "FAMS");
      if (!memberLine && child.value?.trim() === dropId) {
        changed = true;
        if (record.xref === keepId) continue;
        child.value = keepId;
      }
      changed = repoint(record, child, depth + 1) || changed;
      kept.push(child);
    }
    if (changed) node.children = kept;
    return changed;
  };
  for (const record of pointerScope(dataset, [dropId])) {
    if ((record.tag !== "INDI" && record.tag !== "FAM") || record.xref === dropId || !repoint(record, record, 0)) continue;
    const indi = dataset.individuals.get(record.xref!);
    const fam = dataset.families.get(record.xref!);
    if (indi) rebuildIndividual(dataset, indi);
    else if (fam && fam !== keep) rebuildFamily(dataset, fam);
  }

  rebuildFamily(dataset, keep);
  removeFamily(dataset, drop); // unlinks every member's FAMS/FAMC to the dropped record
}

/** The people and families holding a line that names one of `famIds`, at any
 *  depth — every record a {@link foldFamily} of those families can rewrite
 *  beyond the families' own members, for a caller's undo snapshot. */
export function familyPointerHolders(records: Iterable<GedNode>, famIds: ReadonlySet<string>): string[] {
  const names = (node: GedNode): boolean =>
    node.children.some((c) => (c.value !== undefined && famIds.has(c.value.trim())) || names(c));
  const out: string[] = [];
  for (const r of records) if ((r.tag === "INDI" || r.tag === "FAM") && r.xref && names(r)) out.push(r.xref);
  return out;
}
