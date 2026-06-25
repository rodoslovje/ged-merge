/**
 * Maps country name variants (lowercased) that appear in these genealogy
 * datasets to ISO 3166-1 alpha-2 codes for emoji flag rendering.
 */
const CODES: Record<string, string> = {
  // Slovenian names
  slovenija: "si",
  hrvaška: "hr", hrvaska: "hr", hrvatska: "hr",
  avstrija: "at", österreich: "at", osterreich: "at",
  italija: "it", italia: "it",
  "nemčija": "de", nemcija: "de", deutschland: "de",
  "madžarska": "hu", madzarska: "hu",
  srbija: "rs",
  bosna: "ba", "bosna in hercegovina": "ba",
  "bosnia-herzegovina": "ba", "bosnia and herzegovina": "ba",
  usa: "us", zda: "us",
  // Yugoslavia no longer exists — no valid flag-icons code; omit to avoid blank span.
  // English names — common European and world countries
  austria: "at", belgium: "be", bulgaria: "bg", croatia: "hr",
  czechia: "cz", "czech republic": "cz", denmark: "dk", estonia: "ee",
  finland: "fi", france: "fr", germany: "de", greece: "gr",
  hungary: "hu", iceland: "is", ireland: "ie", italy: "it",
  latvia: "lv", liechtenstein: "li", lithuania: "lt", luxembourg: "lu",
  malta: "mt", moldova: "md", monaco: "mc", montenegro: "me",
  netherlands: "nl", "north macedonia": "mk", macedonia: "mk",
  norway: "no", poland: "pl", portugal: "pt", romania: "ro",
  russia: "ru", "san marino": "sm", serbia: "rs", slovakia: "sk",
  slovenia: "si", spain: "es", sweden: "se", switzerland: "ch",
  ukraine: "ua", "united kingdom": "gb", "great britain": "gb",
  england: "gb", scotland: "gb", wales: "gb",
  "united states": "us", "united states of america": "us",
  albania: "al", armenia: "am", azerbaijan: "az", belarus: "by",
  "bosnia": "ba", georgia: "ge", kazakhstan: "kz", kosovo: "xk",
  kyrgyzstan: "kg", "north korea": "kp", "south korea": "kr",
  tajikistan: "tj", turkey: "tr", "türkiye": "tr",
  turkmenistan: "tm", uzbekistan: "uz",
  argentina: "ar", australia: "au", brazil: "br", canada: "ca",
  cambodia: "kh", chile: "cl", china: "cn", colombia: "co",
  "costa rica": "cr", "el salvador": "sv", india: "in", indonesia: "id",
  israel: "il", japan: "jp", mexico: "mx", "new zealand": "nz",
  pakistan: "pk", peru: "pe", philippines: "ph", "saudi arabia": "sa",
  singapore: "sg", "south africa": "za", taiwan: "tw",
  thailand: "th", "united arab emirates": "ae",
  venezuela: "ve", vietnam: "vn",
};

/** Returns the ISO 3166-1 alpha-2 code (lowercase) for a country name, or undefined.
 *  Strips trailing parentheticals so "Macedonia (FYR)" resolves the same as "Macedonia". */
export function countryCode(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (CODES[lower]) return CODES[lower];
  const base = lower.replace(/(\s*\([^)]*\))+$/, "").trim();
  return CODES[base];
}
