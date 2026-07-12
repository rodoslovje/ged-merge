import type { Dataset, GedDate, Individual, PersonName } from "../gedcom/types";
import { birthDateText, birthYear, deathDateText, deathYear, isDeceased } from "../gedcom/lifespan";
import { estimatedBirthYear } from "./birthEstimate";
import { displayName, pairTitle, primaryName } from "./relatives";
import {
  cachedChildrenNames,
  cachedFatherName,
  cachedFindEvent,
  cachedMarriageEvents,
  cachedMotherName,
  cachedPartnerNames,
} from "./profileCache";
import {
  comparableName,
  dateSimilarity,
  fatherGivenVerdict,
  givenNameSetSimilarity,
  givenSimilarity,
  motherGivenVerdict,
  nameSetSimilarity,
  nameSimilarity,
  placeSimilarity,
} from "./similarity";
import { foldToken, jaroWinkler } from "./text";
import {
  categorize,
  combineComponents,
  type IndividualCandidate,
  type MatchConfig,
  type ScoreComponent,
} from "./types";

/**
 * Score a main/compare individual pair. Components that can't be compared
 * (data missing on either side) are omitted so they neither help nor hurt.
 */
export function scoreIndividualPair(
  main: Individual,
  compare: Individual,
  mainDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
): IndividualCandidate {
  const w = config.individualWeights;
  const components: ScoreComponent[] = [];
  // Placeholder name parts ("Living", "NN", "?Ime?") are treated as missing —
  // see comparableName — so they earn the missing-key penalty instead of a
  // perfect placeholder-to-placeholder match.
  const mn = comparableName(primaryName(main));
  const cn = comparableName(primaryName(compare));

  // Surname, given name and birth year form the identity key: each is always
  // scored, and a side that's missing the field is charged `missingKeyScore`
  // (penalized rather than ignored) so an incomplete record can't reach 100%.
  const surnameSim =
    mn?.surname && cn?.surname
      ? jaroWinkler(foldToken(mn.surname), foldToken(cn.surname))
      : undefined;
  addKey(components, "surname", w.surname, surnameSim, config.missingKeyScore, `${mn?.surname ?? "—"} ~ ${cn?.surname ?? "—"}`);

  const givenSim = mn?.given && cn?.given ? givenSimilarity(mn.given, cn.given) : undefined;
  addKey(components, "given", w.given, givenSim, config.missingKeyScore, `${mn?.given ?? "—"} ~ ${cn?.given ?? "—"}`);

  const mb = cachedFindEvent(main, "BIRT");
  const cb = cachedFindEvent(compare, "BIRT");
  const birthSim = dateSimilarity(mb?.date, cb?.date);
  // Some import formats (the genealogical-index "family matches" CSV) don't
  // reliably carry a birth date — often only a marriage date. Rather than
  // charging the flat `missingKeyScore` penalty for data the source simply
  // doesn't have, fall back to a marriage-derived plausibility check: if the
  // side that *does* have a birth year sits within a typical age-at-marriage
  // range of the other side's marriage date, that's meaningful corroboration.
  // Strictly scoped to sparse-birth sources (see `birthScoreFromMarriage`).
  const birthMissingScore = birthSim === undefined
    ? birthScoreFromMarriage(mb?.date?.year, cb?.date?.year, main, compare, mainDs, compareDs)
      ?? config.missingKeyScore
    : config.missingKeyScore;
  addKey(components, "birthDate", w.birthDate, birthSim, birthMissingScore, `${mb?.date?.raw ?? "—"} ~ ${cb?.date?.raw ?? "—"}`);
  add(components, "birthPlace", w.birthPlace, placeSimilarity(mb?.place, cb?.place), `${mb?.place?.raw ?? "?"} ~ ${cb?.place?.raw ?? "?"}`);
  add(components, "birthAddress", w.birthAddress, placeSimilarity(mb?.address, cb?.address), `${mb?.address?.raw ?? "?"} ~ ${cb?.address?.raw ?? "?"}`);

  // Death date/place: corroborating evidence, not part of the identity key —
  // absence (e.g. living people) is skipped rather than penalized.
  const md = cachedFindEvent(main, "DEAT");
  const cd = cachedFindEvent(compare, "DEAT");
  const deathSim = dateSimilarity(md?.date, cd?.date);
  add(components, "deathDate", w.deathDate, deathSim, `${md?.date?.raw ?? "—"} ~ ${cd?.date?.raw ?? "—"}`);
  add(components, "deathPlace", w.deathPlace, placeSimilarity(md?.place, cd?.place), `${md?.place?.raw ?? "?"} ~ ${cd?.place?.raw ?? "?"}`);

  if (main.sex !== "U" && compare.sex !== "U") {
    add(components, "sex", w.sex, main.sex === compare.sex ? 1 : 0, `${main.sex} ~ ${compare.sex}`);
  }

  // Parents are compared role-wise (father↔father, mother↔mother) with the
  // father reduced to his given name — his surname is the family surname the
  // surname component already scored, so including it only inflated the score
  // for *any* same-surname pair (different fathers still reached ~0.6+).
  // Children likewise share the person's surname, so they compare by given
  // names only. Partners keep the full-name comparison: a spouse's family
  // name genuinely discriminates.
  add(components, "parents", w.parents, parentSimilarity(main, compare, mainDs, compareDs), "parents");
  add(components, "partners", w.partners, nameSetSimilarity(cachedPartnerNames(main, mainDs), cachedPartnerNames(compare, compareDs)), "partners");
  add(components, "children", w.children, givenNameSetSimilarity(cachedChildrenNames(main, mainDs), cachedChildrenNames(compare, compareDs)), "children");

  // Marriage corroboration, folded in from the person's spouse family: a matching
  // marriage date/place is strong evidence (and disambiguates same-named people).
  const mar = bestMarriageSimilarity(main, compare, mainDs, compareDs);
  add(components, "marriageDate", w.marriageDate, mar.date, "marriage date");
  add(components, "marriagePlace", w.marriagePlace, mar.place, "marriage place");

  let score01 = combineComponents(components);

  // A clear given-name disagreement is stronger negative evidence than the
  // weighted average can express: surname, dates, places and even parents all
  // agreeing still describes two *different* people of the same family (the
  // dense-name-cluster false positive — Marta vs Uršula Božič, Johann vs Franc
  // Weiss all score ~0.58 on given yet averaged out at 80+). Demote
  // multiplicatively rather than gate: the pair stays in the results for
  // review, ranked as the long shot it is, and a genuine name-divergent match
  // (maiden name, cross-language variant like Janez/Ivan) is restored by the
  // relationship passes — linkByRelationships and boostByMatchedRelatives are
  // driven by matched relatives, not by name agreement.
  if (givenSim !== undefined && givenSim < GIVEN_CONFLICT_SIM) {
    score01 *= GIVEN_CONFLICT_PENALTY;
  }

  // Both parents named and both clearly different: the two records belong to
  // different families, however well the person's own name and dates agree —
  // the dense-name-cluster false positive (same-name cousins born nearby).
  // The parents *component* alone can't express this: at weight 2 in a ~10.5
  // weight total, even a 0 score only shaves a few points. A single
  // conflicting role is deliberately not penalized — one parent recorded
  // under a cross-language variant (Jurij/Georg 0.47) is routine in bilingual
  // parish records, and mothers agreeing on a ubiquitous given name (Marija)
  // are too weak a confirmation to matter either way.
  if (bothParentsConflict(main, compare, mainDs, compareDs)) {
    score01 *= PARENT_CONFLICT_PENALTY;
  }

  // A pair needs at least one hard discriminator to be worth a reviewer's
  // time (see UNANCHORED_CEILING): a comparable full name, an exact
  // month-or-better birth-date agreement, or comparable relative names.
  // Index files are full of skeleton records — a missing/placeholder name
  // part plus an estimated "~1900" year — and shared surname + approximate-
  // year proximity alone scores into the high 70s; in a big file every
  // same-surname skeleton pairs with every other one, quadratically.
  const anchored =
    Boolean(mn?.given && cn?.given && mn?.surname && cn?.surname) ||
    anchoringDate(birthSim, mb?.date, cb?.date) ||
    anchoringDate(deathSim, md?.date, cd?.date) ||
    components.some((c) => c.key === "parents" || c.key === "partners" || c.key === "children");
  if (!anchored) score01 = Math.min(score01, UNANCHORED_CEILING);

  // The identity key — surname, given name and birth date — is conclusive: when
  // all three are present and an exact match the pair is the same person and
  // scores a flat 100. Conversely 100 is reserved for that case, so secondary
  // fields can never round an imperfect-key pair up to it.
  const keyPerfect = KEY_FIELDS.every((k) => {
    const c = components.find((x) => x.key === k);
    return c !== undefined && !c.missing && c.score === 1;
  });
  if (keyPerfect) score01 = 1;

  let score = Math.round(score01 * 1000) / 10;
  if (!keyPerfect && score >= 100) score = 99.9;

  // A fully-matching relative is strong corroboration: nudge the score up a
  // little for each of father/mother/partner that matches exactly. The bonus is
  // capped just below 100 so it never reaches a perfect score on its own — 100
  // stays reserved for a perfect identity key.
  if (!keyPerfect) {
    const bonus = relativeMatchBonus(main, compare, mainDs, compareDs, config);
    if (bonus > 0) score = Math.min(99.9, Math.round((score + bonus) * 10) / 10);
  }

  return {
    mainId: main.id,
    compareId: compare.id,
    score,
    category: categorize(score01, config),
    components,
    title: pairTitle(main, compare),
    name: displayName(primaryName(main)),
    birthYear: birthYear(main),
    deathYear: deathYear(main),
    birthDate: birthDateText(main),
    deathDate: deathDateText(main),
    deceased: isDeceased(main),
    sex: main.sex !== "U" ? main.sex : compare.sex,
  };
}

