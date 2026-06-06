import { foldToken } from "./text";

/**
 * Canonicalize a single place part for comparison: fold case/diacritics, drop
 * whitespace, and map known country-name variants to a single canonical token.
 * Used by both the matcher and the review diff so they agree on what counts as
 * "the same place".
 */
export function canonicalPlaceToken(part: string): string {
  const folded = foldToken(part).replace(/\s+/g, "");
  return COUNTRY_CANONICAL.get(folded) ?? folded;
}

/**
 * Groups of equivalent country names (folded, diacritic-stripped, no spaces).
 * The first entry is the canonical form. Extend as needed.
 */
const COUNTRY_GROUPS: string[][] = [
  ["slovenia", "slovenija"],
  ["austria", "osterreich", "avstrija"],
  ["germany", "deutschland", "nemcija"],
  ["italy", "italia", "italija"],
  ["croatia", "hrvatska", "hrvaska"],
  ["hungary", "magyarorszag", "madzarska", "ogrska"],
  ["serbia", "srbija"],
  ["france", "francija"],
  ["switzerland", "schweiz", "svica"],
  ["unitedstates", "usa", "unitedstatesofamerica", "zda", "amerika"],
  ["yugoslavia", "jugoslavija"],
  ["austriahungary", "avstroogrska", "austrohungarianempire"],
];

const COUNTRY_CANONICAL: Map<string, string> = new Map(
  COUNTRY_GROUPS.flatMap((group) => group.map((variant) => [variant, group[0]] as const)),
);
