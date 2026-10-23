import type { Dataset, Individual } from "../gedcom/types";
import { CrossBlockIndex } from "./blocking";
import {
  plausibleIndividualMatch,
  scoreIndividualPair,
  scoreIndividualPairValue,
  sexConflicts,
} from "./scoreIndividual";
import { buildNameFrequencies, type NameFrequencies } from "./nameFrequency";
import { birthYearsApart, differentGiven, parentsVerdict } from "./similarity";
import { clearTextCaches } from "./text";
import {
  categorize,
  DEFAULT_CONFIG,
  type IncomingDuplicateCluster,
  type IndividualCandidate,
  type MatchConfig,
  type ScoreComponent,
  type ScoredMatchResult,
} from "./types";

/**
 * Match a compare dataset against the main.
 *
 * Two stages keep this from being O(n²): a cheap **blocking** pass groups
 * records by phonetic/decade keys so only plausible pairs get the (more
 * expensive) weighted **scoring** pass. Results are filtered to `minScore`,
 * reduced to a one-to-one assignment, and returned sorted by score descending.
 */
export function matchDatasets(
  mainDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig = DEFAULT_CONFIG,
): ScoredMatchResult {
  return matchDatasetsExplained(mainDs, compareDs, config).result;
}

/**
 * Re-derive one pair's score breakdown on demand, with the same name counts
 * the match run scored it with. The worker sends the list without the
 * breakdowns and answers a row's request with this.
 */
export type PairExplainer = (mainId: string, compareId: string) => ScoreComponent[] | undefined;

/** {@link matchDatasets}, plus a {@link PairExplainer} for its pairs. */
export function matchDatasetsExplained(
  mainDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig = DEFAULT_CONFIG,
): { result: ScoredMatchResult; explain: PairExplainer } {
  // Reset the fold/jaro-winkler memo caches so the (per-run) jaro-winkler pair
  // cache can't accumulate across reloads; both fill back up within this run.
  clearTextCaches();
  const { result, freq } = matchIndividuals(mainDs, compareDs, config);
  return { result, explain: pairExplainer(mainDs, compareDs, config, freq) };
}

/** A {@link PairExplainer} over two datasets — `freq` as the run had it
 *  (none for an import that scores without name counts). */
export function pairExplainer(
  mainDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig = DEFAULT_CONFIG,
  freq?: NameFrequencies,
): PairExplainer {
  return (mainId, compareId) => {
    const main = mainDs.individuals.get(mainId);
    const compare = compareDs.individuals.get(compareId);
    return main && compare ? scoreIndividualPair(main, compare, mainDs, compareDs, config, freq).components : undefined;
  };
}

