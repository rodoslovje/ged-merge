import type { Dataset, Individual } from "../gedcom/types";
import {
  individualBlockKeys,
  plausibleIndividualMatch,
  scoreIndividualPair,
  sexConflicts,
} from "./scoreIndividual";
import { soundex } from "./text";
import {
  categorize,
  DEFAULT_CONFIG,
  type IndividualCandidate,
  type MatchConfig,
  type MatchResult,
} from "./types";

/**
 * Match a compare dataset against the master.
 *
 * Two stages keep this from being O(n²): a cheap **blocking** pass groups
 * records by phonetic/decade keys so only plausible pairs get the (more
 * expensive) weighted **scoring** pass. Results are filtered to `minScore`,
 * capped per compare record, and returned sorted by score descending.
 */
export function matchDatasets(
  masterDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig = DEFAULT_CONFIG,
): MatchResult {
  return {
    individuals: matchIndividuals(masterDs, compareDs, config),
  };
}

function matchIndividuals(
  masterDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
): IndividualCandidate[] {
  const index = buildBlockIndex(masterDs.individuals.values(), (i) =>
    individualBlockKeys(i, soundex, masterDs),
  );

  const scored: IndividualCandidate[] = [];
  for (const compare of compareDs.individuals.values()) {
    const masterIds = collectCandidates(index, individualBlockKeys(compare, soundex, compareDs));
    for (const mid of masterIds) {
      const master = masterDs.individuals.get(mid)!;
      // Hard plausibility gates: different sex, dissimilar names, or
      // incompatible lifespans => never the same person; skip before scoring.
      if (sexConflicts(master, compare)) continue;
      if (!plausibleIndividualMatch(master, compare, config.gates, masterDs, compareDs)) continue;
      const cand = scoreIndividualPair(master, compare, masterDs, compareDs, config);
      if (cand.score / 100 >= config.minScore) scored.push(cand);
    }
  }
  const linked = linkByRelationships(assignOneToOne(scored), masterDs, compareDs, config);
  return boostByMatchedRelatives(linked, masterDs, compareDs, config);
}

/**
 * Number of close relatives a confirmed pair *shares as matches* — i.e. the
 * person's spouse/child/parent is itself matched to the counterpart's spouse/
 * child/parent. This is corroboration by connection, much stronger than a
 * name/date coincidence, and (unlike the scored relative components, which only
 * compare relative *names*) it can only be computed once the assignment exists.
 */
function matchedRelativeCount(
  m: Individual,
  c: Individual,
  masterToCompare: Map<string, string>,
  masterDs: Dataset,
  compareDs: Dataset,
): number {
  const mr = relativeIds(m, masterDs);
  const cr = relativeIds(c, compareDs);
  const overlap = (masterIds: string[], compareIds: string[]) => {
    const set = new Set(compareIds);
    let n = 0;
    for (const id of masterIds) {
      const mapped = masterToCompare.get(id);
      if (mapped && set.has(mapped)) n++;
    }
    return n;
  };
  return (
    overlap(mr.spouses, cr.spouses) +
    overlap(mr.children, cr.children) +
    overlap(mr.parents, cr.parents)
  );
}

/** A person's spouse / child / parent ids, grouped by relation. */
function relativeIds(
  person: Individual,
  ds: Dataset,
): { spouses: string[]; children: string[]; parents: string[] } {
  const spouses: string[] = [];
  const children: string[] = [];
  const parents: string[] = [];
  for (const famId of person.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    const other = fam.husband === person.id ? fam.wife : fam.husband;
    if (other) spouses.push(other);
    children.push(...fam.children);
  }
  for (const famId of person.childOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    if (fam.husband) parents.push(fam.husband);
    if (fam.wife) parents.push(fam.wife);
  }
  return { spouses, children, parents };
}

/** Below this many shared matched relatives, no corroboration boost is applied. */
const STRONG_RELATIVE_COUNT = 2;

/**
 * Raise the score of any pair whose relatives are themselves matched, so a
 * record that's right-by-relationship but weak-by-name (a maiden/married name,
 * a nickname, a fuzzy birth year) still surfaces near the top of the list
 * instead of being buried — and isn't findable only via the 🌳 badge.
 *
 * Two or more matched close relatives is near-conclusive, so the score is
 * floored into the 90s (rising slightly with each extra matched relative, capped
 * below the 98–100 reserved for a perfect/near-perfect identity key). The floor
 * only ever raises a score, never lowers a stronger one.
 */
