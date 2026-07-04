import type { GedDate, GedPlace, PersonName } from "../gedcom/types";
import { parseDate } from "../gedcom/date";
import { localityParts } from "../gedcom/place";
import { canonicalPlaceToken } from "./place";
import { compareKey, foldToken, isPlaceholderName, jaroWinkler } from "./text";

/**
 * Field-level similarity functions. Each returns a score in 0..1, or
 * `undefined` when there isn't enough data on both sides to compare — callers
 * skip undefined components rather than penalizing missing data.
 */

/**
 * A name reduced to its comparable parts: placeholder tokens ("Living",
 * "NN", "?Ime?", "?" — see {@link isPlaceholderName}) are dropped, because
 * two placeholders compare as a perfect match while identifying nothing.
 * Returns the input object unchanged when nothing needed filtering, and
 * undefined when no part survives — callers then treat the name as missing
 * (key-field penalty, skipped component, no blocking key), exactly as if the
 * record had no name at all.
 */
export function comparableName(n: PersonName | undefined): PersonName | undefined {
  if (!n) return undefined;
  const given = n.given && !isPlaceholderName(n.given) ? n.given : undefined;
  const surname = n.surname && !isPlaceholderName(n.surname) ? n.surname : undefined;
  const full = n.full && !isPlaceholderName(n.full) ? n.full : "";
  if (given === n.given && surname === n.surname && full === n.full) return n;
  if (!given && !surname && !full) return undefined;
  return { ...n, given, surname, full };
}

export function nameSimilarity(a: PersonName, b: PersonName): number | undefined {
  const parts: Array<[number, number]> = []; // [weight, score]

  if (a.surname && b.surname) {
    parts.push([0.6, jaroWinkler(foldToken(a.surname), foldToken(b.surname))]);
  }
  if (a.given && b.given) {
    parts.push([0.4, givenSimilarity(a.given, b.given)]);
  }
  if (parts.length === 0) {
    // Fall back to comparing the full reconstructed names.
    if (a.full && b.full) return jaroWinkler(foldToken(a.full), foldToken(b.full));
    return undefined;
  }
  const wsum = parts.reduce((s, [w]) => s + w, 0);
  return parts.reduce((s, [w, v]) => s + w * v, 0) / wsum;
}

/** Compare given names token-wise so middle names / ordering matter less. */
export function givenSimilarity(a: string, b: string): number {
  const at = foldToken(a).split(" ").filter(Boolean);
  const bt = foldToken(b).split(" ").filter(Boolean);
  if (at.length === 0 || bt.length === 0) return jaroWinkler(foldToken(a), foldToken(b));
  // Best-match average from the shorter set into the longer set.
  const [small, large] = at.length <= bt.length ? [at, bt] : [bt, at];
  const total = small.reduce(
    (s, x) => s + Math.max(...large.map((y) => jaroWinkler(x, y))),
    0,
  );
  return total / small.length;
}

export function dateSimilarity(a: GedDate | undefined, b: GedDate | undefined): number | undefined {
  if (!a?.year || !b?.year) return undefined;

  // BEF/AFT/BET..AND/FROM/TO assert a *bound* on the true date, not a fuzzy
  // point estimate around it (unlike ABT): a date arbitrarily far on the
  // correct side of the boundary is fully consistent, not a disagreement.
  const bound = boundSimilarity(a, b);
  if (bound !== undefined) return bound;

  const approx = isApprox(a) || isApprox(b);
  const tolerance = approx ? 10 : 4;
  const diff = Math.abs(a.year - b.year);
  if (diff > tolerance) return 0;
  if (diff !== 0) return 1 - diff / (tolerance + 1);

  // Same year. A perfect 1.0 is reserved for two exact *day-precision* dates
  // that agree in full. Anything less is a strong but imperfect match:
  //  - a genuine disagreement (different month, or different day same month),
  //  - a precision mismatch, e.g. a full date vs a bare year ("12 JAN 1900" vs
  //    "1900") — they're consistent but not the same assertion,
  //  - an approximate qualifier (ABT/EST/~) — the year isn't asserted exactly,
  //  - two bare years (or bare months) that agree: "1709" ~ "1709" merely
  //    shares a year — in a dense cluster two same-named people born the same
  //    year are routine, and scoring this like a day-exact birth match
  //    inflated sparse pairs into the strong band (and, via the perfect
  //    identity key, to flat 100s).
  if (a.month && b.month && a.month !== b.month) return 0.55; // different month
  if (a.day && b.day && a.day !== b.day) return 0.9; // same month, different day

  const dayPrecise = (d: GedDate) => d.day !== undefined && d.month !== undefined;
  const exact = !approx && dayPrecise(a) && dayPrecise(b);
  return exact ? 1 : 0.9;
}

function isApprox(d: GedDate): boolean {
  return d.qualifier !== "exact";
}

/** Qualifiers that assert a bound on the true date rather than a fuzzy point
 *  estimate around it. */
const BOUND_QUALIFIERS = new Set<GedDate["qualifier"]>(["before", "after", "between", "range", "from", "to"]);

/** The [lo, hi] year range a date's qualifier asserts the true date falls
 *  within (a point — [year, year] — for non-bound qualifiers). */
function boundRange(d: GedDate): [number, number] {
  switch (d.qualifier) {
    case "before":
    case "to":
      return [-Infinity, d.year!];
    case "after":
    case "from":
      return [d.year!, Infinity];
    case "between":
    case "range": {
      const hi = d.year2 ?? d.year!;
      return d.year! <= hi ? [d.year!, hi] : [hi, d.year!];
    }
    default:
      return [d.year!, d.year!];
  }
}

