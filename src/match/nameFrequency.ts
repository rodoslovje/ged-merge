import type { Dataset, Individual, PersonName } from "../gedcom/types";
import { eraYear } from "./birthEstimate";
import { givenVariantKey } from "./givenVariants";
import { primaryName } from "./relatives";
import { comparableName } from "./similarity";
import { foldToken } from "./text";
import { DEFAULT_CONFIG } from "./types";

/**
 * How many people in the candidate pool carry a given full name — the
 * evidence a name agreement is worth.
 *
 * A full-name match on "Svitoslav Peruzzi" is near-conclusive; one on "Janez
 * Novak" is barely evidence, yet a scorer that weighs the name components by
 * a fixed weight cannot tell them apart. In an index-scale file every pair of
 * same-named skeleton records (a ubiquitous name, an estimated year, nothing
 * else) then scores like a real match, tens of thousands of times over. The
 * quantity that separates the two is not the name's share of the file but
 * its **namesake count in the pool**: the number of *other* records carrying
 * an equivalent full name within the era window the gates admit — literally
 * how many people the record could be. Counting inside the window keeps a
 * name that recurs once per generation for three centuries from reading as
 * common, and counting records rather than shares keeps a family tree from
 * reading its own surname as ubiquitous merely because the tree is about it.
 *
 * Equivalence is the scorer's own: the surname folded, the first given-name
 * token mapped through the cross-language table (`givenVariantKey`), so Janez,
 * Johann and Ivan Novak count as one name — the same forms the gates and the
 * given-name comparison treat as one. A record lacking either part has no
 * key and no namesakes: it cannot anchor a pair on its full name anyway.
 *
 * Built once per matching run over the pool — both files for a cross-file
 * match, the file itself for the duplicate finder — in one pass, then
 * answered per individual (memoized) with a binary search. Absent from a
 * scoring call, the scorer behaves as if every name were unique, which is the
 * pre-2026-09 behaviour and what the single-pair callers (the genealogical-
 * index import) still get.
 */
export interface NameFrequencies {
  /**
   * Other people in the pool the pair's name could be: bearers of either
   * side's full name within the era window around the pair's year — the
   * dated side's, so an undated record is counted in the era its counterpart
   * places it in rather than against every bearer in three centuries; all
   * eras only when neither side has a year. The larger of the two sides'
   * counts (a name common in either file is ambiguous for the pair), with
   * the two records themselves left out — a rare name present once in each
   * file is unique, not "one namesake".
   */
  pairNamesakes(a: Individual, dsA: Dataset, b: Individual, dsB: Dataset): number;
  /**
   * Other people in the pool with an equivalent full name within `span` years
   * of `year` (all eras when `year` is undefined) — for a relative's name,
   * whose own record is not at hand: pass the person's year and a span wide
   * enough to cover a parent's or partner's generation. Also excludes one
   * record as the bearer's own.
   */
  namesakesOf(name: PersonName | undefined, year: number | undefined, span: number): number;
}

interface Bearers {
  /** Representative years of the dated bearers, sorted after the build. */
  years: number[];
  /** Bearers with no usable year — in every window. */
  undated: number;
}

/** The pool key of a name: folded surname plus the canonical first given
 *  token, or undefined when either part is missing (placeholders included —
 *  the name is expected to have gone through `comparableName`). */
export function nameKey(name: PersonName | undefined): string | undefined {
  if (!name?.surname || !name.given) return undefined;
  const given = foldToken(name.given).split(" ")[0];
  if (!given) return undefined;
  const variant = givenVariantKey(given);
  return `${foldToken(name.surname)}|${variant !== undefined ? `#${variant}` : given}`;
}

/** Index of the largest element strictly below `value` plus one — the number
 *  of elements < value in a sorted array. */
function lowerBound(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function countWithin(b: Bearers, year: number | undefined, span: number): number {
  if (year === undefined) return b.years.length + b.undated;
  return lowerBound(b.years, year + span + 1) - lowerBound(b.years, year - span) + b.undated;
}

/**
 * Count every full name in the pool. `window` is the era gate's half-width:
 * two records further apart are never compared, so a namesake outside it is
 * not a candidate the name has to tell apart.
 */
export function buildNameFrequencies(
  pools: readonly Dataset[],
  window: number = DEFAULT_CONFIG.gates.maxYearGap,
): NameFrequencies {
  const bearers = new Map<string, Bearers>();
  for (const ds of pools) {
    for (const indi of ds.individuals.values()) {
      const key = nameKey(comparableName(primaryName(indi)));
      if (key === undefined) continue;
      let b = bearers.get(key);
      if (!b) bearers.set(key, (b = { years: [], undated: 0 }));
      const year = eraYear(indi, ds);
      if (year === undefined) b.undated++;
      else b.years.push(year);
    }
  }
  for (const b of bearers.values()) b.years.sort((x, y) => x - y);

  const count = (key: string | undefined, year: number | undefined, span: number): number => {
    const b = key === undefined ? undefined : bearers.get(key);
    return b ? countWithin(b, year, span) : 0;
  };
  // Per-individual memo of the name key and era year — the two lookups every
  // pair the individual takes part in repeats.
  const memo = new WeakMap<Individual, { key: string | undefined; year: number | undefined }>();
  const profile = (indi: Individual, ds: Dataset) => {
    let p = memo.get(indi);
    if (!p) {
      p = { key: nameKey(comparableName(primaryName(indi))), year: eraYear(indi, ds) };
      memo.set(indi, p);
    }
    return p;
  };
  return {
    pairNamesakes(a, dsA, b, dsB) {
      const pa = profile(a, dsA);
      const pb = profile(b, dsB);
      const year = pa.year ?? pb.year;
      // Each record is itself among its key's bearers (dated within the
      // window it centres, or undated and so in every window); when the two
      // share the key the counterpart is in the count too.
      if (pa.key !== undefined && pa.key === pb.key) return Math.max(0, count(pa.key, year, window) - 2);
      return Math.max(0, count(pa.key, year, window) - 1, count(pb.key, year, window) - 1);
    },
    namesakesOf(name, year, span) {
      return Math.max(0, count(nameKey(name), year, span) - 1);
    },
  };
}

const perDataset = new WeakMap<Dataset, { window: number; size: number; freq: NameFrequencies }>();

/**
 * The counts of one file, memoized on the dataset. Within-file callers score
 * a single pair on demand (a related pair surfaced by a merge, on the main
 * thread), where a full pass per call would be too much; the index is rebuilt
 * when the record count changes (a merge removed one), while a renamed record
 * leaves a count at most one off — nothing a threshold of a few notices.
 */
export function nameFrequenciesFor(ds: Dataset, window: number = DEFAULT_CONFIG.gates.maxYearGap): NameFrequencies {
  const cached = perDataset.get(ds);
  if (cached && cached.window === window && cached.size === ds.individuals.size) return cached.freq;
  const freq = buildNameFrequencies([ds], window);
  perDataset.set(ds, { window, size: ds.individuals.size, freq });
  return freq;
}
