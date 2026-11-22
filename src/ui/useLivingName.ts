import { useCallback } from "react";
import type { Individual } from "../gedcom/types";
import { reducedName } from "../gedcom/nameDisplay";
import { primaryName } from "../match/relatives";
import { marriedNameOverride, useChartSettings } from "./ChartSettingsContext";
import { useNameOf } from "./SettingsContext";

/**
 * The name a chart writes for a living person it shows without details, under
 * the privacy setting's name choice: the initials, the given name or the whole
 * name, formatted as the chart formats every name. Undefined for the
 * "anonymous" choice — the caller then writes the relationship to the start
 * person, else "Living", as before. A person flagged private keeps no name
 * under any choice, as on the family website.
 *
 * A view with its own naming of the living (the family calendar) hands in
 * `override`, which then answers instead.
 */
export function useLivingNameOf(override?: LivingNameOf): LivingNameOf {
  const { settings } = useChartSettings();
  const nameOf = useNameOf(marriedNameOverride(settings.showMarriedName));
  const mode = settings.livingName;
  const fromSettings = useCallback(
    (indi: Individual | undefined) => {
      if (!indi || indi.private || mode === "anonymous") return undefined;
      if (mode === "name") return nameOf(indi);
      const reduced = reducedName(primaryName(indi), mode);
      return reduced ? nameOf(reduced) : undefined;
    },
    [mode, nameOf],
  );
  return override ?? fromSettings;
}

/** The name a redacted living person keeps, or undefined for none. */
export type LivingNameOf = (indi: Individual | undefined) => string | undefined;