/** The identity key: a perfect match on all three earns a 100 score. */
const KEY_FIELDS = ["surname", "given", "birthDate"] as const;

/**
 * Given-name similarity below which two records are more likely two different
 * people than one. Sits just under the nickname/cross-language band (~0.7:
 * William/Bill 0.73, Valentin/Vaclav 0.70) and above the distinct-name band
 * (Marta/Uršula and Johann/Franc 0.58, Anton/Alojz 0.64) — measured with
 * `givenSimilarity` over real parish-record pairs. Genuine variants that fall
 * below it (Janez/Ivan 0.63, Jera/Gertrud 0.60) are knowingly demoted here and
 * recovered by relationship corroboration instead, which junk same-surname
 * pairs don't have.
 */
const GIVEN_CONFLICT_SIM = 0.7;

/**
 * Multiplier applied to the combined score on a given-name conflict. Chosen so
 * the dense-cluster false positives observed at 75–85 land in the low-60s/
 * high-50s (visible, but clearly flagged as long shots) and marginal weak
 * candidates fall below `minScore` entirely, while a demoted genuine pair
 * still scores high enough to be relationship-boosted back into the 90s.
 */
const GIVEN_CONFLICT_PENALTY = 0.8;

/**
 * Multiplier when both parents conflict (see the call site). Same magnitude
 * as the given-name conflict penalty, and stacking with it: a pair wrong on
 * both its own name and its family is crushed to ~0.64× — firmly out of the
 * plausible band.
 */
