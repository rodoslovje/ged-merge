import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { buildFanChart, type FanChart, type FanSegment, type FanShape } from "../chart/fanLayout";
import { buildDescendantFanChart } from "../chart/descendantFan";
import { buildButterflyChart } from "../chart/butterflyFan";
import type { TreeNode } from "../chart/personTree";
import type { SiblingRow } from "../chart/siblingRow";
import type { ChartDirection } from "../chart/treeLayout";
import { ageStandalone, livingLabelFor, type NodeDisplayOptions } from "../chart/nodeDisplay";
import { useLivingNameOf, type LivingNameOf } from "./useLivingName";

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
  /** The tree to draw — ancestors or descendants, as `mode` says (the
   *  ancestors when `mode` is "both"); pass undefined while the type isn't
   *  radial. */
  tree: TreeNode | undefined,
  shape: FanShape,
  opts: {
    /** Which direction `tree` fans out in (defaults to ancestors); "both"
     *  draws the radial bowtie — `tree` above, `other` below. */
    mode?: ChartDirection;
    /** The descendants, for "both". */
    other?: TreeNode;
    /** The root's brothers and sisters, drawn in the notches of "both". */
    siblings?: SiblingRow;
    /** Whether a node has a photo file (reserves the inner-ring photo slot). */
    hasPhoto: (n: TreeNode) => boolean;
    display: NodeDisplayOptions;
    /** Kinship label shown in place of a redacted living person's name. */
    kinshipOf?: (n: TreeNode) => string | undefined;
    /** The view's own naming of the living, in place of the privacy setting's. */
    livingNameOf?: LivingNameOf;
  },
): FanChartState {
  const { mode = "ancestors", other, siblings, hasPhoto, display, kinshipOf } = opts;
  const { t } = useTranslation();
  const livingLabelOf = useCallback((n: TreeNode) => livingLabelFor(t, n.sex), [t]);
  const ageTextOf = useCallback((n: TreeNode) => (n.age !== undefined ? ageStandalone(t, n.sex, n.age) : undefined), [t]);
  const livingNameOfIndi = useLivingNameOf(opts.livingNameOf);
  const livingNameOf = useCallback((n: TreeNode) => livingNameOfIndi(n.main ?? n.incoming), [livingNameOfIndi]);
  const fan = useMemo(() => {
    if (!tree) return undefined;
    const o = { hasPhoto, display, livingLabelOf, ageTextOf, kinshipOf, livingNameOf };
    if (mode === "both" && other) return buildButterflyChart(tree, other, o, siblings);
    const build = mode === "descendants" ? buildDescendantFanChart : buildFanChart;
    return build(tree, shape, o);
  }, [tree, other, siblings, mode, shape, hasPhoto, display, livingLabelOf, ageTextOf, kinshipOf, livingNameOf]);
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
