import { birthSortKey } from "../lifespan";
import type { Dataset, Family, GedNode, Individual, Sex } from "../types";
import { FAM_CHILD_ORDER, getOrCreateChild, INDI_CHILD_ORDER, insertOrdered, insertRecord, nextXref, removeChild } from "./shared";
import { rebuildFamily, rebuildIndividual } from "./cache";

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
 * to it for editing. `sexOverride` lets the caller pick the new parent's `SEX`
 * — e.g. a second father in a same-sex couple filling the `WIFE` slot —
 * instead of the role-implied default.
 */
export function addParent(dataset: Dataset, person: Individual, fam: Family | undefined, role: "father" | "mother", sexOverride?: Sex): Individual {
  const sex: Sex = sexOverride ?? (role === "father" ? "M" : "F");
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
 * `sexOverride` lets the caller pick the new partner's `SEX` — e.g. a same-sex
 * partner — instead of defaulting to the opposite of `person`.
 */
export function addPartner(dataset: Dataset, person: Individual, fam: Family | undefined, sexOverride?: Sex): Individual {
  const personTag: "HUSB" | "WIFE" = fam ? (fam.husband === person.id ? "HUSB" : "WIFE") : person.sex === "F" ? "WIFE" : "HUSB";
  const partnerTag: "HUSB" | "WIFE" = personTag === "HUSB" ? "WIFE" : "HUSB";
  const partner = addIndividual(dataset, sexOverride ?? (partnerTag === "HUSB" ? "M" : "F"));

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
 * Returns the new individual so the caller can navigate to it. `sexOverride`
 * lets the caller set the new child's `SEX` at creation instead of leaving it
 * unknown.
 */
export function addChild(dataset: Dataset, person: Individual, fam: Family | undefined, sexOverride?: Sex): Individual {
  const child = addIndividual(dataset, sexOverride ?? "U");

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
