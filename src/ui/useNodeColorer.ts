import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { createNodeColorer, type BranchInfo, type ColorSubject, type NodeColorer } from "../chart/nodeColor";
import { useChartSettings } from "./ChartSettingsContext";
import { useHomeCountry } from "./DatasetDerivations";

/** The colorer for the Color axis in force, built from the people a chart
 *  draws. Rebuilt when the axis, the people or the file change. */
export function useNodeColorer(ds: Dataset, subjects: ColorSubject[], branches?: Map<string, BranchInfo>): NodeColorer {
  const { t, i18n } = useTranslation();
  const { settings } = useChartSettings();
  const home = useHomeCountry();
  const axis = settings.colorAxis;
  return useMemo(
    () => createNodeColorer(axis, { ds, t, lang: i18n.language, home, branches }, subjects),
    [axis, ds, t, i18n.language, home, branches, subjects],
  );
}
