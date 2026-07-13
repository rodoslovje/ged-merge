import type { Dataset, Individual } from "../gedcom/types";
import {
  individualBlockKeys,
  plausibleIndividualMatch,
  scoreIndividualPair,
  sexConflicts,
} from "./scoreIndividual";
import { birthYear } from "../gedcom/lifespan";
import { differentGiven, parentsVerdict } from "./similarity";
import { clearTextCaches, soundex } from "./text";
import {
  categorize,
  DEFAULT_CONFIG,
  type IncomingDuplicateCluster,
  type IndividualCandidate,
  type MatchConfig,
  type MatchResult,
} from "./types";

/**
 * Match a compare dataset against the main.
 *
 * Two stages keep this from being O(n²): a cheap **blocking** pass groups
 * records by phonetic/decade keys so only plausible pairs get the (more
 * expensive) weighted **scoring** pass. Results are filtered to `minScore`,
 * capped per compare record, and returned sorted by score descending.
 */
export function matchDatasets(
  mainDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig = DEFAULT_CONFIG,
): MatchResult {
  // Reset the fold/jaro-winkler memo caches so the (per-run) jaro-winkler pair
  // cache can't accumulate across reloads; both fill back up within this run.
  clearTextCaches();
  return matchIndividuals(mainDs, compareDs, config);
}

function matchIndividuals(
  mainDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
): MatchResult {
  const index = buildBlockIndex(mainDs.individuals.values(), (i) =>
    individualBlockKeys(i, soundex, mainDs),
  );

  // Identity pre-pass: two records carrying the same `_UID`/`UID` are the same
  // person by construction (both exports came from the same software lineage),
  // regardless of what names/dates say. These pairs bypass blocking and gates,
  // score a flat 100, and are placed first so the greedy 1:1 assignment always
  // keeps them.
  const uidPairs = matchByUid(mainDs, compareDs, config);
  const uidMain = new Set(uidPairs.map((p) => p.mainId));
  const uidCompare = new Set(uidPairs.map((p) => p.compareId));

  const scored: IndividualCandidate[] = [...uidPairs];
  for (const compare of compareDs.individuals.values()) {
    if (uidCompare.has(compare.id)) continue; // identity already established
    const mainIds = collectCandidates(index, individualBlockKeys(compare, soundex, compareDs));
    for (const mid of mainIds) {
      const main = mainDs.individuals.get(mid)!;
      // Hard plausibility gates: different sex, dissimilar names, or
      // incompatible lifespans => never the same person; skip before scoring.
      if (sexConflicts(main, compare)) continue;
      if (!plausibleIndividualMatch(main, compare, config.gates, mainDs, compareDs)) continue;
      const cand = scoreIndividualPair(main, compare, mainDs, compareDs, config);
      if (cand.score / 100 >= config.minScore) scored.push(cand);
    }
  }
  const linked = linkByRelationships(assignOneToOne(scored), mainDs, compareDs, config, uidMain, uidCompare);
  const individuals = boostByMatchedRelatives(linked, mainDs, compareDs, config);
  const incomingDuplicates = findIncomingDuplicateClusters(scored, individuals, compareDs, config);
  return incomingDuplicates.length ? { individuals, incomingDuplicates } : { individuals };
}

/**
 * Canonical form of a `_UID`/`UID` value for equality: brace/dash/space
 * variants of the same GUID compare equal ("{D15EB48F-…}" ↔ "d15eb48f…").
 * Values too short to plausibly be unique identifiers are rejected — a junk
 * value like "1" on many records must not weld them together.
 */
function canonicalUid(value: string): string | undefined {
  const v = value.replace(/[{}\s-]/g, "").toUpperCase();
  return v.length >= 12 ? v : undefined;
}

/** uid → record id for every *unambiguous* uid in the dataset (a uid carried
 *  by two records in one file identifies nothing and is skipped). */
function uidIndex(ds: Dataset): Map<string, string> {
  const byUid = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const indi of ds.individuals.values()) {
    for (const raw of indi.uids ?? []) {
      const uid = canonicalUid(raw);
      if (!uid || ambiguous.has(uid)) continue;
      const seen = byUid.get(uid);
      if (seen !== undefined && seen !== indi.id) {
        byUid.delete(uid);
        ambiguous.add(uid);
      } else {
        byUid.set(uid, indi.id);
      }
    }
  }
  return byUid;
}

