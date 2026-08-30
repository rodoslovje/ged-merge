import { useTranslation } from "react-i18next";
import { countryFacetLabel } from "../../geo/placeCountry";
import { countryOf } from "../../tools/geocode";

/** One country chip: the facet key {@link placeCountryFacet} put the rows under,
 *  and how many of them the click would show. */
export interface CountryChip {
  /** ISO code, a codeless country's own name, or `""` for "no country named". */
  code: string;
  count: number;
}

/**
 * The chips a row actually shows: those with rows behind them, plus the chosen
 * country whatever its count — see {@link CountryChips}. A fresh array, so the
 * caller's list is never sorted in place.
 */
export function visibleCountryChips(chips: CountryChip[], active: string | null): CountryChip[] {
  return chips.filter((c) => c.count > 0 || c.code === active);
}

/**
 * The country facet the four geocoding and compliance lists narrow by: which
 * countries their rows stand in, how many each would show, which one is in
 * force, and the test the list itself filters with.
 *
 * Two lists of rows, because the two questions are different ones. `present` is
 * what the page holds at all — every country it names keeps a chip, so one the
 * other filters have emptied stays on the row at zero rather than blinking out
 * from under the pointer. `counted` is what the *other* filters leave, which is
 * what each chip promises: the number on it is exactly how many rows clicking
 * it puts on screen. (Every counted row should be a present one; a stray would
 * be counted in `all` and under no chip.)
 *
 * A filter naming a country the page no longer has falls back to "all" rather
 * than narrowing the list to nothing — which is what happens when the last row
 * of a country is resolved while its chip is the one in force.
 *
 * Four copies of this stood in the four lists, and the differences between them
 * were accidents rather than decisions.
 */
export function countryFacet<T>(
  present: readonly T[],
  counted: readonly T[],
  placeOf: (item: T) => string,
  home: string,
  filter: string | null,
): { chips: CountryChip[]; all: number; active: string | null; inCountry: (item: T) => boolean } {
  const chips: CountryChip[] = [];
  const byCode = new Map<string, CountryChip>();
  for (const item of present) {
    const code = countryOf(placeOf(item), home);
    if (byCode.has(code)) continue;
    const chip = { code, count: 0 };
    byCode.set(code, chip);
    chips.push(chip);
  }
  for (const item of counted) {
    const chip = byCode.get(countryOf(placeOf(item), home));
    if (chip) chip.count++;
  }
  const active = filter !== null && byCode.has(filter) ? filter : null;
  return {
    chips,
    all: counted.length,
    active,
    inCountry: (item) => active === null || countryOf(placeOf(item), home) === active,
  };
}

/**
 * The country filter row the four geocoding and compliance lists share. Shown
 * even where the file names a single country: which country the rows stand in is
 * worth stating outright, and a filter row that comes and goes with the data
 * reads as a glitch rather than as a choice.
 *
 * Chips are sorted by what clicking each one shows, so the country with the most
 * work leads. A country the other filters have emptied drops out of the row: a
 * chip that shows nothing is a button that does nothing, and a file touching
 * forty countries buried the two worth working under five rows of them. The
 * chosen country is the exception and stays at zero — the filter one is standing
 * in must never be the chip that vanishes — and "All" is always the way back.
 */
export function CountryChips({
  chips,
  all,
  active,
  onPick,
  titleOf,
  assumed,
}: {
  chips: CountryChip[];
  /** What the "All" chip shows — every row the other filters leave. */
  all: number;
  active: string | null;
  onPick: (code: string | null) => void;
  /** Optional tooltip per country (the compliance list names its levels here). */
  titleOf?: (code: string) => string | undefined;
  /** The home country the places naming none were counted under, if any — its
   *  chip says so, since that part of its count is our reading and not the
   *  file's word. */
  assumed?: string;
}) {
  const { t, i18n } = useTranslation();
  const label = (code: string) =>
    code ? countryFacetLabel(code, i18n.language) : t("tools.geocode.countryUnknown");
  const sorted = visibleCountryChips(chips, active).sort(
    (a, b) => b.count - a.count || label(a.code).localeCompare(label(b.code)),
  );
  const assumption = (code: string) =>
    assumed && code === assumed ? t("tools.geocode.countryAssumed", { country: label(code) }) : undefined;
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
          // Both can be there at once — the country this file assumes is also a
          // country whose levels it names — so they stack rather than compete.
          title={[titleOf?.(c.code), assumption(c.code)].filter(Boolean).join("\n") || undefined}
        >
          {label(c.code)}
          {assumption(c.code) && <span className="tools-chip-assumed"> ≈</span>}{" "}
          <span className="tools-chip-count">{c.count}</span>
        </button>
      ))}
    </div>
  );
}