const PARENT_CONFLICT_PENALTY = 0.8;

/**
 * Score ceiling (0..1) for a pair with no hard discriminator: no comparable
 * full name (a real given *and* surname on both sides), no exact
 * month-or-better birth-date agreement, and no comparable parent, partner or
 * child names. Such pairs — skeleton records offering only a shared surname
 * (or bare given name) and an estimated year — are unreviewable and multiply
 * quadratically in large files (Hawlina: ~977-person same-surname clusters,
 * ~146k sub-80 pairs). The ceiling keeps them below the within-file
 * duplicate-list cutoff (0.7) and the probable band (0.65), so they surface
 * at most as weak cross-file suggestions; relationship linking/boosting still
 * recovers any that turn out to be corroborated by matched relatives.
 */
const UNANCHORED_CEILING = 0.6;

/** True when a date pair anchors the identity: both sides assert an exact
 *  date with at least month precision and they agree (>= 0.9 — same month, at
 *  worst a day apart). Approximate/estimated years and bare-year agreements
 *  don't qualify. Used for birth and death alike. */
function anchoringDate(
  sim: number | undefined,
  a: GedDate | undefined,
  b: GedDate | undefined,
): boolean {
  return (
    sim !== undefined && sim >= 0.9 &&
    a?.qualifier === "exact" && b?.qualifier === "exact" &&
    a.month !== undefined && b.month !== undefined
  );
}

