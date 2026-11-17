import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import {
  historyCountries,
  historyKey,
  historyPresence,
  historyYears,
  pickHistoryEvents,
  type HistoryEvent,
} from "../chart/historyEvents";
import { countryFacetName } from "../geo/placeCountry";
import { useHomeCountry } from "./DatasetDerivations";
import { useChartSettings } from "./ChartSettingsContext";

/** A historical event as a chart draws it: its key and its label. */
export interface ShownHistoryEvent extends HistoryEvent {
  key: string;
  /** "1914–18 First World War", "2004 accession to the European Union (Slovenia)". */
  text: string;
}

/**
 * The historical events a Timeline layout shows over `[minYear, maxYear]`,
 * picked by where and when `people` lived (a bare village stands in the file's
 * home country) — none while the chart setting is off.
 */
export function useHistoryEvents(
  ds: Dataset,
  people: readonly { id: string; from?: number; to?: number }[],
  minYear: number | undefined,
  maxYear: number | undefined,
): ShownHistoryEvent[] {
  const { t, i18n } = useTranslation();
  const { settings } = useChartSettings();
  const on = settings.timelineHistory;
  const home = useHomeCountry();
  return useMemo(() => {
    if (!on || minYear === undefined || maxYear === undefined) return [];
    const presence = historyPresence(ds, people, home);
    // An event shared by several countries names the ones the people lived in.
    return pickHistoryEvents(presence, minYear, maxYear).map((e) => {
      const countries = e.namesCountries
        ? historyCountries(e, presence).map((c) => countryFacetName(c, i18n.language)).join(", ")
        : "";
      return { ...e, key: historyKey(e), text: `${historyYears(e)} ${t(`history.${e.id}`, { countries })}` };
    });
  }, [on, ds, people, home, minYear, maxYear, t, i18n.language]);
}
