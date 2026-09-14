import type { Dataset, Family } from "../gedcom/types";
import { foldFamily } from "../gedcom/edit";
import { patchesFromSnapshots, snapshotRecords, type RecordPatch } from "../ui/historyTypes";
import { duplicateFamilyGroups } from "./validate";

/**
 * One-button repair for the "Same couple twice" health-check category.
 *
 * Each couple recorded in more than one family keeps a single family record:
 * the others are folded into it by `foldFamily` — children, events, notes and
 * sources carried across, nothing dropped but the redundant record itself —
 * and every member's `FAMS`/`FAMC` pointers end up on the one family. The
 * record kept is the fullest of the group (the most lines), so the least moves;
 * on a tie the first in file order.
 *
 * Mutates the dataset in place and returns `RecordPatch[]` for the undo stack,
 * diffed from snapshots so the cascade (the dropped record, every member's
 * pointer lines) is captured whatever it touched.
 */

/** The family to keep out of one group: the fullest, then the first. */
function fullest(group: Family[]): Family {
  return group.reduce((best, fam) => (fam.raw.children.length > best.raw.children.length ? fam : best));
}

/** @param only — fold just the families of this person (the finding's row),
 *  instead of every duplicated couple in the file. */
export function fixDuplicateFamilies(dataset: Dataset, only?: string): RecordPatch[] {
  const groups = duplicateFamilyGroups(dataset).filter(
    (g) => !only || g[0].husband === only || g[0].wife === only,
  );
  if (!groups.length) return [];

  const famIds = new Set<string>();
  const indiIds = new Set<string>();
  for (const group of groups) {
    for (const fam of group) {
      famIds.add(fam.id);
      indiIds.add(fam.husband!);
      indiIds.add(fam.wife!);
      for (const child of fam.children) indiIds.add(child);
    }
  }
  const before = snapshotRecords(dataset, indiIds, famIds);

  for (const group of groups) {
    const keep = fullest(group);
    for (const fam of group) {
      if (fam.id !== keep.id) foldFamily(dataset, keep.id, fam.id);
    }
  }

  return patchesFromSnapshots(dataset, before);
}