/**
 * Similarity for a pair where at least one side asserts a bound (BEF/AFT/
 * BET..AND/FROM/TO); undefined when neither does, so the caller falls back
 * to the point-estimate comparison above. A date inside the other side's
 * asserted bound is fully consistent regardless of how far from the boundary
 * it sits — short of an exact match (1.0 is reserved for that), but no real
 * disagreement either. A date outside the bound is a genuine conflict,
 * scored down by how far outside using the same decay curve as the
 * point-estimate case.
 */
function boundSimilarity(a: GedDate, b: GedDate): number | undefined {
  if (!BOUND_QUALIFIERS.has(a.qualifier) && !BOUND_QUALIFIERS.has(b.qualifier)) return undefined;
  const [aLo, aHi] = boundRange(a);
  const [bLo, bHi] = boundRange(b);
  if (aLo <= bHi && bLo <= aHi) return 0.9; // ranges overlap (or one is a point inside the other's)
  const gap = aLo > bHi ? aLo - bHi : bLo - aHi;
  const tolerance = 10;
  return gap > tolerance ? 0 : 1 - gap / (tolerance + 1);
}

export function placeSimilarity(
  a: GedPlace | undefined,
  b: GedPlace | undefined,
): number | undefined {
  if (!a || !b) return undefined;

  // Compare locality (without the house number) so a fuzzy spelling match
  // doesn't accidentally equate two different houses in the same village.
  // canonicalPlaceToken folds case/diacritics and unifies country-name variants
  // (Slovenia/Slovenija) so those don't count as a difference.
  const ap = localityParts(a).map(canonicalPlaceToken).filter(Boolean);
  const bp = localityParts(b).map(canonicalPlaceToken).filter(Boolean);
  if (ap.length === 0 || bp.length === 0) {
    if (a.raw && b.raw) return jaroWinkler(foldToken(a.raw), foldToken(b.raw));
    return undefined;
  }
  const locality = partsOverlap(ap, bp);

  // House-number detail is decisive when both sides have it: same number makes
  // the place specific and strong; a different number means a different place.
  const ad = a.detail?.toLowerCase();
  const bd = b.detail?.toLowerCase();
  if (ad && bd) {
    return ad === bd ? 0.5 + 0.5 * locality : 0.5 * locality;
  }
  return locality;
}

/** Fraction of the smaller hierarchy whose parts find a close match. */
function partsOverlap(ap: string[], bp: string[]): number {
  const [small, large] = ap.length <= bp.length ? [ap, bp] : [bp, ap];
  const matched = small.reduce(
    (s, x) => s + Math.max(...large.map((y) => jaroWinkler(x, y))),
    0,
  );
  return matched / small.length;
}

/** Symmetric set similarity over names (for parents, partners, children). */
export function nameSetSimilarity(
  a: PersonName[],
  b: PersonName[],
): number | undefined {
  // Ignore blank/placeholder names so they neither match nor penalize.
  const av = a.map(comparableName).filter(isPresent).filter(hasNameContent);
  const bv = b.map(comparableName).filter(isPresent).filter(hasNameContent);
  if (av.length === 0 || bv.length === 0) return undefined;
  const oneWay = (xs: PersonName[], ys: PersonName[]) =>
    xs.reduce((s, x) => {
      const best = Math.max(...ys.map((y) => nameSimilarity(x, y) ?? 0));
      return s + best;
    }, 0) / xs.length;
  return (oneWay(av, bv) + oneWay(bv, av)) / 2;
}

function hasNameContent(n: PersonName): boolean {
  return Boolean(n.surname || n.given || n.full);
}

function isPresent<T>(x: T | undefined): x is T {
  return x !== undefined;
}

/**
 * Symmetric set similarity over given names only. For relatives who share the
 * person's own family surname by construction — children, or the father in a
 * parent comparison — full-name similarity is inflated: the surname part
 * (weighted 0.6 in `nameSimilarity`) matches for any two families the pair's
 * own surname gate already found similar, so two entirely different sets of
 * children still scored ~0.6+. Only the given names discriminate, so only
 * they are compared. Members without a given name are ignored; undefined when
 * either side has none left.
 */
export function givenNameSetSimilarity(
  a: PersonName[],
  b: PersonName[],
): number | undefined {
  const av = a.map((n) => comparableName(n)?.given).filter((g): g is string => Boolean(g));
  const bv = b.map((n) => comparableName(n)?.given).filter((g): g is string => Boolean(g));
  if (av.length === 0 || bv.length === 0) return undefined;
  const oneWay = (xs: string[], ys: string[]) =>
    xs.reduce((s, x) => s + Math.max(...ys.map((y) => givenSimilarity(x, y))), 0) / xs.length;
  return (oneWay(av, bv) + oneWay(bv, av)) / 2;
}

/**
 * Canonical comparison key for a raw date string. Semantic equivalents like
 * "Abt. 1900" and "ABT 1900" produce the same key; unparseable dates fall back
 * to `compareKey`. Used by the review diff's agree/conflict detection so it
 * agrees with `dateSimilarity`'s date parsing.
 */
export function dateCompareKey(value: string): string {
  const d = parseDate(value);
  if (d.qualifier === "unknown") return compareKey(value);
  return [d.qualifier, d.year, d.month, d.day, d.year2, d.month2, d.day2].join("|");
}
