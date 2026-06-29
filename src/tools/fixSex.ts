import type { Dataset, Sex } from "../gedcom/types";
import { rebuildIndividual, setSex } from "../gedcom/edit";
import { cloneRaw, type RecordPatch } from "../ui/historyTypes";

/**
 * One-button repair for the "No sex" health-check category: infer an unknown
 * `SEX` from a person's family role.
 *
 * Additive and conservative — it only *fills in* `SEX U`, never overrides a
 * recorded value (so it can't introduce a `roleSexConflict`). A person linked as
 * a family's `HUSB` is set male, a `WIFE` female. If the same `SEX U` person is
 * linked with conflicting roles across different families (a `HUSB` here, a
 * `WIFE` there), the inference is ambiguous and they're left untouched.
 *
 * Mutates the dataset in place and returns `RecordPatch[]` for the undo stack,
 * following the same convention as `fixBrokenLinks`.
 */

/**
 * Map each `SEX U` individual to the sex implied by their family role, dropping
 * anyone whose roles disagree. Shared by the count (for the button label) and
 * the fix itself so the two can never diverge.
 */
function collectInferences(dataset: Dataset): Map<string, Sex> {
  const inferred = new Map<string, Sex>();
  const conflicted = new Set<string>();

  const consider = (id: string | undefined, sex: Sex) => {
    if (!id || conflicted.has(id)) return;
    const indi = dataset.individuals.get(id);
    if (!indi || indi.sex !== "U") return;
    const prev = inferred.get(id);
    if (prev && prev !== sex) {
      inferred.delete(id);
      conflicted.add(id);
      return;
    }
    inferred.set(id, sex);
  };

  for (const fam of dataset.families.values()) {
    consider(fam.husband, "M");
    consider(fam.wife, "F");
  }
  return inferred;
}

/** How many `SEX U` individuals have a sex unambiguously implied by family role. */
export function countInferableSex(dataset: Dataset): number {
  return collectInferences(dataset).size;
}

export function fixSexFromRole(dataset: Dataset): RecordPatch[] {
  const patches: RecordPatch[] = [];
  for (const [id, sex] of collectInferences(dataset)) {
    const indi = dataset.individuals.get(id);
    if (!indi) continue;
    const before = cloneRaw(indi.raw);
    setSex(indi, sex);
    rebuildIndividual(dataset, indi);
    patches.push({ type: "individual", id, before, after: cloneRaw(indi.raw) });
  }
  return patches;
}
