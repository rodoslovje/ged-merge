// The root's own generation for the radial bowtie: brothers and sisters, and
// half-siblings through either parent, split at the root into the older and
// the younger.

import type { Dataset, Individual } from "../gedcom/types";
import { birthSortKey } from "../gedcom/lifespan";
import { familiesByMarriage } from "../gedcom/familySort";
import type { Translate } from "../locales/i18n";
import { emptyDataset } from "../gedcom/builder";
import { treeBuilder, type NameFormatter, type TreeNode } from "./personTree";

/** Which parent a half-sibling shares with the root. */
export type HalfVia = "father" | "mother";

export interface Sibling {
  node: TreeNode;
  /** Set on a half-sibling: the parent they share with the root. */
  half?: HalfVia;
}

export interface SiblingRow {
  /** Born before the root, oldest first. */
  older: Sibling[];
  /** Born after the root, nearest first. */
  younger: Sibling[];
}

interface Found {
  indi: Individual;
  half?: HalfVia;
}

/** One file's siblings of `root`, in the families' own child order — full
 *  siblings first, then each parent's other unions. The root is kept in the
 *  list, so the caller knows where it stands among them. */
function siblingsIn(root: Individual, ds: Dataset): Found[] {
  const out: Found[] = [];
  const seen = new Set<string>();
  const push = (id: string, half?: HalfVia) => {
    if (seen.has(id)) return;
    const indi = ds.individuals.get(id);
    if (!indi) return;
    seen.add(id);
    out.push({ indi, half });
  };
  const own = root.childOf.map((id) => ds.families.get(id)).filter((f) => f !== undefined);
  for (const fam of own) for (const c of fam.children) push(c);
  push(root.id);
  for (const fam of own) {
    for (const [role, via] of [["husband", "father"], ["wife", "mother"]] as const) {
      const parent = fam[role] ? ds.individuals.get(fam[role]!) : undefined;
      if (!parent) continue;
      for (const other of familiesByMarriage(ds, parent.spouseOf)) {
        if (root.childOf.includes(other.id)) continue;
        for (const c of other.children) push(c, via);
      }
    }
  }
  return out;
}

/** Birth order with the undated kept where the family lists them: an undated
 *  child borrows the date of the dated one before it, so a stable sort leaves
 *  it right after that sibling. */
function birthOrder<T extends { indi: Individual }>(list: T[]): T[] {
  let last = -Infinity;
  const keyed = list.map((x, i) => {
    const k = birthSortKey(x.indi);
    if (Number.isFinite(k)) last = k;
    return { x, k: Number.isFinite(k) ? k : last, i };
  });
  return keyed.sort((a, b) => a.k - b.k || a.i - b.i).map((e) => e.x);
}

/** The root's brothers and sisters in the main file, split at the root. */
export function buildSiblingRow(t: Translate, root: Individual, ds: Dataset, nameOf?: NameFormatter): SiblingRow {
  const { place } = treeBuilder(t, ds, emptyDataset(), { mainToCompare: new Map(), compareToMain: new Map() }, undefined, nameOf);
  const ordered = birthOrder(siblingsIn(root, ds));
  const at = ordered.findIndex((f) => f.indi === root);
  const pick = (list: Found[]): Sibling[] =>
    list.map(({ indi, half }) => ({ node: place(indi)!.node, ...(half ? { half } : null) }));
  return { older: pick(ordered.slice(0, at)), younger: pick(ordered.slice(at + 1)) };
}