/** The certain pre-matches: pairs sharing an unambiguous record identifier. */
function matchByUid(
  mainDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
): IndividualCandidate[] {
  const mainByUid = uidIndex(mainDs);
  if (mainByUid.size === 0) return [];
  const compareByUid = uidIndex(compareDs);
  if (compareByUid.size === 0) return [];

  const pairs: IndividualCandidate[] = [];
  const usedMain = new Set<string>();
  const usedCompare = new Set<string>();
  for (const [uid, mainId] of mainByUid) {
    const compareId = compareByUid.get(uid);
    if (!compareId || usedMain.has(mainId) || usedCompare.has(compareId)) continue;
    const main = mainDs.individuals.get(mainId);
    const compare = compareDs.individuals.get(compareId);
    if (!main || !compare) continue;
    usedMain.add(mainId);
    usedCompare.add(compareId);
    // Score the pair normally so the UI still gets the field-by-field
    // breakdown, then override the verdict: identity is not a probability.
    const cand = scoreIndividualPair(main, compare, mainDs, compareDs, config);
    cand.score = 100;
    cand.category = categorize(1, config);
    cand.uidMatched = true;
    pairs.push(cand);
  }
  return pairs;
}

/**
 * Minimum direct similarity (0..100) between the matched record and a runner-up
 * before they're consolidated. The shared-main signal only *surfaces* the
 * candidate; this is the real gate. Set high so a same-named look-alike a common
 * main also attracts — a different surname (soundex collision) or a birth year
 * many years off — stays below it, while a true duplicate (same surname, birth
 * within a year or two) clears it. Erring high means missed consolidations
 * (harmless — the duplicate just shows in the tree as before), never wrong merges.
 */
const DUP_PAIR_SCORE = 85;
/** Max birth-year gap tolerated between duplicate copies. Small enough to reject
 *  a namesake parent/child (decades apart) but to allow a transcription slip. */
const DUP_MAX_YEAR_DIFF = 3;

/** Birth years known on both sides and too far apart to be one person. */
function birthYearsTooFar(a: Individual, b: Individual): boolean {
  const ya = birthYear(a);
  const yb = birthYear(b);
  if (ya === undefined || yb === undefined) return false;
  return Math.abs(ya - yb) > DUP_MAX_YEAR_DIFF;
}

/**
 * Find incoming records that are the same person split across duplicates. The
 * reliable signal is that several incoming records all match the *same* main
 * person: the runner-ups that lost the one-to-one assignment to the matched
 * record are its duplicates. (A within-file pass can't catch these — duplicate
 * copies in an index export often differ in birth year and share no relatives;
 * only the common main ties them together.) Vetoes obvious distinct relatives
 * (different given name, conflicting parents) but, unlike the within-file finder,
 * tolerates a birth-year difference — the whole point here.
 */
