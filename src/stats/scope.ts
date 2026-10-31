import type { KinshipSets } from "../tools/batch";
import { foldSearch } from "../ui/globalSearch";
import type { FamilyFacts, PersonFacts, StatsFacts } from "./facts";

/** Whose statistics: the whole file, or one of the start person's lines. */
export type StatsWho = "all" | "blood" | "ancestors" | "descendants";

/** The people the statistics are taken over, and how strictly they are read. */
export interface StatsScope {
  who: StatsWho;
  /** A country facet (see `placeCountryFacet`), `""` for "no place", null for any. */
  country: string | null;
  /** Text the person's place must contain (accent- and case-blind); empty for any. */
  place: string;
  /** Birth years, inclusive; a person with no birth year falls outside a bounded range. */
  from?: number;
  to?: number;
  sex: "all" | "M" | "F";
  /** Count ages and dates that rest on an approximate date (ABT, BEF, …). */
  approx: boolean;
}

export const DEFAULT_SCOPE: StatsScope = { who: "all", country: null, place: "", sex: "all", approx: false };

export interface ScopedFacts {
  people: PersonFacts[];
  /** Families with at least one spouse in scope. */
  families: FamilyFacts[];
  /** The ids of `people`. */
  ids: Set<string>;
  byId: StatsFacts["byId"];
  approx: boolean;
}

/** The kinship set a scope reads, the start person included. */
function lineOf(who: StatsWho, kinship: KinshipSets | null, startId: string | undefined): Set<string> | null {
  if (who === "all") return null;
  if (!kinship || !startId) return new Set();
  const set = who === "blood" ? kinship.blood : who === "ancestors" ? kinship.ancestors : kinship.descendants;
  return new Set([startId, ...set]);
}

/**
 * The people and families a scope keeps, without the country filter — the
 * country chips count what the rest of the scope leaves, so they are offered
 * before it narrows. {@link applyCountry} finishes the job.
 */
export function scopeFacts(
  facts: StatsFacts,
  scope: StatsScope,
  kinship: KinshipSets | null,
  startId: string | undefined,
): PersonFacts[] {
  const line = lineOf(scope.who, kinship, startId);
  const place = foldSearch(scope.place.trim());
  const bounded = scope.from !== undefined || scope.to !== undefined;
  return facts.people.filter((p) => {
    if (line && !line.has(p.id)) return false;
    if (scope.sex !== "all" && p.sex !== scope.sex) return false;
    if (bounded) {
      if (p.birthYear === undefined || (!scope.approx && p.birthApprox)) return false;
      if (scope.from !== undefined && p.birthYear < scope.from) return false;
      if (scope.to !== undefined && p.birthYear > scope.to) return false;
    }
    if (place && !p.placeKey.includes(place)) return false;
    return true;
  });
}

/** Narrow scoped people to one country and collect the families they are spouses in. */
export function applyCountry(facts: StatsFacts, people: PersonFacts[], scope: StatsScope): ScopedFacts {
  const kept = scope.country === null ? people : people.filter((p) => p.country === scope.country);
  const ids = new Set(kept.map((p) => p.id));
  const families = facts.families.filter((f) => (f.husband && ids.has(f.husband)) || (f.wife && ids.has(f.wife)));
  return { people: kept, families, ids, byId: facts.byId, approx: scope.approx };
}

/** A scope narrowed to the people `keep` admits — one side of a family, say —
 *  with the families those people are spouses in. */
export function narrowScoped(s: ScopedFacts, keep: (id: string) => boolean): ScopedFacts {
  const people = s.people.filter((p) => keep(p.id));
  const ids = new Set(people.map((p) => p.id));
  const families = s.families.filter((f) => (f.husband && ids.has(f.husband)) || (f.wife && ids.has(f.wife)));
  return { ...s, people, families, ids };
}