function boostByMatchedRelatives(
  matches: IndividualCandidate[],
  masterDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
): IndividualCandidate[] {
  const masterToCompare = new Map<string, string>();
  for (const a of matches) masterToCompare.set(a.masterId, a.compareId);
  for (const a of matches) {
    if (a.score >= 98) continue; // already at/above the corroboration ceiling
    const m = masterDs.individuals.get(a.masterId);
    const c = compareDs.individuals.get(a.compareId);
    if (!m || !c) continue;
    // A relationship-linked pair was connected on >=2 conclusive evidence, so it
    // always earns the floor — even if an override cascade displaced one of the
    // relatives that the post-hoc recount looks at.
    const counted = matchedRelativeCount(m, c, masterToCompare, masterDs, compareDs);
    const n = a.relationshipLinked ? Math.max(STRONG_RELATIVE_COUNT, counted) : counted;
    if (n < STRONG_RELATIVE_COUNT) continue;
    const floor = Math.min(97, 89 + n); // 2 → 91, 3 → 92, … capped at 97
    if (floor > a.score) {
      a.score = floor;
      a.category = categorize(floor / 100, config);
    }
  }
  return [...matches].sort(byScoreDesc);
}

/**
 * Relationship evidence (see {@link linkByRelationships}) needed to connect two
 * records as the same person: one point per shared matched child, plus one if
 * they also share a matched spouse. The two qualifying combinations are then:
 *  - 2+ shared matched children, or
 *  - 1 shared matched child *and* a matched spouse (the "complete the couple"
 *    case — a specific child of a specific couple has exactly one mother and one
 *    father, so a matched child + matched co-parent pins the third).
 * A lone shared child (could be a wrong child-match) or a shared spouse alone
 * (remarriage) stays below the bar, so false links are unlikely.
 */
const MIN_RELATIONSHIP_EVIDENCE = 2;

/** The (father, mother) of each family a person is a recorded child in. */
function parentFamilies(
  child: Individual,
  ds: Dataset,
): Array<{ father?: Individual; mother?: Individual }> {
  const out: Array<{ father?: Individual; mother?: Individual }> = [];
  for (const famId of child.childOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    out.push({
      father: fam.husband ? ds.individuals.get(fam.husband) : undefined,
      mother: fam.wife ? ds.individuals.get(fam.wife) : undefined,
    });
  }
  return out;
}

/**
 * Relationship-based linking pass, run after the primary score-based assignment.
 * Bootstraps from the matches already made: when a master and a compare record
 * are each a same-role parent of the same matched child(ren) — with enough
 * corroboration (see {@link MIN_RELATIONSHIP_EVIDENCE}) — they're connected as
 * the same person here, *overriding* whatever weaker name/date match either was
 * given. This recovers a parent whose name/birth differs wildly across the two
 * files (e.g. a maiden vs married surname, or a nickname like "Slavka" vs
 * "Stanislava Marija") but whose child — and often spouse — clearly match.
 */
