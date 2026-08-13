import type { Dataset, GedNode } from "../gedcom/types";
import { rebuildFamily, rebuildIndividual } from "../gedcom/edit";
import { cloneRaw, type RecordPatch } from "../ui/historyTypes";

/**
 * One-button repair for the "Duplicate pointers" health-check category.
 *
 * Purely subtractive, like `fixBrokenLinks`: it drops redundant pointer lines
 * that repeat an xref already present on the same record — a `FAMC`/`FAMS`
 * listed twice on an individual, or a `CHIL` listed twice on a family. Common in
 * merged exports. The first occurrence (with any subordinate lines) is kept; the
 * later duplicate line is removed, so no relationship is lost.
 *
 * Mutates the dataset in place and returns `RecordPatch[]` for the undo stack.
 */

/** Remove every `tag` child of `node` whose pointer value was already seen on an
 *  earlier `tag` child — keeping the first occurrence. Returns whether it changed. */
function dedupeRefs(node: GedNode, tag: string): boolean {
  const seen = new Set<string>();
  const before = node.children.length;
  node.children = node.children.filter((c) => {
    if (c.tag !== tag || c.value === undefined) return true;
    if (seen.has(c.value)) return false;
    seen.add(c.value);
    return true;
  });
  return node.children.length !== before;
}

/** @param only — de-duplicate just this record (its row's own button), instead
 *  of every record with repeated pointers. */
export function fixDuplicatePointers(dataset: Dataset, only?: string): RecordPatch[] {
  const patches: RecordPatch[] = [];

  for (const indi of dataset.individuals.values()) {
    if (only && indi.id !== only) continue;
    const before = cloneRaw(indi.raw);
    let changed = dedupeRefs(indi.raw, "FAMC");
    changed = dedupeRefs(indi.raw, "FAMS") || changed;
    if (changed) {
      rebuildIndividual(dataset, indi);
      patches.push({ type: "individual", id: indi.id, before, after: cloneRaw(indi.raw) });
    }
  }

  for (const fam of dataset.families.values()) {
    if (only && fam.id !== only) continue;
    const before = cloneRaw(fam.raw);
    if (dedupeRefs(fam.raw, "CHIL")) {
      rebuildFamily(dataset, fam);
      patches.push({ type: "family", id: fam.id, before, after: cloneRaw(fam.raw) });
    }
  }

  return patches;
}
