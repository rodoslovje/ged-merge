import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { emptyDataset } from "../gedcom/builder";
import type { Dataset } from "../gedcom/types";
import { buildPersonTree, pruneTree, type TreeNode } from "../chart/personTree";
import { indexPositions, type BranchInfo, type NodePosition } from "../chart/nodeColor";
import { useNameOf } from "./SettingsContext";
import { marriedNameOverride, useChartSettings } from "./ChartSettingsContext";

// Empty compare side for the tree builder (see EditTree); module-level so its
// identity is stable in memo deps.
const EMPTY_DS = emptyDataset();
const EMPTY_MAPS = { mainToCompare: new Map<string, string>(), compareToMain: new Map<string, string>() };

export interface BloodTrees {
  ancestors?: TreeNode;
  descendants?: TreeNode;
  /** Generation and family line per tree position; descendant keys carry a
   *  `d:` prefix, so a person in both trees keeps both positions. */
  positions: Map<string, NodePosition>;
  /** The family lines found — a grandparent's above, a child's below. */
  branches: Map<string, BranchInfo>;
}

/**
 * The root's ancestor and descendant trees as far as the Generations setting
 * reaches, with the family-line positions the Color setting reads — shared by
 * the Timeline's two layouts.
 */
export function useBloodTrees(ds: Dataset, rootId: string): BloodTrees {
  const { t } = useTranslation();
  const { settings } = useChartSettings();
  const nameOf = useNameOf(marriedNameOverride(settings.showMarriedName));
  const limit = settings.maxGenerations;
  return useMemo(() => {
    const root = ds.individuals.get(rootId);
    const build = (mode: "ancestors" | "descendants") => {
      if (!root) return undefined;
      const tree = buildPersonTree(t, root, undefined, ds, EMPTY_DS, EMPTY_MAPS, mode, undefined, nameOf);
      return limit === null ? tree : pruneTree(tree, limit);
    };
    const ancestors = build("ancestors");
    const descendants = build("descendants");
    const a = indexPositions(ancestors, "ancestors");
    const d = indexPositions(descendants, "descendants", "d:", a.positions, a.branches);
    return { ancestors, descendants, positions: d.positions, branches: d.branches };
  }, [t, ds, rootId, nameOf, limit]);
}

/** Each person's first position in the trees, by id — for a chart that draws
 *  a person once (the Timeline's bars), the ancestor side first. */
export function positionsById(trees: BloodTrees): Map<string, NodePosition> {
  const out = new Map<string, NodePosition>();
  const walk = (n: TreeNode | undefined, prefix: string) => {
    if (!n) return;
    const pos = trees.positions.get(prefix + n.key);
    if (n.main && pos && !out.has(n.main.id)) out.set(n.main.id, pos);
    n.children.forEach((c) => walk(c, prefix));
    n.partners.forEach((p) => walk(p, prefix));
  };
  walk(trees.ancestors, "");
  walk(trees.descendants, "d:");
  return out;
}
