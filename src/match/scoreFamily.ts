import type { Dataset, Family, PersonName } from "../gedcom/types";
import { spouseTitle } from "./relatives";
import { dateSimilarity, givenSimilarity, nameSetSimilarity, placeSimilarity } from "./similarity";
import { foldToken, jaroWinkler, soundex } from "./text";
import {
  categorize,
  combineComponents,
  type FamilyCandidate,
  type MatchConfig,
  type ScoreComponent,
} from "./types";

/**
 * The family identity key: the two spouses and the marriage date. A perfect
 * match on all three means the same family and scores a flat 100; 100 is
 * reserved for that case so secondary fields (place, children) can never round
 * an imperfect-key pair up to it.
 */
const KEY_FIELDS = ["husband", "wife", "marriageDate"] as const;

/** Score a master/compare family pair via its spouses, marriage, and children. */
export function scoreFamilyPair(
  master: Family,
  compare: Family,
  masterDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
): FamilyCandidate {
  const w = config.familyWeights;
  const components: ScoreComponent[] = [];

  addSpouseKey(components, "husband", w.husband, name(master.husband, masterDs), name(compare.husband, compareDs), config.missingKeyScore);
  addSpouseKey(components, "wife", w.wife, name(master.wife, masterDs), name(compare.wife, compareDs), config.missingKeyScore);

  const mm = master.events.find((e) => e.tag === "MARR");
  const cm = compare.events.find((e) => e.tag === "MARR");
  addKey(components, "marriageDate", w.marriageDate, dateSimilarity(mm?.date, cm?.date), config.missingKeyScore, `${mm?.date?.raw ?? "—"} ~ ${cm?.date?.raw ?? "—"}`);
  add(components, "marriagePlace", w.marriagePlace, placeSimilarity(mm?.place, cm?.place));

  add(
    components,
    "children",
    w.children,
    nameSetSimilarity(childNames(master, masterDs), childNames(compare, compareDs)),
  );

  let score01 = combineComponents(components);

  // Conclusive identity: both spouses and the marriage date present and an exact
  // match means the same family — score a flat 100. Otherwise 100 is unreachable.
  const keyPerfect = KEY_FIELDS.every((k) => {
    const c = components.find((x) => x.key === k);
    return c !== undefined && !c.missing && c.score === 1;
  });
  if (keyPerfect) score01 = 1;

  let score = Math.round(score01 * 1000) / 10;
  if (!keyPerfect && score >= 100) score = 99.9;

  return {
    masterId: master.id,
    compareId: compare.id,
    score,
    category: categorize(score01, config),
    components,
    title: familyPairTitle(master, compare, masterDs, compareDs),
  };
}

/** Blocking key: sorted soundex of the two spouse surnames. */
export function familyBlockKeys(fam: Family, ds: Dataset): string[] {
  const codes = [fam.husband, fam.wife]
    .map((id) => soundex(name(id, ds)?.surname ?? ""))
    .filter(Boolean)
    .sort();
  return codes.length ? [`F:${codes.join("|")}`] : [];
}

/**
 * Add a spouse as an identity-key field. A spouse absent on either side carries
 * the `missingKeyScore` penalty (and is flagged `missing`), so a family that
 * records only one spouse can't reach a confident match. A spouse present but
 * incompletely named is scored with per-part penalties via {@link spouseNameScore}
 * so an incomplete name (e.g. a given name with no surname) can never score a
 * perfect 1.
 */
function addSpouseKey(
  into: ScoreComponent[],
  key: string,
  weight: number,
  a: PersonName | undefined,
  b: PersonName | undefined,
  missingKeyScore: number,
): void {
  const detail = `${a?.full ?? "—"} ~ ${b?.full ?? "—"}`;
  const sim = a && b ? spouseNameScore(a, b, missingKeyScore) : undefined;
  if (sim === undefined) {
    into.push({ key, weight, score: missingKeyScore, detail, missing: true });
    return;
  }
  into.push({ key, weight, score: sim, detail });
}

/**
 * Spouse-name similarity that treats surname and given as key parts: a part
 * present on one side but missing on the other is charged `missingKeyScore`
 * rather than ignored, so an incomplete name can't reach a perfect match (the
 * same rule the individual scorer applies to surname/given). Returns undefined
 * only when there is no comparable name content on either side.
 */
function spouseNameScore(a: PersonName, b: PersonName, missingKeyScore: number): number | undefined {
  const parts: Array<[number, number]> = []; // [weight, score]
  if (a.surname || b.surname) {
    const s = a.surname && b.surname ? jaroWinkler(foldToken(a.surname), foldToken(b.surname)) : missingKeyScore;
    parts.push([0.6, s]);
  }
  if (a.given || b.given) {
    const g = a.given && b.given ? givenSimilarity(a.given, b.given) : missingKeyScore;
    parts.push([0.4, g]);
  }
  if (parts.length === 0) {
    return a.full && b.full ? jaroWinkler(foldToken(a.full), foldToken(b.full)) : undefined;
  }
  const wsum = parts.reduce((s, [pw]) => s + pw, 0);
  return parts.reduce((s, [pw, v]) => s + pw * v, 0) / wsum;
}

function add(into: ScoreComponent[], key: string, weight: number, score: number | undefined, detail?: string): void {
  if (score === undefined) return;
  into.push(detail ? { key, weight, score, detail } : { key, weight, score });
}

/**
 * Add a key field. Unlike `add`, a missing similarity is not skipped but
 * recorded with the `missingKeyScore` penalty and flagged `missing`, so absent
 * key data drags the overall score down instead of being silently excluded.
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

function name(id: string | undefined, ds: Dataset): PersonName | undefined {
  return id ? ds.individuals.get(id)?.names[0] : undefined;
}

function childNames(fam: Family, ds: Dataset): PersonName[] {
  return fam.children
    .map((id) => ds.individuals.get(id)?.names[0])
    .filter((n): n is PersonName => n !== undefined);
}

/** Master-centric family title: each spouse collapsed so identical names aren't repeated. */
function familyPairTitle(master: Family, compare: Family, masterDs: Dataset, compareDs: Dataset): string {
  const h = spouseTitle(name(master.husband, masterDs), name(compare.husband, compareDs));
  const w = spouseTitle(name(master.wife, masterDs), name(compare.wife, compareDs));
  return `${h} + ${w}`;
}
