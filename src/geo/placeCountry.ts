import { countryCode } from "../gedcom/countryCode";
import { decomposePlace } from "../gedcom/place";
import { CANDIDATE_LANGS, countryNameIn, foldCountryName } from "./lookupLanguage";

// Which country a place value stands in — the key the four geocoding and
// compliance lists put their country chips on.
//
// The old answer was the value's last comma part, which is a country only in a
// file that writes one. In a real file it is a parish patron ("Vojnik, sv.
// Jernej"), a hospital, a date somebody typed into a place field, or a state
// with no country behind it ("Hobart, Tasmania") — and the chip row filled with
// hundreds of buttons that named no country and grouped nothing.
//
// So a name only counts as a country when it *is* one. Recognized are: every
// country as English, Slovenian, German, Italian, Croatian … name it (through
// `Intl.DisplayNames`, so no table of ours has to be kept up to date), the local
// and historical spellings the curated table already held, and the states of the
// three countries whose files habitually stop at the state — a value ending in
// "Ohio" or "Tasmania" says which country it is in as plainly as one ending in
// "United States". Everything else names no country and is counted as such.

/**
 * Every ISO 3166-1 alpha-2 code, the set the reverse name index is built over.
 * `XK` (Kosovo) is user-assigned rather than ISO, and included because these
 * files write it; a runtime that cannot name a code simply contributes no name
 * for it.
 */
const ISO_REGIONS =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO " +
  "FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE " +
  "JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO " +
  "MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW " +
  "PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM " +
  "TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW";

/** Folded country name → ISO code, over every language a country name in one of
 *  these files is plausibly written in. Built once, lazily: it is a few thousand
 *  `Intl` lookups, worth nothing until a file asks. */
let nameIndex: Map<string, string> | null = null;
function reverseNameIndex(): Map<string, string> {
  if (nameIndex) return nameIndex;
  const index = new Map<string, string>();
  // Language order decides the rare disagreement, so the app's own two lead —
  // see CANDIDATE_LANGS. First writer wins.
  for (const lang of CANDIDATE_LANGS) {
    for (const code of ISO_REGIONS.split(" ")) {
      const name = countryNameIn(code, lang);
      const key = name ? foldCountryName(name) : "";
      if (key && !index.has(key)) index.set(key, code.toLowerCase());
    }
  }
  nameIndex = index;
  return index;
}

/**
 * First-level divisions of the countries whose files write a place down to the
 * state and stop there: American and Australian files do it constantly, Canadian
 * ones often. The state names the country as surely as the country would.
 *
 * Left out on purpose: names that are a country in their own right — Georgia is
 * a country, and a file that writes it means whichever of the two it means, so
 * the country reading (which is what every other list already takes) stands.
 */
const STATE_NAMES: Record<string, string[]> = {
  us: [
    "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware",
    "District of Columbia", "Florida", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas",
    "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi",
    "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York",
    "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island",
    "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington",
    "West Virginia", "Wisconsin", "Wyoming",
  ],
  au: [
    "New South Wales", "Queensland", "South Australia", "Tasmania", "Victoria", "Western Australia",
    "Australian Capital Territory", "Northern Territory",
  ],
  ca: [
    "Alberta", "British Columbia", "Manitoba", "New Brunswick", "Newfoundland and Labrador", "Nova Scotia",
    "Ontario", "Prince Edward Island", "Quebec", "Québec", "Saskatchewan", "Northwest Territories",
    "Nunavut", "Yukon",
  ],
};

/** Folded state name → the code of the country it belongs to. A name the world
 *  also knows as a country is dropped rather than claimed. */
let stateIndex: Map<string, string> | null = null;
function reverseStateIndex(): Map<string, string> {
  if (stateIndex) return stateIndex;
  const names = reverseNameIndex();
  const index = new Map<string, string>();
  for (const [code, states] of Object.entries(STATE_NAMES)) {
    for (const state of states) {
      const key = foldCountryName(state);
      if (key && !names.has(key) && !index.has(key)) index.set(key, code);
    }
  }
  stateIndex = index;
  return index;
}

/** The ISO code for a country name written in any language checked here, or
 *  undefined for a name that is not a country's. The curated table leads: it
 *  holds the local and historical spellings (`Hrvaška`, `ZDA`) that no `Intl`
 *  language offers. */
export function countryCodeOfName(name: string): string | undefined {
  // The English definite article is read past, as the place parser reads past
  // it: a file writes "The Netherlands" where every name list holds one word.
  const bare = name.replace(/^the\s+/i, "");
  return countryCode(name) ?? reverseNameIndex().get(foldCountryName(bare));
}

/** Per distinct place value — the lists ask this of every row on every filter
 *  pass, and a file brings thousands of values. */
const facetCache = new Map<string, string>();

/**
 * The country a place value stands in, as the facet key the country chips
 * group and filter on: an ISO 3166-1 alpha-2 code (lower case), the name as
 * written for a country that has no code of its own ("Jugoslavija"), or `""`
 * for a value that names no country at all.
 *
 * A country named anywhere in the value wins over a state: "Ravna Gora,
 * Primorje-Gorski Kotar, Croatia" is Croatian however its middle level reads.
 */
export function placeCountryFacet(value: string): string {
  const cached = facetCache.get(value);
  if (cached !== undefined) return cached;
  const facet = computeFacet(value);
  // A session that loads file after file must not accumulate every value any of
  // them ever wrote; past a whole large file's worth, start again.
  if (facetCache.size > 50_000) facetCache.clear();
  facetCache.set(value, facet);
  return facet;
}

function computeFacet(value: string): string {
  // What the place parser makes of the value: it reads past brackets ("Ljubljana
  // (Slovenija)") and the English article ("The Netherlands"), and knows a value
  // that is nothing but a country name.
  const named = decomposePlace(value).country?.trim();
  if (named) return countryCodeOfName(named) ?? named;
  // The parser's own list is English plus the neighbours; this one reaches every
  // language Intl knows, and reads past the punctuation a file adds ("Slovenija.").
  const segments = value.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const code = countryCodeOfName(segments[i]);
    if (code) return code;
  }
  const states = reverseStateIndex();
  for (let i = segments.length - 1; i >= 0; i--) {
    const code = states.get(foldCountryName(segments[i]));
    if (code) return code;
  }
  return "";
}

/** The flag of an ISO country code as regional-indicator letters. */
export function flagEmoji(code: string): string {
  return [...code.toUpperCase()].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("");
}

/**
 * What to write on a country chip: the flag and the country's name in the
 * reader's own language, so one country is one chip however the file spells it —
 * "Slovenija", "Slovenia" and "SLOVENIA" are the same place and now say so.
 *
 * A facet that is not an ISO code is a country the world no longer has: it keeps
 * the file's own wording, which is the only name anyone has for it.
 */
export function countryFacetLabel(facet: string, lang: string): string {
  if (!/^[a-z]{2}$/.test(facet)) return facet;
  return `${flagEmoji(facet)} ${countryNameIn(facet, lang) ?? facet.toUpperCase()}`;
}
