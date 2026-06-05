import type { GedPlace } from "./types";

/**
 * Parse a `PLAC` value into its comma-separated jurisdiction hierarchy.
 * GEDCOM convention orders parts most-specific first (e.g. "City, County,
 * State, Country"). We keep the raw string and the trimmed parts.
 */
export function parsePlace(raw: string): GedPlace {
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return { raw: raw.trim(), parts };
}
