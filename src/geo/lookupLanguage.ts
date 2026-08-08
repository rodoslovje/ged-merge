import { countryCode } from "../gedcom/countryCode";
import { decomposePlace } from "../gedcom/place";
import { foldSearch } from "../ui/globalSearch";

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

/** Compare names case-, accent- and punctuation-blind: the file may write
 *  "Bosnia-Herzegovina" where Intl says "Bosnia & Herzegovina", or end its
 *  country with a full stop ("Slovenija."). */
export function foldCountryName(value: string): string {
  return foldSearch(value).replace(/[^a-z0-9]+/g, "");
}
const fold = foldCountryName;

/** `${code}:${lang}` → that language's name for the country. Every lookup
 *  ladder asks this per candidate language, and `Intl.DisplayNames` is not a
 *  cheap constructor — a dozen fresh instances per row click adds up. The
 *  world's country names do not change mid-session. */
const countryNameCache = new Map<string, string | undefined>();

/** What `lang` calls the country with this ISO code, or undefined when the
 *  runtime cannot say (an unknown code, or no Intl data for the language). */
export function countryNameIn(code: string, lang: string): string | undefined {
  const key = `${code.toUpperCase()}:${lang}`;
  if (countryNameCache.has(key)) return countryNameCache.get(key);
  let name: string | undefined;
  try {
    const resolved = new Intl.DisplayNames([lang], { type: "region" }).of(code.toUpperCase());
    // A code Intl does not know comes back as the code itself.
    name = resolved && resolved.toUpperCase() !== code.toUpperCase() ? resolved : undefined;
  } catch {
    name = undefined;
  }
  countryNameCache.set(key, name);
  return name;
}

/**
 * Languages a country name in one of these files is plausibly written in: the
 * two the app itself speaks, then the neighbours whose spellings turn up in
 * Central-European genealogy ("Österreich", "Ungheria", "Mađarska"). Tried in
 * order, which only matters where two of them disagree — and where they agree
 * ("Kosovo", "Uganda") the answer is the same either way.
 */
export const CANDIDATE_LANGS = ["en", "sl", "de", "it", "hr", "hu", "sr", "fr", "es", "pl", "cs", "sk"];

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
  const code = countryCode(country);
  if (!code) return uiLang;
  const written = fold(country);
  // The reader's own language first: where it spells the country as the file
  // does, there is nothing to switch away from.
  for (const lang of [uiLang, ...CANDIDATE_LANGS]) {
    const name = countryNameIn(code, lang);
    if (name && fold(name) === written) return lang;
  }
  return uiLang;
}