function matchIndividuals(
  mainDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
): { result: ScoredMatchResult; freq: NameFrequencies } {
  const gap = config.gates.maxYearGap;
  const index = new CrossBlockIndex([...mainDs.individuals.values()], mainDs, gap);

  // Identity pre-pass: two records carrying the same `_UID`/`UID` are the same
  // person by construction (both exports came from the same software lineage),
  // regardless of what names/dates say. These pairs bypass blocking and gates,
  // score a flat 100, and are placed first so the greedy 1:1 assignment always
  // keeps them.
  // Name counts over both files: a name common in either is ambiguous for a
  // pair (see nameFrequency.ts). One pass, then every scoring call reads it.
  const freq = buildNameFrequencies([mainDs, compareDs], gap);
  const uidPairs = matchByUid(mainDs, compareDs, config, freq);
  const uidMain = new Set(uidPairs.map((p) => p.mainId));
  const uidCompare = new Set(uidPairs.map((p) => p.compareId));

  const mainList = index.records;
  const compareList = [...compareDs.individuals.values()];
  const mainPos = new Map(mainList.map((indi, i) => [indi.id, i]));
  const comparePos = new Map(compareList.map((indi, i) => [indi.id, i]));

  // Every pair that clears `minScore` is kept as two positions and a score —
  // the identity pairs first, so a tie at 100 goes to them.
  const scored = new ScoredPairs();
  for (const p of uidPairs) scored.push(mainPos.get(p.mainId)!, comparePos.get(p.compareId)!, p.score);
  compareList.forEach((compare, ci) => {
    if (uidCompare.has(compare.id)) return; // identity already established
    index.forEachCandidate(compare, compareDs, (mi) => {
      const main = mainList[mi];
      // Hard plausibility gates: different sex, dissimilar names, or
      // incompatible lifespans => never the same person; skip before scoring.
      if (sexConflicts(main, compare)) return;
      if (!plausibleIndividualMatch(main, compare, config.gates, mainDs, compareDs)) return;
      const score = scoreIndividualPairValue(main, compare, mainDs, compareDs, config, freq);
      if (score / 100 >= config.minScore) scored.push(mi, ci, score);
    });
  });

  // Only the pairs the assignment keeps become full candidates — rescored
  // with their review payload, to the same score.
  const assigned = assignOneToOne(scored, mainList.length, compareList.length).map((k) =>
    k < uidPairs.length
      ? uidPairs[k]
      : scoreIndividualPair(mainList[scored.main[k]], compareList[scored.compare[k]], mainDs, compareDs, config, freq),
  );
  const linked = linkByRelationships(assigned, mainDs, compareDs, config, freq, uidMain, uidCompare);
  const individuals = boostByMatchedRelatives(linked, mainDs, compareDs, config);
  const incomingDuplicates = findIncomingDuplicateClusters(
    runnersUp(scored, mainList.length, compareList),
    individuals,
    mainPos,
    compareDs,
    config,
    freq,
  );
  return { result: incomingDuplicates.length ? { individuals, incomingDuplicates } : { individuals }, freq };
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

/** FamilySearch person id ("GJMK-JZG"), the second identity namespace —
 *  written as `_FID` by MacFamilyTree and `_FSFTID` by RootsMagic, so two
 *  files synced to the same FamilySearch person cross-match even across
 *  programs. Anything not shaped like an FS id is ignored. */
function canonicalFsid(value: string): string | undefined {
  const v = value.trim().toUpperCase();
  return /^[A-Z0-9]{3,8}-[A-Z0-9]{2,4}$/.test(v) ? v : undefined;
}

/** Every identity key a record carries, namespaced so the two id systems
 *  can never collide with each other. */
function identityKeys(indi: Individual): string[] {
  const keys: string[] = [];
  for (const raw of indi.uids ?? []) {
    const uid = canonicalUid(raw);
    if (uid) keys.push(`U:${uid}`);
  }
  for (const raw of indi.fsids ?? []) {
    const fsid = canonicalFsid(raw);
    if (fsid) keys.push(`F:${fsid}`);
  }
  return keys;
}

/** identity key → record id for every *unambiguous* key in the dataset (a key
 *  carried by two records in one file identifies nothing and is skipped). */
function identityIndex(ds: Dataset): Map<string, string> {
  const byKey = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const indi of ds.individuals.values()) {
    for (const key of identityKeys(indi)) {
      if (ambiguous.has(key)) continue;
      const seen = byKey.get(key);
      if (seen !== undefined && seen !== indi.id) {
        byKey.delete(key);
        ambiguous.add(key);
      } else {
        byKey.set(key, indi.id);
      }
    }
  }
  return byKey;
}

