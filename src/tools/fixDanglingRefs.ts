import type { Dataset, GedNode } from "../gedcom/types";
import { rebuildFamily, rebuildIndividual } from "../gedcom/edit";
import { cloneRaw, type RecordPatch } from "../ui/historyTypes";
import { isFamilyLinkPointer, isPointerValue } from "./structure";

/**
 * One-button repair for the "Dangling references" structural finding.
 *
 * Purely subtractive, like `fixBrokenLinks`: it drops pointer lines whose
 * target record isn't in the file — a `SOUR`/`NOTE`/`OBJE` citation, an
 * `ASSO`/`ALIA` link, or a family link nested below the record's own level (an
 * `ADOP`'s `FAMC`). The line goes with whatever hangs off it: a citation's
 * `PAGE`/`QUAY` qualify the citation, and a pointer that resolves to nothing
 * leaves them nothing to qualify.
 *
 * Two classes of pointer are deliberately out of scope:
 *  - **Family links on an INDI/FAM** — `fixBrokenLinks` owns those (see
 *    {@link isFamilyLinkPointer}), so the two fixes never touch the same line
 *    and each button's count is its own.
 *  - **Pointers on a record with no xref** (`HEAD.SUBM`) — an undo patch is
 *    keyed by xref, so repairing one couldn't be undone. It stays reported.
 *
 * Vendor-extension (`_`) subtrees are skipped, matching `findDanglingXrefs`:
 * their values follow the vendor's vocabulary, not ours to prune.
 *
 * Mutates the dataset in place and returns `RecordPatch[]` for the undo stack.
 */

/** The xrefs defined by the file — every pointer to something outside this set
 *  is dangling. */
function definedXrefs(records: GedNode[]): Set<string> {
  const defined = new Set<string>();
  for (const r of records) if (r.xref) defined.add(r.xref);
  return defined;
}

/** Walk one record, visiting every dangling pointer line this fix would remove.
 *  `depth` is the GEDCOM level of `node`'s children. */
function eachDangling(
  node: GedNode,
  depth: number,
  recordTag: string | undefined,
  defined: Set<string>,
  visit: (child: GedNode) => void,
): void {
  for (const child of node.children) {
    if (child.tag.startsWith("_")) continue;
    if (
      isPointerValue(child.value) &&
      !defined.has(child.value.trim()) &&
      !isFamilyLinkPointer(recordTag, child.tag, depth)
    ) {
      visit(child);
      continue; // the whole subtree goes with the line; nothing below to report
    }
    eachDangling(child, depth + 1, recordTag, defined, visit);
  }
}

/** How many distinct missing xrefs this fix would drop pointers to — the count
 *  on its button, matching the "Dangling references" findings it can repair. */
export function countDanglingRefs(dataset: Dataset): number {
  const defined = definedXrefs(dataset.records);
  const xrefs = new Set<string>();
  for (const rec of dataset.records) {
    if (!rec.xref) continue;
    eachDangling(rec, 1, rec.tag, defined, (child) => xrefs.add(child.value!.trim()));
  }
  return xrefs.size;
}

/** One finding's own pointers: the record it sits on, and (when the row names
 *  one) the single missing xref it points at. */
export interface DanglingRef {
  id: string;
  xref?: string;
}

/** @param only — drop just the pointers one finding names (its row's own
 *  button), instead of every dangling pointer in the file. */
export function fixDanglingRefs(dataset: Dataset, only?: DanglingRef): RecordPatch[] {
  const defined = definedXrefs(dataset.records);
  const patches: RecordPatch[] = [];

  for (const rec of dataset.records) {
    if (!rec.xref) continue;
    if (only && rec.xref !== only.id) continue;
    const doomed = new Set<GedNode>();
    eachDangling(rec, 1, rec.tag, defined, (child) => {
      if (only?.xref && child.value?.trim() !== only.xref) return;
      doomed.add(child);
    });
    if (doomed.size === 0) continue;

    const before = cloneRaw(rec);
    const drop = (node: GedNode): void => {
      node.children = node.children.filter((c) => !doomed.has(c));
      for (const child of node.children) drop(child);
    };
    drop(rec);

    const indi = dataset.individuals.get(rec.xref);
    const fam = dataset.families.get(rec.xref);
    if (indi) {
      rebuildIndividual(dataset, indi);
      patches.push({ type: "individual", id: rec.xref, before, after: cloneRaw(rec) });
    } else if (fam) {
      rebuildFamily(dataset, fam);
      patches.push({ type: "family", id: rec.xref, before, after: cloneRaw(rec) });
    } else {
      patches.push({ type: "record", id: rec.xref, before, after: cloneRaw(rec) });
    }
  }
  return patches;
}
