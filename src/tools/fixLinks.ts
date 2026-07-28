import type { Dataset, GedNode } from "../gedcom/types";
import { rebuildFamily, rebuildIndividual } from "../gedcom/edit";
import { cloneRaw, type RecordPatch } from "../ui/historyTypes";

/**
 * One-button repair for the "Broken links" health-check category.
 *
 * Purely subtractive: it removes pointer lines that no longer describe a valid,
 * mutual relationship — never invents one. Two kinds of broken pointer are
 * dropped, mirroring `validateDataset`'s `brokenLink` findings:
 *
 *  - **Dangling** — `FAMC`/`FAMS` on an individual (or `HUSB`/`WIFE`/`CHIL` on a
 *    family) whose target xref isn't in the dataset.
 *  - **Non-reciprocal** — the target exists but doesn't point back, so the link
 *    is a one-way claim. Removing it leaves the surviving side intact.
 *
 * Mutates the dataset in place and returns `RecordPatch[]` for the undo stack,
 * following the same convention as `applyPlaceRename`.
 *
 * Runs over the whole file (the "Fix all broken links" button) or over a single
 * pointer (`only`), which is what a health-check finding's own fix button uses —
 * the finding names one record and one dead target, and repairs just that.
 */

/** One broken pointer: the record carrying it, and the xref it points at. */
export interface BrokenLinkRef {
  /** Record the pointer line sits on — an individual or a family. */
  id: string;
  /** Pointer target xref; omitted, every broken pointer on the record goes. */
  target?: string;
}

/** Remove every `tag` child of `node` whose pointer value is in `deadValues`. */
function pruneRefs(node: GedNode, tag: string, deadValues: Set<string>): boolean {
  const before = node.children.length;
  node.children = node.children.filter((c) => !(c.tag === tag && c.value !== undefined && deadValues.has(c.value)));
  return node.children.length !== before;
}

export function fixBrokenLinks(dataset: Dataset, only?: BrokenLinkRef): RecordPatch[] {
  const patches: RecordPatch[] = [];
  /** Is this broken pointer in scope — i.e. the one the caller asked for? */
  const inScope = (recordId: string, target: string) =>
    !only || (only.id === recordId && (only.target === undefined || only.target === target));

  for (const indi of dataset.individuals.values()) {
    if (only && only.id !== indi.id) continue;
    const deadFamc = new Set<string>();
    const deadFams = new Set<string>();

    for (const famId of indi.childOf) {
      const fam = dataset.families.get(famId);
      if ((!fam || !fam.children.includes(indi.id)) && inScope(indi.id, famId)) deadFamc.add(famId);
    }
    for (const famId of indi.spouseOf) {
      const fam = dataset.families.get(famId);
      if ((!fam || (fam.husband !== indi.id && fam.wife !== indi.id)) && inScope(indi.id, famId)) deadFams.add(famId);
    }
    if (deadFamc.size === 0 && deadFams.size === 0) continue;

    const before = cloneRaw(indi.raw);
    let changed = pruneRefs(indi.raw, "FAMC", deadFamc);
    changed = pruneRefs(indi.raw, "FAMS", deadFams) || changed;
    if (changed) {
      rebuildIndividual(dataset, indi);
      patches.push({ type: "individual", id: indi.id, before, after: cloneRaw(indi.raw) });
    }
  }

  for (const fam of dataset.families.values()) {
    if (only && only.id !== fam.id) continue;
    const deadSpouses = new Set<string>();
    const deadChildren = new Set<string>();

    for (const ref of [fam.husband, fam.wife]) {
      if (ref && !dataset.individuals.has(ref) && inScope(fam.id, ref)) deadSpouses.add(ref);
    }
    for (const childId of fam.children) {
      if (!dataset.individuals.has(childId) && inScope(fam.id, childId)) deadChildren.add(childId);
    }
    if (deadSpouses.size === 0 && deadChildren.size === 0) continue;

    const before = cloneRaw(fam.raw);
    let changed = pruneRefs(fam.raw, "HUSB", deadSpouses);
    changed = pruneRefs(fam.raw, "WIFE", deadSpouses) || changed;
    changed = pruneRefs(fam.raw, "CHIL", deadChildren) || changed;
    if (changed) {
      rebuildFamily(dataset, fam);
      patches.push({ type: "family", id: fam.id, before, after: cloneRaw(fam.raw) });
    }
  }

  return patches;
}
