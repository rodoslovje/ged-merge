import type { GedPlace, GeoCoord } from "./types";

/**
 * A house number on the most-specific part: a number (optionally with a letter
 * suffix) optionally followed by a parenthetical, at the end of the string.
 * Matches " 23", " 12a", and "Zgornje Bitnje 52 (pd Urbanov Jaka)".
 */
const HOUSE_NUMBER = /\s(\d+[a-zA-Z]?)(\s*\([^)]*\))?$/;

/**
 * Parse a `PLAC` (or `ADDR`) value into its comma-separated parts. GEDCOM
 * convention orders parts most-specific first (e.g. "City, County, State,
 * Country"). We keep the raw string, the trimmed parts, and — when the leading
 * part contains a house number — extract that as `detail`.
 */
export function parsePlace(raw: string): GedPlace {
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const place: GedPlace = { raw: raw.trim(), parts };
  const m = parts.length ? HOUSE_NUMBER.exec(parts[0]) : null;
  if (m) place.detail = m[1];
  return place;
}

/**
 * Parse a `MAP` structure's `LATI`/`LONG` value pair into decimal degrees.
 * Accepts the standard GEDCOM hemisphere-prefixed decimal form (`N46.05` /
 * `E14.51`), plain signed decimals, and webtrees' DMS-ish form
 * (`N46::3::19"` = degrees::minutes::seconds). Returns undefined when either
 * value is unparseable or out of range — a bad coordinate is worse than none.
 */
export function parseCoordPair(lati: string, long: string): GeoCoord | undefined {
  const lat = parseCoordValue(lati, "S");
  const lon = parseCoordValue(long, "W");
  if (lat === undefined || lon === undefined) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return { lat, lon };
}

/**
 * Parse a typed coordinate pair — "46.24137, 14.35580", "46.24137 14.35580", or
 * the GEDCOM hemisphere form "N46.24137 E14.3558" — into decimal degrees.
 * Returns undefined unless exactly two parseable values are present, so a
 * half-typed entry simply isn't offered yet.
 */
export function parseCoordInput(raw: string): GeoCoord | undefined {
  const parts = raw.split(/[,;\s]+/).filter(Boolean);
  if (parts.length !== 2) return undefined;
  return parseCoordPair(parts[0], parts[1]);
}

/** One LATI/LONG value to signed decimal degrees; `negative` names the
 *  hemisphere letter that flips the sign (S for latitude, W for longitude). */
