import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { buildFanChart, type FanChart, type FanSegment, type FanShape } from "../chart/fanLayout";
import { buildDescendantFanChart } from "../chart/descendantFan";
import type { TreeMode, TreeNode } from "../chart/personTree";
import { ageStandalone, livingLabelFor, type NodeDisplayOptions } from "../chart/nodeDisplay";

// Shared wiring for the radial (fan / circle) chart type in the Edit and
// Compare trees: build the FanChart from the (prebuilt) tree of the current
// direction and adapt its segments to the `{key, x, y}` shape useTreeCanvas
// and the detail panel consume. The hosts differ only in how they resolve
// photos, kinship and badges — everything geometric lives here once.

export interface FanChartState {
  fan: FanChart | undefined;
  /** Segments keyed for canvas selection (they carry key/x/y like tree nodes). */
  nodes: Map<string, FanSegment>;
  /** Layout envelope for useTreeCanvas: the root segment + full extent. */
  laid: { root: FanSegment; width: number; height: number } | undefined;
}

export function useFanChart(
  /** The tree to draw — ancestors or descendants, as `mode` says; pass
   *  undefined while the type isn't radial. */
  tree: TreeNode | undefined,
  shape: FanShape,
  opts: {
    /** Which direction `tree` fans out in (defaults to ancestors). */
    mode?: TreeMode;
    /** Whether a node has a photo file (reserves the inner-ring photo slot). */
    hasPhoto: (n: TreeNode) => boolean;
    display: NodeDisplayOptions;
    /** Kinship label shown in place of a redacted living person's name. */
    kinshipOf?: (n: TreeNode) => string | undefined;
  },
): FanChartState {
  const { mode = "ancestors", hasPhoto, display, kinshipOf } = opts;
  const { t } = useTranslation();
  const livingLabelOf = useCallback((n: TreeNode) => livingLabelFor(t, n.sex), [t]);
  const ageTextOf = useCallback((n: TreeNode) => (n.age !== undefined ? ageStandalone(t, n.sex, n.age) : undefined), [t]);
  const fan = useMemo(() => {
    if (!tree) return undefined;
    const build = mode === "descendants" ? buildDescendantFanChart : buildFanChart;
    return build(tree, shape, { hasPhoto, display, livingLabelOf, ageTextOf, kinshipOf });
  }, [tree, mode, shape, hasPhoto, display, livingLabelOf, ageTextOf, kinshipOf]);
  const nodes = useMemo(() => {
    const m = new Map<string, FanSegment>();
    for (const s of fan?.segments ?? []) m.set(s.key, s);
    return m;
  }, [fan]);
  const laid = useMemo(
    () =>
      fan
        ? { root: nodes.get(fan.rootKey) ?? fan.segments[0], width: fan.width, height: fan.height }
        : undefined,
    [fan, nodes],
  );
  return { fan, nodes, laid };
}
