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
