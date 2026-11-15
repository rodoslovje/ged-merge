import type { Dataset, GedNode } from "../gedcom/types";
import { cloneNode } from "../gedcom/node";
import { recordsNaming, repointAssociations } from "../gedcom/assoc";
import {
  pointersHeld,
  pruneDegenerateFamily,
  pruneRecordsLeftBehind,
  rebuildFamily,
  rebuildIndividual,
  recordsLeftBehind,
  removeRecordsByXref,
} from "../gedcom/edit";
import { patchesFromSnapshots, snapshotRecords, type RecordPatch } from "../ui/historyTypes";
import { applyPassSafely, keepSnapshots } from "./passSafety";

/**
 * What deleting a group of people takes with it — asked before the delete, so
 * the confirmation can say how much goes, and handed to {@link removeBranch}.
 */
export interface BranchRemovalPlan {
  /** The people deleted (those of the asked ids the file holds). */
  people: string[];
  /** Families whose every member is among them — deleted whole. */
  families: string[];
  /** Families that also hold someone else: they only lose the deleted
   *  members (and go if that leaves a bare family of one). */
  sharedFamilies: string[];
  /** People outside the group in those shared families, read from both
   *  sides — a pruned family unlinks them. */
  outsideMembers: string[];
  /** Other people and families naming one of the deleted at any depth (an
   *  `ASSO`, an `ALIA`, a vendor pointer) — the line goes. */
  naming: string[];
  /** Every pointer the deleted records held: the shared records among them
   *  that nothing else uses go too. */
  held: Set<string>;
  /** Those shared notes, media and sources, in removal order. */
  leftBehind: GedNode[];
}

/**
 * Plan deleting `personIds` — a detached branch, as the health check finds
 * it. A few walks of the file whatever the branch's size: deleting the people
 * one by one would walk it once per person.
 */
export function planBranchRemoval(dataset: Dataset, personIds: Iterable<string>): BranchRemovalPlan {
  const people = new Set([...personIds].filter((id) => dataset.individuals.has(id)));
  const famIds = new Set<string>();
  for (const id of people) {
    const indi = dataset.individuals.get(id)!;
    for (const famId of [...indi.spouseOf, ...indi.childOf]) if (dataset.families.has(famId)) famIds.add(famId);
  }
  // A one-sided file can name a person in a family their own record does not
  // link back to.
  for (const fam of dataset.families.values()) {
    if ((fam.husband && people.has(fam.husband)) || (fam.wife && people.has(fam.wife)) || fam.children.some((c) => people.has(c))) {
      famIds.add(fam.id);
    }
  }
  // Who else each family holds: its own member lines, and anyone outside the
  // group whose FAMS/FAMC names it.
  const outside = new Map<string, Set<string>>();
  const addOutside = (famId: string, id: string) => {
    let set = outside.get(famId);
    if (!set) outside.set(famId, (set = new Set()));
    set.add(id);
  };
  for (const famId of famIds) {
    const fam = dataset.families.get(famId)!;
    for (const id of [fam.husband, fam.wife, ...fam.children]) if (id && !people.has(id)) addOutside(famId, id);
  }
  for (const indi of dataset.individuals.values()) {
    if (people.has(indi.id)) continue;
    for (const famId of [...indi.spouseOf, ...indi.childOf]) if (famIds.has(famId)) addOutside(famId, indi.id);
  }
  const families = [...famIds].filter((id) => !outside.has(id));
  const sharedFamilies = [...famIds].filter((id) => outside.has(id));
  const outsideMembers = [...new Set([...outside.values()].flatMap((s) => [...s]))];

  const naming = recordsNaming(dataset.records, people).filter((id) => !famIds.has(id) || outside.has(id));
  const held = new Set<string>();
  for (const id of people) pointersHeld(dataset.individuals.get(id)!.raw, held);
  for (const id of families) pointersHeld(dataset.families.get(id)!.raw, held);
  const leftBehind = recordsLeftBehind(dataset.records, held, new Set([...people, ...families]));
  return { people: [...people], families, sharedFamilies, outsideMembers, naming, held, leftBehind };
}

/**
 * Delete everyone in `personIds` from the file, with their families, every
 * line elsewhere naming one of them, and the shared notes, media and sources
 * only they used — in one pass, returning the undo patches for all of it as
 * one step. Deleted records carry their position, so undo puts each back
 * where it stood.
 */
export function removeBranch(dataset: Dataset, personIds: Iterable<string>): RecordPatch[] {
  const plan = planBranchRemoval(dataset, personIds);
  if (!plan.people.length) return [];
  const people = new Set(plan.people);
  const records = dataset.records;

  // Positions before anything moves: every deletion patch of the batch is
  // indexed against the same file, so undo's ascending re-insert is exact.
  const position = new Map<string, number>();
  records.forEach((r, i) => { if (r.xref && !position.has(r.xref)) position.set(r.xref, i); });
  const gone: RecordPatch[] = [];
  const deleted = (type: RecordPatch["type"], id: string, before: GedNode) => {
    const index = position.get(id);
    gone.push({ type, id, before, after: null, ...(index !== undefined ? { index } : {}) });
  };
  for (const id of plan.people) deleted("individual", id, cloneNode(dataset.individuals.get(id)!.raw));
  for (const id of plan.families) deleted("family", id, cloneNode(dataset.families.get(id)!.raw));

  // The records that stay but change: snapshotted, diffed afterwards.
  const keptIndis = new Set(plan.outsideMembers);
  const keptFams = new Set(plan.sharedFamilies);
  for (const id of plan.naming) (dataset.individuals.has(id) ? keptIndis : keptFams).add(id);
  const before = snapshotRecords(dataset, keptIndis, keptFams);

  let removedShared: GedNode[] = [];
  applyPassSafely(dataset, (journal) => {
    keepSnapshots(journal, before);
    const changed = new Set<string>();
    const namingNodes = plan.naming
      .map((id) => dataset.individuals.get(id)?.raw ?? dataset.families.get(id)?.raw)
      .filter((n): n is GedNode => !!n);
    for (const id of people) for (const c of repointAssociations(namingNodes, id)) changed.add(c);
    for (const famId of plan.sharedFamilies) {
      const fam = dataset.families.get(famId)!;
      fam.raw.children = fam.raw.children.filter(
        (c) => !((c.tag === "HUSB" || c.tag === "WIFE" || c.tag === "CHIL") && !!c.value && people.has(c.value)),
      );
      changed.add(famId);
    }
    for (const id of changed) {
      const indi = dataset.individuals.get(id);
      if (indi) rebuildIndividual(dataset, indi);
      else {
        const fam = dataset.families.get(id);
        if (fam) rebuildFamily(dataset, fam);
      }
    }

    removeRecordsByXref(records, [...plan.people, ...plan.families], (r) => r.tag === "INDI" || r.tag === "FAM");
    for (const id of plan.people) dataset.individuals.delete(id);
    for (const id of plan.families) dataset.families.delete(id);

    for (const famId of plan.sharedFamilies) {
      const fam = dataset.families.get(famId);
      if (fam) pruneDegenerateFamily(dataset, fam);
    }
    removedShared = pruneRecordsLeftBehind(dataset, plan.held);
  });

  const patches = patchesFromSnapshots(dataset, before);
  patches.push(...gone);
  for (const rec of removedShared) {
    const index = position.get(rec.xref!);
    patches.push({ type: "record", id: rec.xref!, before: rec, after: null, ...(index !== undefined ? { index } : {}) });
  }
  return patches;
}