/** True when both records name a father and a mother (given names on both
 *  sides) and *each* role's given names are too dissimilar to be the same
 *  person — different-family evidence strong enough for a score penalty. */
function bothParentsConflict(
  main: Individual,
  compare: Individual,
  mainDs: Dataset,
  compareDs: Dataset,
): boolean {
  // Both roles must sit in the shared conflict band (see parentGivenVerdict) —
  // the same boundary the duplicate vetoes use. A missing given name on either
  // side of a role yields "unknown", never a conflict.
  return (
    fatherGivenVerdict(main, mainDs, compare, compareDs) === "conflict" &&
    motherGivenVerdict(main, mainDs, compare, compareDs) === "conflict"
  );
}

/**
 * Role-wise parent similarity: father compared to father, mother to mother.
 * The father contributes his given name only (his surname is the shared
 * family surname — no information). The mother is compared as a full name:
 * her recorded maiden surname genuinely discriminates between families when
 * both sides carry it. Averages the comparable roles; undefined when neither
 * role can be compared.
 */
function parentSimilarity(
  main: Individual,
  compare: Individual,
  mainDs: Dataset,
  compareDs: Dataset,
): number | undefined {
  const fm = comparableName(cachedFatherName(main, mainDs));
  const fc = comparableName(cachedFatherName(compare, compareDs));
  const mm = comparableName(cachedMotherName(main, mainDs));
  const mc = comparableName(cachedMotherName(compare, compareDs));
  const parts: number[] = [];
  if (fm?.given && fc?.given) parts.push(givenSimilarity(fm.given, fc.given));
  if (mm && mc) {
    const s = nameSimilarity(mm, mc);
    if (s !== undefined) parts.push(s);
  }
  if (parts.length === 0) return undefined;
  return parts.reduce((s, v) => s + v, 0) / parts.length;
}

/** Best marriage date/place similarity over the cross-product of both people's
 *  marriages (handles re-marriages; undefined when a side lacks the data). */
function bestMarriageSimilarity(
  main: Individual,
  compare: Individual,
  mainDs: Dataset,
  compareDs: Dataset,
): { date: number | undefined; place: number | undefined } {
  const me = cachedMarriageEvents(main, mainDs);
  const ce = cachedMarriageEvents(compare, compareDs);
  let date: number | undefined;
  let place: number | undefined;
  for (const a of me) {
    for (const b of ce) {
      const d = dateSimilarity(a.date, b.date);
      if (d !== undefined) date = Math.max(date ?? 0, d);
      const p = placeSimilarity(a.place, b.place);
      if (p !== undefined) place = Math.max(place ?? 0, p);
    }
  }
  return { date, place };
}

/** Typical age-at-marriage range used to sanity-check a birth year against a
 *  marriage date when there's no actual birth date to compare against. */
const MARRIAGE_AGE_RANGE = { min: 15, max: 60 };

/** Score given to a birth-date key when one side has no birth date at all
 *  (see `birthScoreFromMarriage`) but the plausibility check passes. Short of
 *  a real date match (1), but far better than the flat `missingKeyScore`
 *  penalty for data the source format simply doesn't carry. */
const PLAUSIBLE_BIRTH_FROM_MARRIAGE_SCORE = 0.85;

/**
 * Fallback for the birth-date key when one side has no birth year. Two strict
 * conditions keep this from inflating ordinary sparse records (unscoped, it
 * scored 0.85×weight for near-every missing-birth pair across two GEDCOMs and
 * flooded the results with same-named look-alikes at 85+):
 *
 *  - The birth-less record must come from a *sparse-birth source* (see
 *    {@link Dataset.sparseBirthDates} — the GI matches CSV): only there is a
 *    missing birth date a format limitation rather than a data gap.
 *  - The evidence must be cross-side: the known birth year is checked against
 *    the *birth-less* record's marriage year. (A record's own marriage date
 *    says nothing about its counterpart.)
 *
 * Returns the plausibility score when the implied age at marriage is typical,
 * undefined (the caller's flat penalty applies) otherwise.
 */