function linkByRelationships(
  assigned: IndividualCandidate[],
  masterDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
): IndividualCandidate[] {
  const masterToCompare = new Map<string, string>();
  const compareToMaster = new Map<string, string>();
  for (const a of assigned) {
    masterToCompare.set(a.masterId, a.compareId);
    compareToMaster.set(a.compareId, a.masterId);
  }

  const matched = (m: Individual | undefined, c: Individual | undefined) =>
    !!m && !!c && masterToCompare.get(m.id) === c.id;

  // For every matched child, line up its master and compare parent families and,
  // per role, tally a co-parent pair: +1 for the shared child, and remember
  // whether the family's *other* parent is itself matched (the spouse signal).
  const votes = new Map<string, { children: number; spouse: boolean; master: Individual; compare: Individual }>();
  const note = (pM: Individual | undefined, pC: Individual | undefined, spouse: boolean) => {
    if (!pM || !pC || sexConflicts(pM, pC)) return;
    const key = `${pM.id} ${pC.id}`;
    const rec = votes.get(key) ?? { children: 0, spouse: false, master: pM, compare: pC };
    rec.children += 1;
    rec.spouse ||= spouse;
    votes.set(key, rec);
  };
  for (const [masterChildId, compareChildId] of masterToCompare) {
    const mChild = masterDs.individuals.get(masterChildId);
    const cChild = compareDs.individuals.get(compareChildId);
    if (!mChild || !cChild) continue;
    for (const mf of parentFamilies(mChild, masterDs)) {
      for (const cf of parentFamilies(cChild, compareDs)) {
        note(mf.father, cf.father, matched(mf.mother, cf.mother));
        note(mf.mother, cf.mother, matched(mf.father, cf.father));
      }
    }
  }

  const evidence = (r: { children: number; spouse: boolean }) => r.children + (r.spouse ? 1 : 0);
  const usedMaster = new Set<string>();
  const usedCompare = new Set<string>();
  const links: IndividualCandidate[] = [];
  const strongestFirst = [...votes.values()]
    .filter((r) => evidence(r) >= MIN_RELATIONSHIP_EVIDENCE)
    .sort((a, b) => evidence(b) - evidence(a));
  // How many of this pair's own relatives are matched — the corroboration the
  // link would carry. Override an existing assignment only when this is strictly
  // greater, so the pass never displaces a match that is itself as
  // relationally-corroborated (e.g. a record already paired by matching parents
  // must not be stolen by a same-named duplicate that merely shares the spouse).
  const corrob = (m: Individual, c: Individual) =>
    matchedRelativeCount(m, c, masterToCompare, masterDs, compareDs);
  for (const { master, compare } of strongestFirst) {
    if (masterToCompare.get(master.id) === compare.id) continue; // already linked
    if (usedMaster.has(master.id) || usedCompare.has(compare.id)) continue;
    const linkCorrob = corrob(master, compare);
    const oldCompareId = masterToCompare.get(master.id);
    const oldMasterId = compareToMaster.get(compare.id);
    const oldCompare = oldCompareId ? compareDs.individuals.get(oldCompareId) : undefined;
    const oldMaster = oldMasterId ? masterDs.individuals.get(oldMasterId) : undefined;
    // Skip if either record's current match is at least as corroborated.
    if (oldCompare && corrob(master, oldCompare) >= linkCorrob) continue;
    if (oldMaster && corrob(oldMaster, compare) >= linkCorrob) continue;
    const cand = scoreIndividualPair(master, compare, masterDs, compareDs, config);
    links.push({ ...cand, relationshipLinked: true });
    usedMaster.add(master.id);
    usedCompare.add(compare.id);
  }
  if (links.length === 0) return assigned;

  // Drop the previous assignment of every record a link now claims (the
  // override), then add the relationship links, keeping the by-score order.
  const linkedMaster = new Set(links.map((l) => l.masterId));
  const linkedCompare = new Set(links.map((l) => l.compareId));
  const kept = assigned.filter(
    (a) => !linkedMaster.has(a.masterId) && !linkedCompare.has(a.compareId),
  );
  return [...kept, ...links].sort(byScoreDesc);
}

/**
 * Greedy one-to-one assignment: take pairs in descending score order, keeping a
 * pair only if neither its master nor its compare record is already spoken for.
 * This is the right model for a merge (a record maps to at most one counterpart)
 * and removes the many-to-one noise of similarly-named people.
 */
function assignOneToOne<T extends { masterId: string; compareId: string; score: number }>(
  candidates: T[],
): T[] {
  const sorted = [...candidates].sort(byScoreDesc);
  const usedMaster = new Set<string>();
  const usedCompare = new Set<string>();
  const out: T[] = [];
  for (const c of sorted) {
    if (usedMaster.has(c.masterId) || usedCompare.has(c.compareId)) continue;
    usedMaster.add(c.masterId);
    usedCompare.add(c.compareId);
    out.push(c);
  }
  return out;
}

// --- blocking helpers ------------------------------------------------------

function buildBlockIndex<T>(
  records: IterableIterator<T>,
  keysOf: (record: T) => string[],
): Map<string, Set<T>> {
  const index = new Map<string, Set<T>>();
  for (const rec of records) {
    for (const key of keysOf(rec)) {
      let bucket = index.get(key);
      if (!bucket) {
        bucket = new Set<T>();
        index.set(key, bucket);
      }
      bucket.add(rec);
    }
  }
  return index;
}

function collectCandidates<T extends { id: string }>(
  index: Map<string, Set<T>>,
  keys: string[],
): Set<string> {
  const ids = new Set<string>();
  for (const key of keys) {
    const bucket = index.get(key);
    if (bucket) for (const rec of bucket) ids.add(rec.id);
  }
  return ids;
}

function byScoreDesc(a: { score: number }, b: { score: number }): number {
  return b.score - a.score;
}
