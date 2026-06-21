import type { GedPlace } from "./types";

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
  /** Parish from "župnija X" / "- župnija X" (Slovenian Brother's Keeper). */
  parish?: string;
  /** Facility/landmark parenthetical, e.g. porodnišnica, bolnica, pokopališče. */
  facility?: string;
}

/** Country names (lowercased) seen in these datasets, in both languages. */
const COUNTRIES = new Set([
  "slovenija", "slovenia", "hrvaška", "hrvaska", "hrvatska", "croatia",
  "avstrija", "austria", "österreich", "osterreich",
  "italija", "italy", "italia", "nemčija", "nemcija", "germany", "deutschland",
  "madžarska", "madzarska", "hungary", "srbija", "serbia", "bosna", "bosnia",
  "usa", "united states", "zda",
]);

/** "po domače" / "pd" house-name parenthetical. */
const PD_RE = /^(?:pd|po\s+doma[čc]e)\s+(.+)$/i;
/** Trailing "… - župnija <parish>" suffix. */
const PARISH_RE = /\s*[-,]?\s*župnij[ae]\s+(.+?)\s*$/i;
/** A house number at the end of a segment: "18", "38/a", "2/b", "12a". */
const HOUSE_TAIL = /\s+(\d[\d/a-zA-Z]*)$/;
/** Street-type words: a segment with one is an address, even without a number. */
const STREET_WORDS = /\b(?:ulica|cesta|trg|naselje|nabrežje|drevored)\b/i;
/** Facility/landmark words: such a segment is a place detail, not a jurisdiction. */
const FACILITY_WORDS =
  /\b(?:porodnišnica|bolnišnica|bolnica|pokopališče|grad|samostan|cerkev|kapela)\b/i;

const tidy = (s: string): string => s.replace(/\s+/g, " ").trim();
const normNum = (s: string): string => s.replace(/\s+/g, "");

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

  // 3. Comma segments: locality, further jurisdictions, and any inline address.
  const segments = s.split(",").map(tidy).filter(Boolean);
  segments.forEach((seg, i) => {
    const hm = seg.match(HOUSE_TAIL);
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