function findIncomingDuplicateClusters(
  scored: IndividualCandidate[],
  matches: IndividualCandidate[],
  compareDs: Dataset,
  config: MatchConfig,
): IncomingDuplicateCluster[] {
  const matchedCompare = new Set(matches.map((m) => m.compareId));
  const winnerOf = new Map(matches.map((m) => [m.mainId, m.compareId]));
  const byMain = new Map<string, IndividualCandidate[]>();
  for (const s of scored) {
    const arr = byMain.get(s.mainId);
    if (arr) arr.push(s);
    else byMain.set(s.mainId, [s]);
  }

  const consumed = new Set<string>(); // each incoming id consolidated at most once
  const clusters: IncomingDuplicateCluster[] = [];
  for (const [mainId, keepId] of winnerOf) {
    if (consumed.has(keepId)) continue;
    const cands = byMain.get(mainId);
    const keep = compareDs.individuals.get(keepId);
    if (!cands || !keep) continue;
    const mergeIds: string[] = [];
    for (const s of cands) {
      if (s.compareId === keepId || consumed.has(s.compareId)) continue;
      if (matchedCompare.has(s.compareId)) continue; // matched to another main → distinct
      const cand = compareDs.individuals.get(s.compareId);
      if (!cand) continue;
      // Hard vetoes a weighted-average score can't be trusted to enforce:
      // a distinct sibling (given name), a namesake (birth years far apart), or
      // a same-named cousin (conflicting parents) is never one person.
      if (differentGiven(keep, cand) || birthYearsTooFar(keep, cand) || parentsVerdict(keep, cand, compareDs) === "conflict") continue;
      // The strong gate: the two incoming records must be a direct duplicate of
      // each other, not merely two look-alikes of the same main.
      if (scoreIndividualPair(keep, cand, compareDs, compareDs, config).score < DUP_PAIR_SCORE) continue;
      mergeIds.push(s.compareId);
      consumed.add(s.compareId);
    }
    if (mergeIds.length) {
      clusters.push({ keepId, mergeIds });
      consumed.add(keepId);
    }
  }
  return clusters;
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
  mainToCompare: Map<string, string>,
  scoreOf: Map<string, number>,
  mainDs: Dataset,
  compareDs: Dataset,
): number {
  const mr = relativeIds(m, mainDs);
  const cr = relativeIds(c, compareDs);
  const overlap = (mainIds: string[], compareIds: string[]) => {
    const set = new Set(compareIds);
    let n = 0;
    for (const id of mainIds) {
      const mapped = mainToCompare.get(id);
      // Only a confidently-matched relative corroborates (see the threshold).
      if (mapped && set.has(mapped) && (scoreOf.get(id) ?? 0) >= CONFIDENT_RELATIVE_SCORE) n++;
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
 * Minimum score a relative's *own* match must have for it to count as
 * corroboration. Relationship evidence is only as trustworthy as the relative
 * matches it builds on: two different families with similar surnames (e.g.
 * Jakofčič ↔ Jakopič, scoring ~75) can get cross-matched by the greedy pass, and
 * without this gate those weak matches would compound into a confident-looking
 * (but wrong) parent link. Genuine relative matches score 95–100, so this cleanly
 * keeps them while dropping the ~75 noise.
 */
const CONFIDENT_RELATIVE_SCORE = 85;

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
  mainDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
): IndividualCandidate[] {
  const mainToCompare = new Map<string, string>();
  const scoreOf = new Map<string, number>();
  for (const a of matches) {
    mainToCompare.set(a.mainId, a.compareId);
    scoreOf.set(a.mainId, a.score);
  }
  for (const a of matches) {
    if (a.score >= 98) continue; // already at/above the corroboration ceiling
    const m = mainDs.individuals.get(a.mainId);
    const c = compareDs.individuals.get(a.compareId);
    if (!m || !c) continue;
    // A relationship-linked pair was connected on >=2 conclusive evidence, so it
    // always earns the floor — even if an override cascade displaced one of the
    // relatives that the post-hoc recount looks at.
    const counted = matchedRelativeCount(m, c, mainToCompare, scoreOf, mainDs, compareDs);
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
 * Bootstraps from the matches already made: when a main and a compare record
 * are each a same-role parent of the same matched child(ren) — with enough
 * corroboration (see {@link MIN_RELATIONSHIP_EVIDENCE}) — they're connected as
 * the same person here, *overriding* whatever weaker name/date match either was
 * given. This recovers a parent whose name/birth differs wildly across the two
 * files (e.g. a maiden vs married surname, or a nickname like "Slavka" vs
 * "Stanislava Marija") but whose child — and often spouse — clearly match.
 */
function linkByRelationships(
  assigned: IndividualCandidate[],
  mainDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
  /** Records pre-matched by a shared `_UID` — certain identity a relationship
   *  link must never displace. */
  uidMain: Set<string> = new Set(),
  uidCompare: Set<string> = new Set(),
): IndividualCandidate[] {
  const mainToCompare = new Map<string, string>();
  const compareToMain = new Map<string, string>();
  const scoreOf = new Map<string, number>();
  for (const a of assigned) {
    mainToCompare.set(a.mainId, a.compareId);
    compareToMain.set(a.compareId, a.mainId);
    scoreOf.set(a.mainId, a.score);
  }

  // A relative only corroborates if its own match is confident (see threshold) —
  // otherwise weak greedy mis-matches (different families, similar surnames) would
  // compound into confident-looking but wrong parent links.
  const confident = (mainId: string) => (scoreOf.get(mainId) ?? 0) >= CONFIDENT_RELATIVE_SCORE;
  const matchedConfident = (m: Individual | undefined, c: Individual | undefined) =>
    !!m && !!c && mainToCompare.get(m.id) === c.id && confident(m.id);

  // For every confidently-matched child, line up its main and compare parent
  // families and, per role, tally a co-parent pair: +1 for the shared child, and
  // remember whether the family's *other* parent is itself confidently matched.
  const votes = new Map<string, { children: number; spouse: boolean; main: Individual; compare: Individual }>();
  const note = (pM: Individual | undefined, pC: Individual | undefined, spouse: boolean) => {
    if (!pM || !pC || sexConflicts(pM, pC)) return;
    const key = `${pM.id} ${pC.id}`;
    const rec = votes.get(key) ?? { children: 0, spouse: false, main: pM, compare: pC };
    rec.children += 1;
    rec.spouse ||= spouse;
    votes.set(key, rec);
  };
  for (const [mainChildId, compareChildId] of mainToCompare) {
    if (!confident(mainChildId)) continue; // a weak child match is not evidence
    const mChild = mainDs.individuals.get(mainChildId);
    const cChild = compareDs.individuals.get(compareChildId);
    if (!mChild || !cChild) continue;
    for (const mf of parentFamilies(mChild, mainDs)) {
      for (const cf of parentFamilies(cChild, compareDs)) {
        note(mf.father, cf.father, matchedConfident(mf.mother, cf.mother));
        note(mf.mother, cf.mother, matchedConfident(mf.father, cf.father));
      }
    }
  }

  const evidence = (r: { children: number; spouse: boolean }) => r.children + (r.spouse ? 1 : 0);
  const usedMain = new Set<string>();
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
    matchedRelativeCount(m, c, mainToCompare, scoreOf, mainDs, compareDs);
  for (const { main, compare } of strongestFirst) {
    if (mainToCompare.get(main.id) === compare.id) continue; // already linked
    if (usedMain.has(main.id) || usedCompare.has(compare.id)) continue;
    // Never displace an identity established by a shared record uid.
    if (uidMain.has(main.id) || uidCompare.has(compare.id)) continue;
    const linkCorrob = corrob(main, compare);
    const oldCompareId = mainToCompare.get(main.id);
    const oldMainId = compareToMain.get(compare.id);
    const oldCompare = oldCompareId ? compareDs.individuals.get(oldCompareId) : undefined;
    const oldMain = oldMainId ? mainDs.individuals.get(oldMainId) : undefined;
    // Skip if either record's current match is at least as corroborated.
    if (oldCompare && corrob(main, oldCompare) >= linkCorrob) continue;
    if (oldMain && corrob(oldMain, compare) >= linkCorrob) continue;
    const cand = scoreIndividualPair(main, compare, mainDs, compareDs, config);
    links.push({ ...cand, relationshipLinked: true });
    usedMain.add(main.id);
    usedCompare.add(compare.id);
  }
  if (links.length === 0) return assigned;

  // Drop the previous assignment of every record a link now claims (the
  // override), then add the relationship links, keeping the by-score order.
  const linkedMain = new Set(links.map((l) => l.mainId));
  const linkedCompare = new Set(links.map((l) => l.compareId));
  const kept = assigned.filter(
    (a) => !linkedMain.has(a.mainId) && !linkedCompare.has(a.compareId),
  );
  return [...kept, ...links].sort(byScoreDesc);
}

/**
 * Greedy one-to-one assignment: take pairs in descending score order, keeping a
 * pair only if neither its main nor its compare record is already spoken for.
 * This is the right model for a merge (a record maps to at most one counterpart)
 * and removes the many-to-one noise of similarly-named people.
 */
function assignOneToOne<T extends { mainId: string; compareId: string; score: number }>(
  candidates: T[],
): T[] {
  const sorted = [...candidates].sort(byScoreDesc);
  const usedMain = new Set<string>();
  const usedCompare = new Set<string>();
  const out: T[] = [];
  for (const c of sorted) {
    if (usedMain.has(c.mainId) || usedCompare.has(c.compareId)) continue;
    usedMain.add(c.mainId);
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
