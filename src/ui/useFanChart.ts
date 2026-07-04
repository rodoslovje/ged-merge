import { useMemo } from "react";
import { buildFanChart, type FanChart, type FanShape } from "../tree/fanLayout";
import type { TreeNode } from "../tree/compareTree";
import type { NodeDisplayOptions } from "../tree/nodeDisplay";
import type { Placed } from "../tree/treeLayout";

// Shared wiring for the radial (fan / circle) chart type in the Edit and
// Compare trees: build the FanChart from the (prebuilt) ancestors tree and
// adapt its segments to the `{key, x, y}` shape useTreeCanvas and the detail
// panel consume. The hosts differ only in how they resolve photos, kinship
// and badges — everything geometric lives here once.

export interface FanChartState {
  fan: FanChart | undefined;
  /** Segments keyed for canvas selection (they carry key/x/y like tree nodes). */
  nodes: Map<string, Placed>;
  /** Layout envelope for useTreeCanvas: the root segment + full extent. */
  laid: { root: Placed; width: number; height: number } | undefined;
}

export function useFanChart(
  /** The ancestors tree to draw; pass undefined while the type isn't radial. */
  tree: TreeNode | undefined,
  shape: FanShape,
  opts: {
    /** Whether a node has a photo file (reserves the inner-ring photo slot). */
    hasPhoto: (n: TreeNode) => boolean;
    display: NodeDisplayOptions;
    livingLabel: string;
    /** Kinship label shown in place of a redacted living person's name. */
    kinshipOf?: (n: TreeNode) => string | undefined;
  },
): FanChartState {
  const { hasPhoto, display, livingLabel, kinshipOf } = opts;
  const fan = useMemo(
    () => (tree ? buildFanChart(tree, shape, { hasPhoto, display, livingLabel, kinshipOf }) : undefined),
    [tree, shape, hasPhoto, display, livingLabel, kinshipOf],
  );
  const nodes = useMemo(() => {
    const m = new Map<string, Placed>();
    for (const s of fan?.segments ?? []) m.set(s.key, s as unknown as Placed);
    return m;
  }, [fan]);
  const laid = useMemo(
    () =>
      fan
        ? { root: (nodes.get(fan.rootKey) ?? fan.segments[0]) as unknown as Placed, width: fan.width, height: fan.height }
        : undefined,
    [fan, nodes],
  );
  return { fan, nodes, laid };
}
