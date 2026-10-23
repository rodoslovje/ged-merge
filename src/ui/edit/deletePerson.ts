import type { Dataset, Individual } from "../../gedcom/types";
import { recordsNaming } from "../../gedcom/assoc";
import { familiesNaming, familyMembers, pointersHeld, pruneRecordsLeftBehind, removeIndividual } from "../../gedcom/edit";
import { patchesFromSnapshots, snapshotRecords, type RecordPatch } from "../historyTypes";

/**
 * Delete `person` from the dataset and return the undo patches for everything
 * the delete touched: the person, their families and those families' members
 * (a family pruned for dropping below two members unlinks its survivors too),
 * every record whose line named the person (stripped by `removeIndividual`),
 * and the shared notes, media and sources only the person pointed at, which
 * go with them.
 */
export function deletePerson(dataset: Dataset, person: Individual): RecordPatch[] {
  const personId = person.id;
  // The family side too: a one-sided file can name the person in a family
  // their own record does not link back to.
  const affectedFamilyIds = [...new Set([...person.spouseOf, ...person.childOf, ...familiesNaming(dataset, personId)])];
  const memberIds = new Set<string>([personId]);
  for (const famId of affectedFamilyIds) {
    const fam = dataset.families.get(famId);
    if (fam) for (const m of familyMembers(dataset, fam)) memberIds.add(m);
  }
  // `snapshotRecords` ignores an id that is not an individual (or not a
  // family), so each list gets the whole set.
  const naming = recordsNaming(dataset.records, new Set([personId]));
  for (const id of naming) memberIds.add(id);
  const before = snapshotRecords(dataset, memberIds, new Set([...affectedFamilyIds, ...naming]));
  // Positions before anything moves: every deletion patch of the batch is
  // indexed against the same file, so undo's ascending re-insert is exact.
  const position = new Map<string, number>();
  dataset.records.forEach((r, i) => { if (r.xref) position.set(r.xref, i); });
  const held = pointersHeld(person.raw);

  removeIndividual(dataset, person);

  const patches = patchesFromSnapshots(dataset, before);
  for (const rec of pruneRecordsLeftBehind(dataset, held)) {
    const index = position.get(rec.xref!);
    patches.push({ type: "record", id: rec.xref!, before: rec, after: null, ...(index !== undefined ? { index } : {}) });
  }
  return patches;
}
