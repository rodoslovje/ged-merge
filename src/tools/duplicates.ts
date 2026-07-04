import type { Dataset, Individual, PersonName } from "../gedcom/types";
import {
  individualBlockKeys,
  plausibleIndividualMatch,
  scoreIndividualPair,
  sexConflicts,
} from "../match/scoreIndividual";
import { cachedFatherName, cachedFindEvent, cachedMotherName } from "../match/profileCache";
import { comparableName, givenSimilarity, parentGivenVerdict } from "../match/similarity";
import { soundex } from "../match/text";
import { DEFAULT_CONFIG, type MatchCategory, type MatchConfig } from "../match/types";
import { label, primaryName } from "../match/relatives";

/**
 * Within-file duplicate detection.
 *
 * Unlike `matchDatasets` — which compares two distinct files and resolves to a
 * one-to-one mapping — finding duplicates inside a single file must NOT do
 * one-to-one assignment (every person's best match would be themselves) and
 * must skip identity pairs. So this reuses the same blocking + gating + scoring
 * primitives but compares the master against itself, emitting every plausible
 * unordered pair above a (higher than merge-default) threshold.
 */

export interface DuplicatePair {
  aId: string;
  bId: string;
  aLabel: string;
  bLabel: string;
  /** 0..100 similarity score. */
  score: number;
  category: MatchCategory;
}

/** Default acceptance for duplicates — stricter than the merge default (0.45)
 *  because here both records come from the same curated file. */
const DEFAULT_MIN_SCORE = 0.7;

export function findDuplicates(
  ds: Dataset,
  minScore: number = DEFAULT_MIN_SCORE,
  config: MatchConfig = DEFAULT_CONFIG,
): DuplicatePair[] {
  // Blocking: bucket individuals by phonetic/decade keys so only plausible
  // pairs reach the expensive scoring pass.
  const index = new Map<string, Individual[]>();
  for (const indi of ds.individuals.values()) {
    for (const key of individualBlockKeys(indi, soundex, ds)) {
      let bucket = index.get(key);
      if (!bucket) index.set(key, (bucket = []));
      bucket.push(indi);
    }
  }

  const out: DuplicatePair[] = [];

  for (const a of ds.individuals.values()) {
    const candidates = new Set<string>();
    for (const key of individualBlockKeys(a, soundex, ds)) {
      const bucket = index.get(key);
      if (bucket) for (const b of bucket) candidates.add(b.id);
    }

    for (const bId of candidates) {
      // Each unordered pair is scored once: only from its lower-id side. (The
      // per-individual `candidates` set already dedups multi-key hits, so no
      // global seen-pairs set is needed — on a 500k-person file such a set
      // exceeded V8's ~16.7M-entry Set limit and crashed the whole scan.)
      if (bId <= a.id) continue;

      const b = ds.individuals.get(bId)!;
      if (sexConflicts(a, b)) continue;
      if (!plausibleIndividualMatch(a, b, config.gates, ds, ds)) continue;
      if (distinctRelatives(a, b, ds)) continue;
      const cand = scoreIndividualPair(a, b, ds, ds, config);
      if (cand.score / 100 < minScore) continue;

      // Orient the pair so the left/survivor is the record with more linked
      // relatives. Merging keeps the left record and re-points the right's links
      // onto it, so leading with the richer record minimizes the changes.
      const [left, right] = relationshipCount(b, ds) > relationshipCount(a, ds) ? [b, a] : [a, b];
      out.push({
        aId: left.id,
        bId: right.id,
        aLabel: label(left),
        bLabel: label(right),
        score: cand.score,
        category: cand.category,
      });
    }
  }

  out.sort((x, y) => y.score - x.score);
  return out;
}

/**
 * Build a {@link DuplicatePair} for an arbitrary couple of records — e.g. a
 * related pair surfaced by another merge (see `relatedSeparateRecords`) that
 * `findDuplicates` did not flag on its own. Scored and oriented (richer record
 * leads as the survivor) exactly like the pairs from `findDuplicates`, so it can
 * be dropped straight into the same list. Returns undefined if either record is
 * missing or both ids are the same.
 */
export function makeDuplicatePair(
  ds: Dataset,
  aId: string,
  bId: string,
  config: MatchConfig = DEFAULT_CONFIG,
): DuplicatePair | undefined {
  const a = ds.individuals.get(aId);
  const b = ds.individuals.get(bId);
  if (!a || !b || aId === bId) return undefined;
  const cand = scoreIndividualPair(a, b, ds, ds, config);
  const [left, right] = relationshipCount(b, ds) > relationshipCount(a, ds) ? [b, a] : [a, b];
  return {
    aId: left.id,
    bId: right.id,
    aLabel: label(left),
    bLabel: label(right),
    score: cand.score,
    category: cand.category,
  };
}

/** Number of distinct linked relatives (parents, partners, children) a person
 *  has — used to pick which of a duplicate pair leads as the survivor, so the
 *  merge re-points as few relationships as possible. */
function relationshipCount(indi: Individual, ds: Dataset): number {
  const rel = new Set<string>();
  for (const famId of indi.childOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    for (const p of [fam.husband, fam.wife]) if (p && p !== indi.id) rel.add(p);
  }
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    for (const m of [fam.husband, fam.wife, ...fam.children]) if (m && m !== indi.id) rel.add(m);
  }
  return rel.size;
}