function birthScoreFromMarriage(
  mainYear: number | undefined,
  compareYear: number | undefined,
  main: Individual,
  compare: Individual,
  mainDs: Dataset,
  compareDs: Dataset,
): number | undefined {
  if (mainYear !== undefined && compareYear === undefined && compareDs.sparseBirthDates) {
    return plausibleAgeAtMarriage(mainYear, compare, compareDs);
  }
  if (compareYear !== undefined && mainYear === undefined && mainDs.sparseBirthDates) {
    return plausibleAgeAtMarriage(compareYear, main, mainDs);
  }
  return undefined;
}

/** The plausibility score when `birthYear` implies a typical age at the
 *  birth-less record's (first dated) marriage; undefined when the record has
 *  no dated marriage or the implied age is atypical. */
function plausibleAgeAtMarriage(
  birthYear: number,
  birthless: Individual,
  ds: Dataset,
): number | undefined {
  const marriageYear = cachedMarriageEvents(birthless, ds)
    .map((e) => e.date?.year)
    .find((y): y is number => y !== undefined);
  if (marriageYear === undefined) return undefined;
  const age = marriageYear - birthYear;
  return age >= MARRIAGE_AGE_RANGE.min && age <= MARRIAGE_AGE_RANGE.max ? PLAUSIBLE_BIRTH_FROM_MARRIAGE_SCORE : undefined;
}

/**
 * Total bonus for corroborating relatives: father, mother and any partner that
 * is a confident full name match.
 */
function relativeMatchBonus(
  main: Individual,
  compare: Individual,
  mainDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
): number {
  let bonus = 0;
  if (fullNameMatch(comparableName(cachedFatherName(main, mainDs)), comparableName(cachedFatherName(compare, compareDs)))) {
    bonus += config.parentMatchBonus;
  }
  if (fullNameMatch(comparableName(cachedMotherName(main, mainDs)), comparableName(cachedMotherName(compare, compareDs)))) {
    bonus += config.parentMatchBonus;
  }
  if (anyFullNameMatch(cachedPartnerNames(main, mainDs), cachedPartnerNames(compare, compareDs))) {
    bonus += config.partnerMatchBonus;
  }
  return bonus;
}

/** True when some name on each side is a confident full match with the other. */
function anyFullNameMatch(as: PersonName[], bs: PersonName[]): boolean {
  return as.some((a) => bs.some((b) => fullNameMatch(a, b)));
}

/**
 * A confident full match: both sides have a given name *and* a surname, and the
 * two names are identical. Requiring both parts avoids treating a shared family
 * surname (with no given name) as corroboration.
 */
function fullNameMatch(a: PersonName | undefined, b: PersonName | undefined): boolean {
  if (!a?.given || !b?.given || !a?.surname || !b?.surname) return false;
  return nameSimilarity(a, b) === 1;
}

function add(
  into: ScoreComponent[],
  key: string,
  weight: number,
  score: number | undefined,
  detail: string,
): void {
  if (score === undefined) return;
  into.push({ key, weight, score, detail });
}

/**
 * Add a key (identity) field. Unlike `add`, a missing similarity is not skipped
 * but recorded with the `missingKeyScore` penalty, so absent key data drags the
 * overall score down instead of being silently excluded from the average.
 */
function addKey(
  into: ScoreComponent[],
  key: string,
  weight: number,
  similarity: number | undefined,
  missingScore: number,
  detail: string,
): void {
  const missing = similarity === undefined;
  into.push({ key, weight, score: missing ? missingScore : similarity, detail, missing });
}

/**
 * True when both individuals have a recorded sex and they differ. Such pairs are
 * never the same person, so the engine drops them before scoring.
 */
export function sexConflicts(a: Individual, b: Individual): boolean {
  return a.sex !== "U" && b.sex !== "U" && a.sex !== b.sex;
}

