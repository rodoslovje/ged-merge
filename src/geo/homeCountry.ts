import { decomposePlace } from "../gedcom/place";
import { countryNameIn, placeCountryFacet } from "./placeCountry";

// The country a file is *about*, for the places that do not say.
//
// Genealogists leave their own country out: a Slovenian file writes "Kranj,
// Slovenija" for a few places and plain "Golnik" for hundreds, because everyone
// who will ever read it knows where Golnik is. The app cannot know, and until
// now took the honest way out — a place naming no country was filed under
// "unspecified", searched in every loaded directory at once, and left out of the
// compliance check.
//
// But the file does say, in the places that name a country at all: where 95% of
// them say Slovenia, the ones that say nothing are Slovenian too. That reading
// is offered rather than imposed — it is shown in Settings and can be changed to
// any country, or switched off, because a file about emigration may well have a
// majority that is not its silent country.

/** What the file's own places say about which country it is about. */
export interface HomeCountryDetection {
  /** ISO code (lower case), or `""` where the file gives no clear answer. */
  code: string;
  /** How the file itself writes that country's name ("Slovenija", not
   *  "Slovenia") — the wording to use when writing the country into a place
   *  that names none. Empty where the file never spells it out. */
  spelling: string;
  /** Distinct place values naming the detected country. */
  named: number;
  /** Distinct place values naming any country at all. */
  namedTotal: number;
  /** Distinct place values naming none — what the assumption would cover. */
  unnamed: number;
}

const NONE: HomeCountryDetection = { code: "", spelling: "", named: 0, namedTotal: 0, unnamed: 0 };

/** Share of the country-naming values the winner must hold. A file split between
 *  two countries has no home country: guessing one would file the silent places
 *  under a coin toss, and being wrong is worse here than saying nothing. Set
 *  high on purpose — the files this is for name their home country in a handful
 *  of places and everything else abroad is the exception, so a real home country
 *  wins by a mile, not by two to one. */
const MIN_SHARE = 0.75;

/** Fewer named countries than this decide nothing — one stray "Slovenija" in a
 *  file of bare village names is not the file telling us anything. */
const MIN_NAMED = 2;

/**
 * The country most of a file's places name, when one clearly leads.
 *
 * Counted per distinct value rather than per occurrence, so one heavily used
 * birthplace cannot outvote a hundred others. A country with no ISO code of its
 * own ("Jugoslavija") never wins: a home country exists to point lookups at a
 * register, and no register describes a country that no longer exists.
 */
export function detectHomeCountry(values: Iterable<string>): HomeCountryDetection {
  const tally = new Map<string, number>();
  /** Per country, how often each written spelling of it appears. */
  const spellings = new Map<string, Map<string, number>>();
  let namedTotal = 0;
  let unnamed = 0;
  // Deduplicated here rather than trusted to the caller: every count below is
  // per distinct value, and a list of occurrences would quietly hand the file to
  // whichever village its records repeat most.
  for (const value of new Set(values)) {
    const facet = placeCountryFacet(value);
    if (!facet) {
      unnamed++;
      continue;
    }
    namedTotal++;
    if (!/^[a-z]{2}$/.test(facet)) continue;
    tally.set(facet, (tally.get(facet) ?? 0) + 1);
    // Only a country the value spells out counts as a spelling: a place known
    // to be American because it ends in "Ohio" says nothing about how this file
    // would write "United States".
    const written = decomposePlace(value).country?.trim();
    if (!written) continue;
    const forms = spellings.get(facet) ?? new Map<string, number>();
    forms.set(written, (forms.get(written) ?? 0) + 1);
    spellings.set(facet, forms);
  }
  const best = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (!best || best[1] < MIN_NAMED || best[1] / namedTotal < MIN_SHARE) {
    return { ...NONE, namedTotal, unnamed };
  }
  const spelling =
    [...(spellings.get(best[0]) ?? [])].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
  return { code: best[0], spelling, named: best[1], namedTotal, unnamed };
}

/** How to write a country into a place value: the file's own spelling of it
 *  where it has one, else what the reader's language calls it — a country
 *  chosen by hand may never appear in the file at all. */
export function countrySpelling(detection: HomeCountryDetection, code: string, lang: string): string {
  if (code && detection.code === code && detection.spelling) return detection.spelling;
  return countryNameIn(code, lang) ?? code.toUpperCase();
}

/** The setting's value when the reader has not chosen: follow the file. */
export const HOME_COUNTRY_AUTO = "auto";
/** The setting's value for "assume nothing" — the behaviour before this existed. */
export const HOME_COUNTRY_NONE = "none";

/** Which country to assume for a place that names none: the reader's choice
 *  where they made one, else what the file says about itself. */
export function resolveHomeCountry(setting: string, detected: string): string {
  if (setting === HOME_COUNTRY_AUTO) return detected;
  if (setting === HOME_COUNTRY_NONE || !setting) return "";
  return setting.toLowerCase();
}