/**
 * Within-file veto: distinguishes two *distinct relatives* from one person
 * entered twice. The generic same-person scorer is a weighted average, so for
 * close relatives the heavily-weighted circumstantial fields (shared surname,
 * same birthplace, same sex, nearby birth year) dominate and a clear conflict
 * on the few discriminating fields only nudges the score — flagging cousins and
 * siblings as duplicates. These are *hard conflicts* no single person can have,
 * so we reject the pair outright regardless of how the rest scores:
 *
 *  - **Different given name** — the first names are too dissimilar to be the
 *    same person (Franjo/Jakov, Anton/Alojz ≈ 0.6), whatever the surname, dates
 *    and family agree on. This is the identity discriminator: a genuine
 *    duplicate's given names stay near-identical even across transcription
 *    variants (Jože/Jožef, Johann/Johannes ≥ 0.95), so siblings, cousins and
 *    twins that merely share a surname are all rejected here. (Nickname / cross-
 *    language variants — Janez/Ivan, William/Bill ≈ 0.7 — are sacrificed: they
 *    can't be told apart from a sibling by name alone, and twins vastly
 *    outnumber them in parish-record data.)
 *  - **Conflicting exact birth years** — same given name and family, but both
 *    record an exact birth date and the years differ: a namesake child given a
 *    dead sibling's name. (A same-year pair differing only in month/day is kept
 *    — that's a transcription-error duplicate worth merging.)
 *  - **Conflicting father** — the two records resolve fathers whose given
 *    names clearly differ: different families. The mother is deliberately NOT
 *    allowed to rescue such a pair: mother given names are dominated by a
 *    handful of ubiquitous names (Marija, Ana, Marjana …), so a mother
 *    "agreement" is nearly free — same-named cousins born the same year to
 *    different fathers routinely both have a mother Marija.
 *  - **Conflicting parents** — no comparable parental role agrees and at least
 *    one conflicts: same-named cousins, not the same person. (A shared surname
 *    between the two fathers is ignored — within one family every father
 *    shares it, so only the given name discriminates.)
 *
 * The parent vetoes are skipped when both records assert the **same exact
 * calendar birth day**: that is in practice two copies of one christening
 * entry, and a conflicting parent name there (Gertrud vs Jera — the same name
 * in the German vs Slovene register) is a recording variant, never a
 * different family.
 */
function distinctRelatives(a: Individual, b: Individual, ds: Dataset): boolean {
  if (differentGiven(a, b)) return true; // different first name → different person
  if (conflictingBirthYears(a, b)) return true; // namesake child
  if (sameExactBirthDay(a, b)) return false; // same christening entry → parent variants can't outvote it
  if (parentGivens(comparableName(cachedFatherName(a, ds)), comparableName(cachedFatherName(b, ds))) === "conflict") return true; // different father → different family
  if (parentAgreement(a, b, ds) === "conflict") return true; // same-named cousins
  return false;
}


/** Minimum given-name similarity (0..1) for two records to be the same person
 *  rather than distinct relatives. Sits in the gap between distinct given names
 *  (Franjo/Jakov ≈ 0.58, twins Anton/Alojz ≈ 0.64) and transcription variants of
 *  one name (Jože/Jožef ≈ 0.96). Stricter than the merge name gate (0.5), which
 *  is tuned to let nickname/cross-language variants through across two files. */
const SAME_PERSON_GIVEN = 0.85;

/** Compare one parental role across the two records: do the given names agree,
 *  conflict, or is there too little data to tell? (Also "unknown" for the
 *  band between the conflict and agree thresholds — see `parentGivenVerdict`.) */
function parentGivens(a: PersonName | undefined, b: PersonName | undefined): "agree" | "conflict" | "unknown" {
  return parentGivenVerdict(a?.given, b?.given);
}

/**
 * How the two records' parents relate: "agree" if a comparable father or mother
 * matches (siblings and true duplicates both share parents), "conflict" if every
 * comparable parent disagrees (different families → cousins), "unknown" if
 * there's too little linked-parent data on either side to tell.
 */
function parentAgreement(a: Individual, b: Individual, ds: Dataset): "agree" | "conflict" | "unknown" {
  const father = parentGivens(comparableName(cachedFatherName(a, ds)), comparableName(cachedFatherName(b, ds)));
  const mother = parentGivens(comparableName(cachedMotherName(a, ds)), comparableName(cachedMotherName(b, ds)));
  if (father === "agree" || mother === "agree") return "agree";
  if (father === "conflict" || mother === "conflict") return "conflict";
  return "unknown";
}

/** True when both records have a given name and they're too dissimilar to be the
 *  same person (distinct sibling names rather than spelling variants of one). */
function differentGiven(a: Individual, b: Individual): boolean {
  const ga = comparableName(primaryName(a))?.given;
  const gb = comparableName(primaryName(b))?.given;
  if (!ga || !gb) return false;
  return givenSimilarity(ga, gb) < SAME_PERSON_GIVEN;
}

/** True when both records assert the same exact calendar birth day — in
 *  practice two copies of the same christening entry, which the parent-based
 *  vetoes must not override (see {@link distinctRelatives}). */
function sameExactBirthDay(a: Individual, b: Individual): boolean {
  const da = cachedFindEvent(a, "BIRT")?.date;
  const db = cachedFindEvent(b, "BIRT")?.date;
  if (da?.qualifier !== "exact" || db?.qualifier !== "exact") return false;
  return (
    da.year !== undefined && da.year === db.year &&
    da.month !== undefined && da.month === db.month &&
    da.day !== undefined && da.day === db.day
  );
}

/** True when both records carry an exact birth date and the years differ —
 *  distinct people, never one person twice. Approximate/bounded dates
 *  (ABT/BEF/…) are left to the scorer, which already treats them as fuzzy. */
function conflictingBirthYears(a: Individual, b: Individual): boolean {
  const da = cachedFindEvent(a, "BIRT")?.date;
  const db = cachedFindEvent(b, "BIRT")?.date;
  if (da?.qualifier !== "exact" || db?.qualifier !== "exact") return false;
  if (da.year === undefined || db.year === undefined) return false;
  return da.year !== db.year;
}
