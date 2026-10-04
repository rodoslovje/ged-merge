import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { axisWithin, createNodeColorer, type BranchInfo, type ColorAxisScope, type ColorSubject, type NodeColorer } from "../chart/nodeColor";
import { useChartSettings } from "./ChartSettingsContext";
import { useHomeCountry } from "./DatasetDerivations";

/** The colorer for the Color axis in force, built from the people a chart
 *  draws. Rebuilt when the axis, the people or the file change. `scope` says
 *  which axes this chart can honour: an axis it cannot (the choice was made on
 *  another chart, and the setting is shared) falls back to plain — the shared
 *  choice itself is left alone for the charts that can answer it. */
export function useNodeColorer(
  ds: Dataset,
  subjects: ColorSubject[],
  branches?: Map<string, BranchInfo>,
  scope: ColorAxisScope = "all",
): NodeColorer {
  const { t, i18n } = useTranslation();
  const { settings } = useChartSettings();
  const home = useHomeCountry();
  const axis = axisWithin(settings.colorAxis, scope);
  return useMemo(
    () => createNodeColorer(axis, { ds, t, lang: i18n.language, home, branches }, subjects),
    [axis, ds, t, i18n.language, home, branches, subjects],
  );
}
