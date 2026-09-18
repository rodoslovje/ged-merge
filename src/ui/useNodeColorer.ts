import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { createNodeColorer, type BranchInfo, type ColorAxis, type ColorSubject, type NodeColorer } from "../chart/nodeColor";
import { useChartSettings } from "./ChartSettingsContext";
import { useHomeCountry } from "./DatasetDerivations";

/** The colorer for the Color axis in force, built from the people a chart
 *  draws. Rebuilt when the axis, the people or the file change. */
export function useNodeColorer(
  ds: Dataset,
  subjects: ColorSubject[],
  branches?: Map<string, BranchInfo>,
  /** An axis to use in place of the setting, for a chart the chosen one cannot
   *  answer — the shared choice is left alone, as the Contemporaries scope is
   *  when a root has no datable life. */
  override?: ColorAxis,
): NodeColorer {
  const { t, i18n } = useTranslation();
  const { settings } = useChartSettings();
  const home = useHomeCountry();
  const axis = override ?? settings.colorAxis;
  return useMemo(
    () => createNodeColorer(axis, { ds, t, lang: i18n.language, home, branches }, subjects),
    [axis, ds, t, i18n.language, home, branches, subjects],
  );
}
