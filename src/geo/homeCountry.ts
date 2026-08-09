import { decomposePlace, isUnknownPlaceValue } from "../gedcom/place";
import { foldToken } from "../match/text";
import { countryNameIn, placeCountryFacet } from "./placeCountry";
import type { GazetteerIndex } from "./gazetteer";

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

// The file that names no country at all
//
// The reading above is of the file's own words, and some files have none to
// read: a parish researcher's file writes "Kranj", "Poljane", "Lučine" five
// thousand times and never once writes Slovenia, because the country was never
// in question. The country names it does write are the *exceptions* — the
// emigrants' "Youngstown, OH" and "USA" — so the majority above, honestly
// counted, either says nothing or says America.
//
// What such a file cannot say in words it says in names. Poljane, Lučine and
// Šentjošt are in the Slovenian register and in no other, and a directory that
// holds hundreds of a file's silent places while its neighbours hold none has
// answered the question the file left open.

/** What the imported directories make of the places a file leaves countryless. */
export interface RegisterVote {
  /** ISO code (lower case), or `""` where the directories give no clear answer. */
  code: string;
  /** Distinct countryless values carrying a name worth looking up. */
  examined: number;
  /** Of those, the ones exactly one country's directory holds. */
  decided: number;
  /** Of the decided, the ones the winning country holds. */
  won: number;
}

const NO_VOTE: RegisterVote = { code: "", examined: 0, decided: 0, won: 0 };

/** Names a directory must hold before it may speak for the whole file. A
 *  handful of hits is coincidence — every country has a Draga and a Brezje. */
const MIN_REGISTER_HITS = 10;

/**
 * Share of the *looked-up* names the winner must hold, on top of the share of
 * the decided ones. This is the guard against the reader's own shelf: with only
 * the Slovenian directory imported, every name that hits anything at all hits
 * Slovenia, and a Croatian file would be declared Slovenian on the strength of
 * the dozen names the two countries share. A directory that really describes
 * this file holds most of its places, not a tenth of them.
 */
const MIN_REGISTER_COVERAGE = 0.5;

/**
 * The country the imported directories put a file's countryless places in.
 *
 * Per distinct value, as the count above is, and only the values that name no
 * country: the ones that do have already spoken for themselves. A name two
 * countries' directories both hold decides nothing and votes for neither — it
 * is counted as looked up, so that a file resting on shared names cannot reach
 * the coverage bar on them.
 */
export function detectHomeCountryFromRegister(values: Iterable<string>, index: GazetteerIndex): RegisterVote {
  const tally = new Map<string, number>();
  let examined = 0;
  for (const value of new Set(values)) {
    if (isUnknownPlaceValue(value) || placeCountryFacet(value)) continue;
    // The settlement alone: the register knows "Črni vrh", not "Črni vrh 35",
    // and the parents a value carries are looked up by nobody here — one name
    // in one directory is the whole question.
    const locality = decomposePlace(value).locality ?? value.split(",")[0] ?? "";
    const folded = foldToken(locality);
    if (!folded) continue;
    examined++;
    const countries = new Set<string>();
    for (const i of index.byName.get(folded) ?? []) {
      const code = index.entries[i].country.toLowerCase();
      if (code) countries.add(code);
      // A name in three countries is no answer, and reading the rest of a
      // common name's entries costs the scan its speed.
      if (countries.size > 1) break;
    }
    if (countries.size !== 1) continue;
    const [code] = countries;
    tally.set(code, (tally.get(code) ?? 0) + 1);
  }
  const decided = [...tally.values()].reduce((a, b) => a + b, 0);
  const best = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (!best || best[1] < MIN_REGISTER_HITS || best[1] / decided < MIN_SHARE) {
    return { ...NO_VOTE, examined, decided };
  }
  if (best[1] / examined < MIN_REGISTER_COVERAGE) return { ...NO_VOTE, examined, decided };
  return { code: best[0], examined, decided, won: best[1] };
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
