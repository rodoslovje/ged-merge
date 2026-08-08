import { useTranslation } from "react-i18next";
import { countryFacetLabel } from "../../geo/placeCountry";

/** One country chip: the facet key {@link placeCountryFacet} put the rows under,
 *  and how many of them the click would show. */
export interface CountryChip {
  /** ISO code, a codeless country's own name, or `""` for "no country named". */
  code: string;
  count: number;
}

/**
 * The country filter row the four geocoding and compliance lists share. Shown
 * even where the file names a single country: which country the rows stand in is
 * worth stating outright, and a filter row that comes and goes with the data
 * reads as a glitch rather than as a choice.
 *
 * Chips are sorted by what clicking each one shows, so the country with the most
 * work leads; the countries a filter has emptied stay visible at zero, because a
 * chip disappearing under one's own filter is how a list loses its way back.
 */
export function CountryChips({
  chips,
  all,
  active,
  onPick,
  titleOf,
}: {
  chips: CountryChip[];
  /** What the "All" chip shows — every row the other filters leave. */
  all: number;
  active: string | null;
  onPick: (code: string | null) => void;
  /** Optional tooltip per country (the compliance list names its levels here). */
  titleOf?: (code: string) => string | undefined;
}) {
  const { t, i18n } = useTranslation();
  const label = (code: string) =>
    code ? countryFacetLabel(code, i18n.language) : t("tools.geocode.countryUnknown");
  const sorted = [...chips].sort((a, b) => b.count - a.count || label(a.code).localeCompare(label(b.code)));
  return (
    <div className="tools-chips">
      <button className={`tools-chip ${active === null ? "active" : ""}`} onClick={() => onPick(null)}>
        {t("tools.geocode.filter.all")} <span className="tools-chip-count">{all}</span>
      </button>
      {sorted.map((c) => (
        <button
          key={c.code || "?"}
          className={`tools-chip ${active === c.code ? "active" : ""}`}
          onClick={() => onPick(c.code)}
          title={titleOf?.(c.code)}
        >
          {label(c.code)} <span className="tools-chip-count">{c.count}</span>
        </button>
      ))}
    </div>
  );
}
