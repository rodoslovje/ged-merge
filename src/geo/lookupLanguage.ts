import { decomposePlace } from "../gedcom/place";
import { CANDIDATE_LANGS, countryCodeOfName, countryNameIn, foldCountryName } from "./placeCountry";

// Which language a place lookup should answer in.
//
// The reader's own language is the wrong answer whenever the file is not
// written in it: a file that says "Joliet Township, Will, Illinois, United
// States" asked in Slovenian gets "Združene države Amerike" back, and every
// proposal composed from that answer would drag a second spelling of the
// country into a file that already has one. What the answer must match is the
// file, not the interface.
//
// The file says which language it is in, in the place itself: its country
// segment. That name is compared against what each language calls the same
// country, so no table of our own is needed and it works for every country
// `Intl.DisplayNames` knows.

/**
 * The language to ask an online place register in for `place`: the one the
 * place is already written in, so the answer comes back in the file's own
 * words. A file that says "United States" must not be answered "Združene
 * države Amerike" because the interface happens to be Slovenian — nor the
 * other way round.
 *
 * Falls back to `uiLang`, the best guess when the place names no country or
 * names one in no language checked here.
 */
export function placeLookupLanguage(place: string, uiLang: string): string {
  const country = decomposePlace(place).country?.trim();
  if (!country) return uiLang;
  const code = countryCodeOfName(country);
  if (!code) return uiLang;
  const written = foldCountryName(country);
  // The reader's own language first: where it spells the country as the file
  // does, there is nothing to switch away from.
  for (const lang of [uiLang, ...CANDIDATE_LANGS]) {
    const name = countryNameIn(code, lang);
    if (name && foldCountryName(name) === written) return lang;
  }
  return uiLang;
}
