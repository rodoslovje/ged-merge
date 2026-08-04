import type { Dataset, GedEvent, Individual } from "../gedcom/types";
import { childrenNames, fatherName, findEvent, motherName, parentNames, partnerNames } from "./relatives";

/**
 * Caches for the per-individual lookups scoring needs (relatives, marriage
 * events, birth/death). These don't depend on the *pair* being scored, only
 * on the individual — but in a dense block (a common surname matched against
 * thousands of main records, or vice versa) the same individual is scored
 * against many counterparts, so without caching this work is redone for every
 * pairing. Keyed by object identity: edits always produce a fresh `Individual`
 * (see `rebuildIndividual` in gedcom/edit.ts) rather than mutating in place,
 * so a stale cache entry is simply orphaned, never an inconsistency risk.
 */
function memoize<R>(fn: (indi: Individual, ds: Dataset) => R): (indi: Individual, ds: Dataset) => R {
  const cache = new WeakMap<Individual, R>();
  return (indi, ds) => {
    // has(), not a get() !== undefined check: "no father" IS the memoized
    // answer for every terminal ancestor, and treating it as a miss redid
    // the family walk several times per scored pair in the O(main×compare)
    // loop — precisely where the cache matters most.
    if (cache.has(indi)) return cache.get(indi) as R;
    const value = fn(indi, ds);
    cache.set(indi, value);
    return value;
  };
}

export const cachedParentNames = memoize(parentNames);
export const cachedPartnerNames = memoize(partnerNames);
export const cachedChildrenNames = memoize(childrenNames);
export const cachedFatherName = memoize(fatherName);
export const cachedMotherName = memoize(motherName);

/** MARR events across all families where the person is a spouse. */
function marriageEvents(indi: Individual, ds: Dataset): GedEvent[] {
  const out: GedEvent[] = [];
  for (const famId of indi.spouseOf) {
    const m = ds.families.get(famId)?.events.find((e) => e.tag === "MARR");
    if (m) out.push(m);
  }
  return out;
}

export const cachedMarriageEvents = memoize(marriageEvents);

const eventCache = new WeakMap<Individual, Map<string, GedEvent | undefined>>();

/** Memoized {@link findEvent} (keyed by individual + tag, no dataset needed). */
export function cachedFindEvent(indi: Individual, tag: string): GedEvent | undefined {
  let byTag = eventCache.get(indi);
  if (!byTag) {
    byTag = new Map();
    eventCache.set(indi, byTag);
  }
  if (byTag.has(tag)) return byTag.get(tag);
  const event = findEvent(indi, tag);
  byTag.set(tag, event);
  return event;
}