/** The certain pre-matches: pairs sharing an unambiguous record identifier. */
function matchByUid(
  mainDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
  freq: NameFrequencies,
): IndividualCandidate[] {
  const mainByUid = identityIndex(mainDs);
  if (mainByUid.size === 0) return [];
  const compareByUid = identityIndex(compareDs);
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
    const cand = scoreIndividualPair(main, compare, mainDs, compareDs, config, freq);
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
  /** Every incoming record scored against the main record at a position. */
  scoredAgainst: (mainPos: number) => Individual[],
  matches: IndividualCandidate[],
  mainPos: Map<string, number>,
  compareDs: Dataset,
  config: MatchConfig,
  freq: NameFrequencies,
): IncomingDuplicateCluster[] {
  const matchedCompare = new Set(matches.map((m) => m.compareId));
  const winnerOf = new Map(matches.map((m) => [m.mainId, m.compareId]));

  const consumed = new Set<string>(); // each incoming id consolidated at most once
  const clusters: IncomingDuplicateCluster[] = [];
  for (const [mainId, keepId] of winnerOf) {
    if (consumed.has(keepId)) continue;
    const pos = mainPos.get(mainId);
    const keep = compareDs.individuals.get(keepId);
    if (pos === undefined || !keep) continue;
    const mergeIds: string[] = [];
    for (const cand of scoredAgainst(pos)) {
      if (cand.id === keepId || consumed.has(cand.id)) continue;
      if (matchedCompare.has(cand.id)) continue; // matched to another main → distinct
      // Hard vetoes a weighted-average score can't be trusted to enforce:
      // a distinct sibling (given name), a namesake (birth years far apart), or
      // a same-named cousin (conflicting parents) is never one person. The
      // scorer's own gates apply too — consolidation is a merge of two records
      // and has no business accepting a pair the matcher would have refused to
      // score, e.g. one whose lifespan ends before the other's wedding.
      if (differentGiven(keep, cand) || birthYearsApart(keep, cand) || parentsVerdict(keep, cand, compareDs) === "conflict") continue;
      if (sexConflicts(keep, cand) || !plausibleIndividualMatch(keep, cand, config.gates, compareDs, compareDs)) continue;
      // The strong gate: the two incoming records must be a direct duplicate of
      // each other, not merely two look-alikes of the same main.
      if (scoreIndividualPairValue(keep, cand, compareDs, compareDs, config, freq) < DUP_PAIR_SCORE) continue;
      mergeIds.push(cand.id);
      consumed.add(cand.id);
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
 *
 * A second, child-side pass then does the reverse for the children of matched
 * couples — see {@link childrenOfMatchedCouples}.
 */
function linkByRelationships(
  assigned: IndividualCandidate[],
  mainDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
  freq: NameFrequencies | undefined,
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
  /** Connect this pair unless something better already holds either record. */
  const tryLink = (main: Individual, compare: Individual): void => {
    if (mainToCompare.get(main.id) === compare.id) return; // already linked
    if (usedMain.has(main.id) || usedCompare.has(compare.id)) return;
    // Never displace an identity established by a shared record uid.
    if (uidMain.has(main.id) || uidCompare.has(compare.id)) return;
    const linkCorrob = corrob(main, compare);
    const oldCompareId = mainToCompare.get(main.id);
    const oldMainId = compareToMain.get(compare.id);
    const oldCompare = oldCompareId ? compareDs.individuals.get(oldCompareId) : undefined;
    const oldMain = oldMainId ? mainDs.individuals.get(oldMainId) : undefined;
    // Skip if either record's current match is at least as corroborated.
    if (oldCompare && corrob(main, oldCompare) >= linkCorrob) return;
    if (oldMain && corrob(oldMain, compare) >= linkCorrob) return;
    const cand = scoreIndividualPair(main, compare, mainDs, compareDs, config, freq);
    links.push({ ...cand, relationshipLinked: true });
    usedMain.add(main.id);
    usedCompare.add(compare.id);
  };
  for (const { main, compare } of strongestFirst) tryLink(main, compare);
  for (const { main, compare } of childrenOfMatchedCouples(mainDs, compareDs, config, freq, mainToCompare, confident)) {
    tryLink(main, compare);
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
 * The child-side counterpart of {@link linkByRelationships}: pairs of children
 * whose *couples* are confidently matched to each other.
 *
 * The two directions are not symmetric, and the difference decides the design.
 * A family has exactly one father and one mother, so a matched child *pins* a
 * parent outright — which is why the parent pass may ignore names entirely and
 * recover a mother recorded under a maiden surname. A family has many children,
 * so a matched couple pins the sibling *set* but not which sibling is which:
 * every main child would otherwise be equally "corroborated" against every
 * incoming one, and a namesake sibling (the child named after a dead older one,
 * routine in parish registers) would link arbitrarily.
 *
 * So the couple supplies the evidence and each pair's own score does the
 * pairing: within a matched family, candidate pairs pass the same hard gates the
 * scorer uses and are then taken best-first, one child to one child. What this
 * buys is the case the plain assignment loses — a fully corroborated child
 * outscored by a stray same-named record that carries no place, no parents and
 * no dates to disagree on, and so is charged for nothing.
 */
function childrenOfMatchedCouples(
  mainDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
  freq: NameFrequencies | undefined,
  mainToCompare: Map<string, string>,
  confident: (mainId: string) => boolean,
): Array<{ main: Individual; compare: Individual; score: number }> {
  const out: Array<{ main: Individual; compare: Individual; score: number }> = [];
  for (const mFam of mainDs.families.values()) {
    if (mFam.children.length === 0) continue;
    // Both parents must be recorded and confidently matched: one matched parent
    // is a single point of evidence, below the bar the parent pass holds itself
    // to (see MIN_RELATIONSHIP_EVIDENCE), and would pair up step-siblings.
    const parents = [mFam.husband, mFam.wife].filter((id): id is string => id !== undefined);
    if (parents.length < MIN_RELATIONSHIP_EVIDENCE) continue;
    const mapped = parents
      .filter((id) => confident(id))
      .map((id) => mainToCompare.get(id))
      .filter((id): id is string => id !== undefined);
    if (mapped.length < MIN_RELATIONSHIP_EVIDENCE) continue;
    // The incoming families in which *every* matched counterpart is a partner —
    // i.e. the same couple on the other side.
    let shared: string[] | undefined;
    for (const id of mapped) {
      const spouseOf = compareDs.individuals.get(id)?.spouseOf ?? [];
      shared = shared === undefined ? [...spouseOf] : shared.filter((f) => spouseOf.includes(f));
    }
    for (const cFamId of shared ?? []) {
      const cFam = compareDs.families.get(cFamId);
      if (!cFam) continue;
      const pairs: Array<{ main: Individual; compare: Individual; score: number }> = [];
      for (const mChildId of mFam.children) {
        const mChild = mainDs.individuals.get(mChildId);
        if (!mChild) continue;
        for (const cChildId of cFam.children) {
          const cChild = compareDs.individuals.get(cChildId);
          if (!cChild) continue;
          if (sexConflicts(mChild, cChild)) continue;
          if (!plausibleIndividualMatch(mChild, cChild, config.gates, mainDs, compareDs)) continue;
          const score = scoreIndividualPairValue(mChild, cChild, mainDs, compareDs, config, freq);
          if (score / 100 < config.minScore) continue;
          pairs.push({ main: mChild, compare: cChild, score });
        }
      }
      // One child to one child within this family, best pair first — so the
      // namesake siblings sort themselves out by their own dates and places.
      pairs.sort((a, b) => b.score - a.score);
      const takenMain = new Set<string>();
      const takenCompare = new Set<string>();
      for (const p of pairs) {
        if (takenMain.has(p.main.id) || takenCompare.has(p.compare.id)) continue;
        takenMain.add(p.main.id);
        takenCompare.add(p.compare.id);
        out.push(p);
      }
    }
  }
  // Strongest child pairs first, so a contested record goes to its best claim.
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Greedy one-to-one assignment: take pairs in descending score order, keeping a
 * pair only if neither its main nor its compare record is already spoken for.
 * This is the right model for a merge (a record maps to at most one counterpart)
 * and removes the many-to-one noise of similarly-named people.
 */
function assignOneToOne(pairs: ScoredPairs, mainCount: number, compareCount: number): number[] {
  // Descending score, ties in the order the pairs were found.
  // A plain array: a typed array's comparator sort is several times slower.
  const order = new Array<number>(pairs.length);
  for (let k = 0; k < order.length; k++) order[k] = k;
  const score = pairs.score;
  order.sort((a, b) => score[b] - score[a] || a - b);
  const usedMain = new Uint8Array(mainCount);
  const usedCompare = new Uint8Array(compareCount);
  const out: number[] = [];
  for (const k of order) {
    const m = pairs.main[k];
    const c = pairs.compare[k];
    if (usedMain[m] || usedCompare[c]) continue;
    usedMain[m] = 1;
    usedCompare[c] = 1;
    out.push(k);
  }
  return out;
}

/**
 * The scored pairs, as positions into the main and incoming record lists and
 * a score. A large file clears `minScore` on millions of pairs and keeps one
 * per record, so the pairs are not candidates until the assignment picks them.
 */
class ScoredPairs {
  main = new Int32Array(1024);
  compare = new Int32Array(1024);
  score = new Float64Array(1024);
  length = 0;

  push(main: number, compare: number, score: number): void {
    if (this.length === this.main.length) {
      const grow = <A extends Int32Array | Float64Array>(a: A): A => {
        const b = new (a.constructor as new (n: number) => A)(a.length * 2);
        b.set(a);
        return b;
      };
      this.main = grow(this.main);
      this.compare = grow(this.compare);
      this.score = grow(this.score);
    }
    this.main[this.length] = main;
    this.compare[this.length] = compare;
    this.score[this.length] = score;
    this.length++;
  }
}

/** Per main record (by position), the incoming records it was scored
 *  against, in the order they were scored. Built on first use. */
function runnersUp(
  pairs: ScoredPairs,
  mainCount: number,
  compareList: Individual[],
): (mainPos: number) => Individual[] {
  let start: Uint32Array | undefined;
  let list: Int32Array | undefined;
  return (mainPos) => {
    if (!start || !list) {
      start = new Uint32Array(mainCount + 1);
      for (let k = 0; k < pairs.length; k++) start[pairs.main[k] + 1]++;
      for (let m = 0; m < mainCount; m++) start[m + 1] += start[m];
      const fill = start.slice(0, mainCount);
      list = new Int32Array(pairs.length);
      for (let k = 0; k < pairs.length; k++) list[fill[pairs.main[k]]++] = pairs.compare[k];
    }
    const out: Individual[] = [];
    for (let k = start[mainPos]; k < start[mainPos + 1]; k++) out.push(compareList[list[k]]);
    return out;
  };
}

function byScoreDesc(a: { score: number }, b: { score: number }): number {
  return b.score - a.score;
}
