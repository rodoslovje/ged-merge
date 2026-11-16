import type { ChartDirection } from "../chart/treeLayout";
import type { ChartKind, ChartSettings } from "../ui/ChartSettingsContext";

/**
 * A chart's view as words in the family website's address, after the chart
 * kind: `#/c/<person>/tree/grid/ancestors`, `#/c/<person>/kin/surnames/all`.
 * A default is left out (the tidy tree, the fan, both directions, the list
 * report, the wheel, contemporaries), so the plainest view has the plainest
 * address, and an address opens exactly the view it names.
 */

/** The chart settings an address carries. */
export type ChartViewSettings = Pick<ChartSettings, "treeLayout" | "fanShape" | "reportNarrative" | "kinLayout" | "kinScope">;

export interface ChartView {
  settings: Partial<ChartViewSettings>;
  direction: ChartDirection;
}

/** The kinds that draw ancestors, descendants or both. */
const DIRECTED: readonly string[] = ["tree", "fan", "map", "report"];
const DIRECTIONS: readonly string[] = ["ancestors", "descendants"];
const KIN_LAYOUTS: readonly string[] = ["surnames", "bars", "map"];

/** The words for a kind's current view, defaults left out. */
export function chartViewWords(kind: ChartKind, s: ChartViewSettings, direction: ChartDirection): string[] {
  const out: string[] = [];
  if (kind === "tree" && s.treeLayout === "grid") out.push("grid");
  if (kind === "fan" && s.fanShape === "circle") out.push("circle");
  if (kind === "report" && s.reportNarrative) out.push("narrative");
  if (kind === "kin") {
    if (s.kinLayout !== "wheel") out.push(s.kinLayout);
    if (s.kinScope === "all") out.push("all");
  }
  if (DIRECTED.includes(kind) && direction !== "both") out.push(direction);
  return out;
}

/** The view an address's words name for a kind: every setting the kind has,
 *  its default where the address says nothing. Unknown words are ignored. */
export function chartViewOf(kind: ChartKind, words: readonly string[]): ChartView {
  const has = (w: string) => words.includes(w);
  const settings: Partial<ChartViewSettings> = {};
  if (kind === "tree") settings.treeLayout = has("grid") ? "grid" : "tidy";
  if (kind === "fan") settings.fanShape = has("circle") ? "circle" : "fan";
  if (kind === "report") settings.reportNarrative = has("narrative");
  if (kind === "kin") {
    settings.kinLayout = (KIN_LAYOUTS.find(has) as ChartViewSettings["kinLayout"] | undefined) ?? "wheel";
    settings.kinScope = has("all") ? "all" : "contemporaries";
  }
  const direction = DIRECTED.includes(kind) ? ((DIRECTIONS.find(has) as ChartDirection | undefined) ?? "both") : "both";
  return { settings, direction };
}
