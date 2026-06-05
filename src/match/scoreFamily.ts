import type { Dataset, Family, PersonName } from "../gedcom/types";
import { dateSimilarity, nameSetSimilarity, nameSimilarity, placeSimilarity } from "./similarity";
import { soundex } from "./text";
import {
  categorize,
  combineComponents,
  type FamilyCandidate,
  type MatchConfig,
  type ScoreComponent,
} from "./types";

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

  addSpouse(components, "husband", w.husband, name(master.husband, masterDs), name(compare.husband, compareDs));
  addSpouse(components, "wife", w.wife, name(master.wife, masterDs), name(compare.wife, compareDs));

  const mm = master.events.find((e) => e.tag === "MARR");
  const cm = compare.events.find((e) => e.tag === "MARR");
  add(components, "marriageDate", w.marriageDate, dateSimilarity(mm?.date, cm?.date));
  add(components, "marriagePlace", w.marriagePlace, placeSimilarity(mm?.place, cm?.place));

  add(
    components,
    "children",
    w.children,
    nameSetSimilarity(childNames(master, masterDs), childNames(compare, compareDs)),
  );

  const score01 = combineComponents(components);
  return {
    masterId: master.id,
    compareId: compare.id,
    score: Math.round(score01 * 1000) / 10,
    category: categorize(score01, config),
    components,
    masterLabel: familyLabel(master, masterDs),
    compareLabel: familyLabel(compare, compareDs),
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

function addSpouse(
  into: ScoreComponent[],
  key: string,
  weight: number,
  a: PersonName | undefined,
  b: PersonName | undefined,
): void {
  if (!a || !b) return;
  add(into, key, weight, nameSimilarity(a, b), `${a.full} ~ ${b.full}`);
}

function add(into: ScoreComponent[], key: string, weight: number, score: number | undefined, detail?: string): void {
  if (score === undefined) return;
  into.push(detail ? { key, weight, score, detail } : { key, weight, score });
}

function name(id: string | undefined, ds: Dataset): PersonName | undefined {
  return id ? ds.individuals.get(id)?.names[0] : undefined;
}

function childNames(fam: Family, ds: Dataset): PersonName[] {
  return fam.children
    .map((id) => ds.individuals.get(id)?.names[0])
    .filter((n): n is PersonName => n !== undefined);
}

function familyLabel(fam: Family, ds: Dataset): string {
  const h = name(fam.husband, ds)?.full ?? "?";
  const w = name(fam.wife, ds)?.full ?? "?";
  return `${h} + ${w}`;
}
