import type { Dataset, Individual } from "../gedcom/types";
import { birthYear } from "../gedcom/lifespan";

/**
 * Estimate a birth year for an individual that has none recorded, from the
 * recorded (never estimated — no chaining) birth years of direct relatives:
 *  - a partner's birth year (spouses are typically close in age),
 *  - the oldest known child's birth year minus a typical age at childbirth,
 *  - a parent's birth year plus a typical age at having a child.
 * Used only to widen blocking recall and the temporal plausibility gate for
 * otherwise-undated records — never fed into the actual score, since two
 * estimates both derived from already-matched relatives would be correlated,
 * not independent evidence, and could inflate confidence circularly.
 */

/** Midpoint age at childbirth, by the *parent's* sex (15–40 for women, 15–60 for men). */
const AGE_AT_CHILDBIRTH: Record<Individual["sex"], number> = { F: 27, M: 38, U: 32 };

/** Midpoint age at which a parent has a child (18–40), used symmetrically for either parent. */
const AGE_AT_PARENTHOOD = 29;

function partnersOf(indi: Individual, ds: Dataset): Individual[] {
  const out: Individual[] = [];
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    const otherId = fam.husband === indi.id ? fam.wife : fam.husband;
    const other = otherId ? ds.individuals.get(otherId) : undefined;
    if (other) out.push(other);
  }
  return out;
}

function childrenOf(indi: Individual, ds: Dataset): Individual[] {
  const out: Individual[] = [];
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    for (const childId of fam.children) {
      const child = ds.individuals.get(childId);
      if (child) out.push(child);
    }
  }
  return out;
}

function parentsOf(indi: Individual, ds: Dataset): Individual[] {
  const out: Individual[] = [];
  for (const famId of indi.childOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    for (const id of [fam.husband, fam.wife]) {
      const parent = id ? ds.individuals.get(id) : undefined;
      if (parent) out.push(parent);
    }
  }
  return out;
}

function rawEstimate(indi: Individual, ds: Dataset): number | undefined {
  const candidates: number[] = [];

  for (const partner of partnersOf(indi, ds)) {
    const y = birthYear(partner);
    if (y !== undefined) candidates.push(y);
  }

  const childYears = childrenOf(indi, ds)
    .map((c) => birthYear(c))
    .filter((y): y is number => y !== undefined);
  if (childYears.length > 0) {
    candidates.push(Math.min(...childYears) - AGE_AT_CHILDBIRTH[indi.sex]);
  }

  for (const parent of parentsOf(indi, ds)) {
    const y = birthYear(parent);
    if (y !== undefined) candidates.push(y + AGE_AT_PARENTHOOD);
  }

  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => a - b);
  return candidates[Math.floor(candidates.length / 2)]; // median: robust to one outlier
}

const cache = new WeakMap<Individual, number | null>();

/** Memoized {@link rawEstimate} (the same individual is checked repeatedly
 *  across many candidate pairs in a dense block). */
export function estimatedBirthYear(indi: Individual, ds: Dataset): number | undefined {
  const cached = cache.get(indi);
  if (cached !== undefined) return cached === null ? undefined : cached;
  const value = rawEstimate(indi, ds);
  cache.set(indi, value ?? null);
  return value;
}
