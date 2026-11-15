import type { Dataset, GedNode } from "../gedcom/types";
import { rebuildFamily, rebuildIndividual } from "../gedcom/edit";
import { VOID_XREF } from "../gedcom/assoc";
import { versionFamily, voidAsNote, voidCitation } from "../normalize/migrate";
import { cloneNode } from "../gedcom/node";
import { type RecordPatch } from "../ui/historyTypes";
import { takesPointerAt } from "./conformance/allows";
import { isFamilyLinkPointer, isPointerValue } from "./structure";

/**
 * One-button repair for the "Dangling references" structural finding: pointer
 * lines whose target record isn't in the file — a `SOUR`/`NOTE`/`OBJE`
 * citation, an `ASSO`/`ALIA` link, a `REPO` on a source, or a family link
 * nested below the record's own level (an `ADOP`'s `FAMC`).
 *
 * It repairs rather than deletes wherever the pointer carries detail (lines
 * of its own beneath it — a citation's `PAGE`, an association's `ROLE`):
 *  - **7.0** — the pointer becomes `@VOID@`, the standard's "a record this
 *    file does not hold", and every line beneath it stays.
 *  - **5.5.1** — a citation becomes a text citation (`voidCitation`: its
 *    `PAGE` is the text, its transcript the `TEXT`), an association a note
 *    (`voidAsNote`: what it says about the associate, then the role), and a
 *    repository citation keeps its call number with no pointer — the same
 *    forms the 7.0 → 5.5.1 conversion writes for `@VOID@`.
 * A pointer with no detail, a 5.5.1 one with no such form (a `NOTE @N1@`
 * names nothing to inline), and a 7.0 line whose payload isn't a pointer
 * (`NOTE @N1@` is text there) are removed, with the lines beneath them.
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
 * Idempotent: what it leaves names no missing record (`@VOID@` and a text
 * value are not pointers). Mutates the dataset in place and returns
 * `RecordPatch[]` for the undo stack.
 */

/** The xrefs defined by the file — every pointer to something outside this set
 *  is dangling. */
function definedXrefs(records: GedNode[]): Set<string> {
  const defined = new Set<string>();
  for (const r of records) if (r.xref) defined.add(r.xref);
  return defined;
}

/** One dangling pointer line, with where it sits. */
interface Dangling {
  node: GedNode;
  parent: GedNode;
  /** Tags from the record down to the line's own: `["INDI", "BIRT", "SOUR"]`. */
  path: string[];
}

/** Walk one record, visiting every dangling pointer line in pre-order — a
 *  dangling line's own subtree too, since a repair may keep it. `depth` is the
 *  GEDCOM level of `node`'s children; `path` the tags down to `node`. */
function eachDangling(
  node: GedNode,
  depth: number,
  recordTag: string | undefined,
  path: string[],
  defined: Set<string>,
  visit: (d: Dangling) => void,
): void {
  for (const child of node.children) {
    if (child.tag.startsWith("_")) continue;
    path.push(child.tag);
    if (
      isPointerValue(child.value) &&
      !defined.has(child.value.trim()) &&
      !isFamilyLinkPointer(recordTag, child.tag, depth)
    ) {
      visit({ node: child, parent: node, path: [...path] });
    }
    eachDangling(child, depth + 1, recordTag, path, defined, visit);
    path.pop();
  }
}

/** How many distinct missing xrefs this fix would repair or drop pointers to —
 *  the count on its button, matching the "Dangling references" findings it can
 *  repair. */
export function countDanglingRefs(dataset: Dataset): number {
  const defined = definedXrefs(dataset.records);
  const xrefs = new Set<string>();
  for (const rec of dataset.records) {
    if (!rec.xref) continue;
    eachDangling(rec, 1, rec.tag, [rec.tag], defined, ({ node }) => xrefs.add(node.value!.trim()));
  }
  return xrefs.size;
}

/** One finding's own pointers: the record it sits on, and (when the row names
 *  one) the single missing xref it points at. */
export interface DanglingRef {
  id: string;
  xref?: string;
}

/** Repair one dangling line in place; false when it has to go instead. */
function repair({ node, path }: Dangling, v70: boolean): boolean {
  if (node.children.length === 0) return false;
  if (v70) {
    if (!takesPointerAt("7.0", path)) return false;
    node.value = VOID_XREF;
    return true;
  }
  switch (node.tag) {
    case "SOUR": return voidCitation(node) !== undefined;
    case "REPO": delete node.value; return true;
    default: return false;
  }
}

/** @param only — repair just the pointers one finding names (its row's own
 *  button), instead of every dangling pointer in the file. */
export function fixDanglingRefs(dataset: Dataset, only?: DanglingRef): RecordPatch[] {
  const defined = definedXrefs(dataset.records);
  const v70 = versionFamily(dataset.version) === "7.0";
  const patches: RecordPatch[] = [];

  for (const rec of dataset.records) {
    if (!rec.xref) continue;
    if (only && rec.xref !== only.id) continue;
    const found: Dangling[] = [];
    eachDangling(rec, 1, rec.tag, [rec.tag], defined, (d) => {
      if (only?.xref && d.node.value?.trim() !== only.xref) return;
      found.push(d);
    });
    if (found.length === 0) continue;

    const before = cloneNode(rec);
    // Deepest first: a kept citation's own dangling media link is settled
    // before the citation asks whether it still carries detail.
    for (const d of found.reverse()) {
      const at = d.parent.children.indexOf(d.node);
      if (at === -1) continue;
      if (!v70 && d.node.tag === "ASSO") {
        const note = d.node.children.length ? voidAsNote(d.node) : undefined;
        if (note) d.parent.children[at] = note;
        else d.parent.children.splice(at, 1);
      } else if (!repair(d, v70)) {
        d.parent.children.splice(at, 1);
      }
    }

    const indi = dataset.individuals.get(rec.xref);
    const fam = dataset.families.get(rec.xref);
    if (indi) {
      rebuildIndividual(dataset, indi);
      patches.push({ type: "individual", id: rec.xref, before, after: cloneNode(rec) });
    } else if (fam) {
      rebuildFamily(dataset, fam);
      patches.push({ type: "family", id: rec.xref, before, after: cloneNode(rec) });
    } else {
      patches.push({ type: "record", id: rec.xref, before, after: cloneNode(rec) });
    }
  }
  return patches;
}