/**
 * Hard plausibility gate applied before scoring. Rejects pairs that cannot
 * reasonably be the same person:
 *  - names too dissimilar (surname and/or given below threshold),
 *  - representative years too far apart (`gates.maxYearGap`),
 *  - lifespans that don't overlap (one died before the other was born).
 */
export function plausibleIndividualMatch(
  a: Individual,
  b: Individual,
  gates: MatchConfig["gates"],
  dsA: Dataset,
  dsB: Dataset,
): boolean {
  return nameGate(a, b, gates) && temporalGate(a, b, gates, dsA, dsB);
}

function nameGate(a: Individual, b: Individual, gates: MatchConfig["gates"]): boolean {
  const an = comparableName(primaryName(a));
  const bn = comparableName(primaryName(b));
  const surname =
    an?.surname && bn?.surname
      ? jaroWinkler(foldToken(an.surname), foldToken(bn.surname))
      : undefined;
  const given =
    an?.given && bn?.given ? givenSimilarity(an.given, bn.given) : undefined;

  if (surname !== undefined && surname < gates.minSurname) return false;
  if (given !== undefined && given < gates.minGiven) return false;

  // No structured name parts on either side: fall back to the full name.
  if (surname === undefined && given === undefined) {
    if (an?.full && bn?.full) {
      return jaroWinkler(foldToken(an.full), foldToken(bn.full)) >= gates.minSurname;
    }
    return false; // nothing to match a name on
  }
  return true;
}

function temporalGate(
  a: Individual,
  b: Individual,
  gates: MatchConfig["gates"],
  dsA: Dataset,
  dsB: Dataset,
): boolean {
  // Coarse "same era" check using each person's best available year.
  const ea = eraYear(a, dsA);
  const eb = eraYear(b, dsB);
  if (ea !== undefined && eb !== undefined && Math.abs(ea - eb) > gates.maxYearGap) {
    return false;
  }

  // Lifespan impossibility: one died before the other was born.
  const da = deathYear(a);
  const bb = birthYear(b);
  if (da !== undefined && bb !== undefined && da < bb) return false;
  const db = deathYear(b);
  const ba = birthYear(a);
  if (db !== undefined && ba !== undefined && db < ba) return false;

  return true;
}

/** A representative year placing the person in time: a recorded date if any,
 *  else a relative-derived estimate, else death/marriage/residence as a last resort. */
function eraYear(indi: Individual, ds: Dataset): number | undefined {
  return (
    birthYear(indi) ??
    estimatedBirthYear(indi, ds) ??
    deathYear(indi) ??
    indi.events.find((e) => e.tag === "MARR" || e.tag === "RESI")?.date?.year
  );
}

/**
 * Stable blocking keys for an individual (recall-oriented, cheap).
 *
 * A bare surname-soundex key would make blocking useless for common surnames
 * in large datasets (thousands of same-surname individuals across centuries)
 * — every comparison would have to consider the whole bucket. So a known (or
 * relative-derived estimated) birth year scopes the key to nearby decades
 * instead of the full surname; the unscoped surname key is only a fallback
 * for individuals with no usable date at all.
 */
export function individualBlockKeys(
  indi: Individual,
  soundex: (s: string) => string,
  ds: Dataset,
): string[] {
  // A record whose only name parts are placeholders gets no blocking key at
  // all — it can't be meaningfully matched by name. (Relationship linking can
  // still connect it through matched relatives, which needs no name.)
  const n = comparableName(primaryName(indi));
  const surname = n?.surname;
  const given = n?.given;
  const sdx = soundex(surname ?? given ?? "");
  if (!sdx) return [];

  const keys: string[] = [];
  const realYear = indi.events.find((e) => e.tag === "BIRT")?.date?.year;
  const year = realYear ?? estimatedBirthYear(indi, ds);
  if (year !== undefined) {
    const decade = Math.floor(year / 10);
    // An estimate is rougher than a recorded date, so widen the window.
    const spread = realYear !== undefined ? 1 : 2;
    for (let d = decade - spread; d <= decade + spread; d++) keys.push(`SB:${sdx}:${d}`);
  } else {
    keys.push(`S:${sdx}`);
  }
  if (given) keys.push(`SG:${sdx}:${foldToken(given)[0] ?? ""}`);
  return keys;
}