function parseCoordValue(raw: string, negative: "S" | "W"): number | undefined {
  let s = raw.trim().toUpperCase();
  if (!s) return undefined;
  let sign = 1;
  if (/^[NSEW]/.test(s)) {
    if (s[0] === negative) sign = -1;
    s = s.slice(1).trim();
  }
  // Degree/minute/second marks (webtrees writes a trailing `"`), then the
  // webtrees `::` separators; what remains is 1–3 numeric components.
  s = s.replace(/[°'"″′]/g, "");
  const comps = s.split("::").map((c) => c.trim());
  if (comps.length > 3 || comps.some((c) => !/^-?\d+(\.\d+)?$/.test(c))) return undefined;
  const [deg, min = 0, sec = 0] = comps.map(Number);
  if (comps.length > 1 && deg < 0) return undefined;
  return sign * (deg + min / 60 + sec / 3600);
}

/**
 * The parts with the house-number detail removed from the leading part, for
 * comparing locality independently of the specific house.
 */
export function localityParts(place: GedPlace): string[] {
  return place.parts
    .map((part, i) => (i === 0 ? part.replace(HOUSE_NUMBER, "").trim() : part))
    .filter((p) => p.length > 0);
}

/**
 * A `PLAC`/`ADDR` value broken into semantic components. This is the foundation
 * for reformatting a place into another file's layout: each piece (jurisdiction
 * hierarchy, house number, "po domače" house name, street, parish, facility) is
 * pulled out so it can be re-emitted, dropped, or preserved in a NOTE as the
 * target convention requires.
 */
export interface PlaceComponents {
  raw: string;
  /** Jurisdiction hierarchy, most-specific first (locality … country). */
  jurisdiction: string[];
  /** Most-specific locality (jurisdiction[0]). */
  locality?: string;
  /** Country, when identifiable (a parenthetical "(Slovenija)" or a known last part). */
  country?: string;
  /** Bare house/parcel number on the locality, e.g. "22", "38/a", "2/b". */
  houseNumber?: string;
  /** "Po domače" house name from "(pd Adam)". */
  houseName?: string;
  /** Street + number where the street name differs from the locality, e.g. "Kidričeva 38/a". */
  street?: string;
  /** Parish from "župnija X" / "- župnija X" (also Croatian "župa" / English "parish"). */
  parish?: string;
  /** Facility/landmark parenthetical, e.g. porodnišnica, bolnica, pokopališče. */
  facility?: string;
}

/**
 * Country names (lowercased) for recognizing the country part of a place. Holds
 * the local-language variants (Slovenian/German/Italian/Croatian) common to
 * these datasets alongside the English names of every sovereign country, so a
 * place from anywhere groups under its country rather than "Unspecified".
 */
const COUNTRIES = new Set([
  // Local-language / historical variants common to these datasets.
  "slovenija", "hrvaška", "hrvaska", "hrvatska",
  "avstrija", "österreich", "osterreich",
  "italija", "italia", "nemčija", "nemcija", "deutschland",
  "madžarska", "madzarska", "srbija", "bosna", "bosnia",
  "bosna in hercegovina", "bosnia-herzegovina", "usa", "zda",
  "jugoslavija", "yugoslavia",
  // Sovereign countries, English names.
  "afghanistan", "albania", "algeria", "andorra", "angola",
  "antigua and barbuda", "argentina", "armenia", "australia", "austria",
  "azerbaijan", "bahamas", "bahrain", "bangladesh", "barbados", "belarus",
  "belgium", "belize", "benin", "bhutan", "bolivia",
  "bosnia and herzegovina", "botswana", "brazil", "brunei", "bulgaria",
  "burkina faso", "burundi", "cambodia", "cameroon", "canada",
  "cape verde", "central african republic", "chad", "chile", "china",
  "colombia", "comoros", "congo", "costa rica", "croatia", "cuba", "cyprus",
  "czech republic", "czechia", "denmark", "djibouti", "dominica",
  "dominican republic", "ecuador", "egypt", "el salvador",
  "equatorial guinea", "eritrea", "estonia", "eswatini", "swaziland",
  "ethiopia", "fiji", "finland", "france", "gabon", "gambia", "georgia",
  "germany", "ghana", "greece", "grenada", "guatemala", "guinea",
  "guinea-bissau", "guyana", "haiti", "honduras", "hungary", "iceland",
  "india", "indonesia", "iran", "iraq", "ireland", "israel", "italy",
  "ivory coast", "jamaica", "japan", "jordan", "kazakhstan", "kenya",
  "kiribati", "kosovo", "kuwait", "kyrgyzstan", "laos", "latvia", "lebanon",
  "lesotho", "liberia", "libya", "liechtenstein", "lithuania", "luxembourg",
  "madagascar", "malawi", "malaysia", "maldives", "mali", "malta",
  "marshall islands", "mauritania", "mauritius", "mexico", "micronesia",
  "moldova", "monaco", "mongolia", "montenegro", "morocco", "mozambique",
  "myanmar", "burma", "namibia", "nauru", "nepal", "netherlands",
  "new zealand", "nicaragua", "niger", "nigeria", "north korea",
  "north macedonia", "macedonia", "norway", "oman", "pakistan", "palau",
  "palestine", "panama", "papua new guinea", "paraguay", "peru",
  "philippines", "poland", "portugal", "qatar", "romania", "russia",
  "rwanda", "saint kitts and nevis", "saint lucia",
  "saint vincent and the grenadines", "samoa", "san marino",
  "sao tome and principe", "saudi arabia", "senegal", "serbia",
  "seychelles", "sierra leone", "singapore", "slovakia", "slovenia",
  "solomon islands", "somalia", "south africa", "south korea", "south sudan",
  "spain", "sri lanka", "sudan", "suriname", "sweden", "switzerland",
  "syria", "taiwan", "tajikistan", "tanzania", "thailand", "timor-leste",
  "togo", "tonga", "trinidad and tobago", "tunisia", "turkey", "türkiye",
  "turkmenistan", "tuvalu", "uganda", "ukraine", "united arab emirates",
  "united kingdom", "great britain", "england", "scotland", "wales", "northern ireland",
  "united states", "united states of america", "uruguay", "uzbekistan",
  "vanuatu", "vatican city", "venezuela", "vietnam", "yemen", "zambia",
  "zimbabwe",
]);

/** "po domače" / "pd" house-name parenthetical. */
const PD_RE = /^(?:pd|po\s+doma[čc]e)\s+(.+)$/i;
/** A parish marker word: Slovenian "župnija"/"župnije", Croatian "župa"/"župe", or English "parish". */
const PARISH_WORD = "(?:župnij[ae]|žup[ae]|parish)";
/** "župnija X" / "župa X" / "parish X" agency text → the parish name alone. */
const PARISH_LABEL_RE = new RegExp(`^${PARISH_WORD}\\s+(.+)$`, "i");
/** Strip a "župnija X" / "župa X" / "parish X" prefix from an AGNC value, leaving just the parish name. */
export function stripParishLabel(raw: string | undefined): string | undefined {
  const m = raw ? PARISH_LABEL_RE.exec(raw.trim()) : null;
  return m ? m[1].trim() : undefined;
}

/** Trailing "… - župnija/župa/parish <parish>" suffix. The `(?!\()` guard
 * keeps a facility named "<X> Parish (USA)" whole — a parenthetical after the
 * marker word is a country/facility, not a parish name. */
const PARISH_RE = new RegExp(`\\s*[-,]?\\s*${PARISH_WORD}\\s+(?!\\()(.+?)\\s*$`, "i");
/** One house-number part: digits plus at most a 1–2 letter subdivision suffix
 * ("18", "38/a", "12a"). Longer letter runs are real words ("99/145/Vrata" —
 * a renumbering chain ending in a hamlet name), not subdivision letters. */
const HOUSE_NUM_PART = String.raw`\d+(?:\/?[a-zA-Z]{1,2})?`;
/**
 * A house number at the end of a segment: "18", "38/a", "2/b", "12a", or an
 * old/renumbered pair like "21a / 53" (space around the slash, both sides
 * numeric) — common where a house kept its historical number alongside a
 * later official one.
 */
const HOUSE_TAIL = new RegExp(String.raw`\s+(${HOUSE_NUM_PART}(?:\s*\/\s*${HOUSE_NUM_PART})*)$`);

/** A segment that is *only* a house-number token ("26", "38/a", "21a / 53") —
 * the number belongs to the locality named by the neighboring segments
 * ("Hrašenski Vrh, 26, Kapela"), so it must not be read as a locality or
 * street name of its own. */
const BARE_HOUSE_NUMBER = new RegExp(String.raw`^${HOUSE_NUM_PART}(?:\s*\/\s*${HOUSE_NUM_PART})*$`);

/** Strip a trailing house number from a street/locality segment, leaving the name alone. */
export function stripHouseNumber(segment: string): string {
  return segment.replace(HOUSE_TAIL, "").trim();
}

/**
 * A street name with the house number(s) stripped, for matching an address to
 * a known locality by street alone — independent of which house number is on
 * it. Decomposes `addrRaw` first: a multi-segment ADDR ("Kidričeva 38/a,
 * Kranj") names the street in `.street` (number still attached, stripped
 * here); a single-segment one ("Hafnarjeva pot 21/a") parses its street name
 * into `.locality` instead, already number-free (see decomposePlace).
 */
export function addressStreetName(addrRaw: string | undefined): string | undefined {
  if (!addrRaw) return undefined;
  const a = decomposePlace(addrRaw);
  if (a.street) return stripHouseNumber(a.street);
  return a.houseNumber ? a.locality : undefined;
}
/** Street-type words: a segment with one is an address, even without a number. */
const STREET_WORDS = /\b(?:ulica|cesta|trg|naselje|nabrežje|drevored)\b/i;

/** Whether a segment names a street rather than a settlement ("Kidričeva cesta",
 *  "Trg svobode"). Distinguishes the two things a house number can sit on: a
 *  street in a town, or the settlement itself in village numbering. */
export function looksLikeStreet(segment: string): boolean {
  return STREET_WORDS.test(segment);
}
/** Facility/landmark words: such a segment is a place detail, not a jurisdiction. */
const FACILITY_WORDS =
  /\b(?:porodnišnica|bolnišnica|bolnica|pokopališče|grad|samostan|cerkev|kapela)\b/i;

/** Whether a detail string would re-parse as a facility (used by the packed
 * place writer to pick a syntax that survives a round-trip through
 * decomposePlace — a bare ", detail" without a facility word reads back as a
 * jurisdiction level and would be dropped by the next reshape). */
export function looksLikeFacility(s: string): boolean {
  return FACILITY_WORDS.test(s);
}

const tidy = (s: string): string => s.replace(/\s+/g, " ").trim();
/**
 * Canonicalize a house-number tail's spacing. A renumbering slash between two
 * numeric parts ("82/63/11", "21a / 53") gets a single space each side — the
 * house-style convention; a subdivision-suffix slash ("38/a", "2/b") stays tight.
 */
const normNum = (s: string): string =>
  s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*\/\s*(?=\d)/g, " / ")
    .replace(/\s*\/\s*(?=[a-zA-Z])/g, "/");

/**
 * Decompose a `PLAC` or `ADDR` value into its semantic parts. Handles both the
 * structured comma form ("Srednje Bitnje,Kranj,Slovenia") and the Brother's
 * Keeper packed form ("Kranj (Slovenija), Kidričeva 38/a (porodnišnica)").
 */
export function decomposePlace(raw: string): PlaceComponents {
  const out: PlaceComponents = { raw: raw.trim(), jurisdiction: [] };
  let s = raw.trim();

  // 1. Parish suffix.
  const pm = s.match(PARISH_RE);
  if (pm) {
    out.parish = tidy(pm[1]);
    s = s.slice(0, pm.index).replace(/[-,]\s*$/, "").trim();
  }

  // 2. Parentheticals: country / house name / facility.
  s = s.replace(/\s*\(([^)]*)\)/g, (_full, inner: string) => {
    const content = tidy(inner);
    const pd = content.match(PD_RE);
    if (pd) out.houseName = tidy(pd[1]);
    else if (COUNTRIES.has(content.toLowerCase())) out.country = content;
    else if (content) out.facility = out.facility ? `${out.facility}; ${content}` : content;
    return "";
  });
  // Removing a trailing parenthetical can leave a dangling separator
  // ("Zgornje Bitnje 42 - (pd V dolini)" → "Zgornje Bitnje 42 -"); strip it so
  // the house number stays at the end of the segment and still parses.
  s = s.replace(/\s*[-–]\s*$/, "").trim();

  // 3. Comma segments: locality, further jurisdictions, and any inline address.
  const segments = s.split(",").map(tidy).filter(Boolean);
  segments.forEach((seg, i) => {
    const hm = seg.match(HOUSE_TAIL);
    // A number-only segment is the house number for the surrounding place,
    // wherever it appears; treating it as a locality ("26 (Kapela)") or street
    // ("Hrašenski Vrh, 26, Kapela") would misfile — or, on a re-normalize,
    // silently drop — the number.
    if (BARE_HOUSE_NUMBER.test(seg)) {
      out.houseNumber = normNum(seg);
      return;
    }
    if (i === 0) {
      // A leading segment that names a facility ("Mestno pokopališče Kranj",
      // "Splošna bolnišnica Maribor") is itself the address detail, not a
      // jurisdiction level — the locality comes from the next comma segment.
      if (FACILITY_WORDS.test(seg)) {
        out.facility = out.facility ? `${out.facility}; ${seg}` : seg;
        return;
      }
      out.locality = hm ? seg.slice(0, hm.index).trim() : seg;
      if (hm) out.houseNumber = normNum(hm[1]);
      if (out.locality) out.jurisdiction.push(out.locality);
      return;
    }
    if (FACILITY_WORDS.test(seg)) {
      // A landmark like "porodnišnica" / "pokopališče Blejska Dobrava".
      out.facility = out.facility ? `${out.facility}; ${seg}` : seg;
    } else if (/\d/.test(seg)) {
      // An address segment: street ("Kidričeva 38/a") or "Locality 52".
      if (hm) out.houseNumber = normNum(hm[1]);
      const name = (hm ? seg.slice(0, hm.index) : seg).trim();
      if (name && name.toLowerCase() !== out.locality?.toLowerCase()) out.street = seg;
    } else if (STREET_WORDS.test(seg)) {
      // A street with no house number, e.g. "Gosposvetska cesta blok VII".
      out.street ??= seg;
    } else {
      // A further jurisdiction level (municipality, region, country).
      if (!out.country && COUNTRIES.has(seg.toLowerCase())) out.country = seg;
      out.jurisdiction.push(seg);
    }
  });

  // A parenthetical country isn't a comma segment, so add it to the hierarchy.
  if (out.country && !out.jurisdiction.some((j) => j.toLowerCase() === out.country!.toLowerCase())) {
    out.jurisdiction.push(out.country);
  }
  // The leading segment was a facility name, not a locality — fall back to the
  // next jurisdiction level (e.g. "Mestno pokopališče Kranj,Kranj" → "Kranj").
  out.locality ??= out.jurisdiction[0];
  return out;
}
