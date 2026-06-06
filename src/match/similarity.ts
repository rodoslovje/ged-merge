import type { GedDate, GedPlace, PersonName } from "../gedcom/types";
import { localityParts } from "../gedcom/place";
import { canonicalPlaceToken } from "./place";
import { foldToken, jaroWinkler } from "./text";

/**
 * Field-level similarity functions. Each returns a score in 0..1, or
 * `undefined` when there isn't enough data on both sides to compare — callers
 * skip undefined components rather than penalizing missing data.
 */

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

  const approx = isApprox(a) || isApprox(b);
  const tolerance = approx ? 10 : 4;
  const diff = Math.abs(a.year - b.year);
  if (diff > tolerance) return 0;
  if (diff !== 0) return 1 - diff / (tolerance + 1);

  // Same year. A perfect 1.0 is reserved for two exact dates of equal precision
  // that agree in full. Anything less is a strong but imperfect match:
  //  - a genuine disagreement (different month, or different day same month),
  //  - a precision mismatch, e.g. a full date vs a bare year ("12 JAN 1900" vs
  //    "1900") — they're consistent but not the same assertion,
  //  - an approximate qualifier (ABT/EST/~) — the year isn't asserted exactly.
  if (a.month && b.month && a.month !== b.month) return 0.55; // different month
  if (a.day && b.day && a.day !== b.day) return 0.9; // same month, different day

  const precision = (d: GedDate) => (d.day ? 3 : d.month ? 2 : 1);
  const exact = !approx && precision(a) === precision(b);
  return exact ? 1 : 0.9;
}

function isApprox(d: GedDate): boolean {
  return d.qualifier !== "exact";
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
  const av = a.filter(hasNameContent);
  const bv = b.filter(hasNameContent);
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
