import type { ScopedFacts } from "./scope";
import { birthYearOf, byLabel, centuryOf, mean, share, type Bucket, type CenturyPoint, type Mean, type Share } from "./aggregate";

/**
 * The Places page: how far lives moved, from the birth place to the death
 * place, and between which countries.
 */

/** The distances a move is read in, kilometres: the same place, the next
 *  village, the district, the region, the country, and abroad far away. */
const DISTANCE_SPANS = [0, 1, 10, 50, 200, 1000];

export interface MigrationStats {
  /** Birth-to-death distance in spans; bucket keys are the span's lower bound in km. */
  distance: Bucket[];
  distanceMean?: Mean;
  distanceByCentury: CenturyPoint[];
  /** Of the people whose birth and death countries are both known, those who differ. */
  emigrants: Share;
  /** Moves between countries, keyed `from>to`, most common first. */
  countryMoves: Bucket[];
  /** Of the couples whose birth places are both known, those born in the same place (family ids). */
  samePlaceCouples: Share;
}

export function migrationStats(s: ScopedFacts): MigrationStats {
  const year = birthYearOf(s);
  const moved = s.people.filter((p) => p.movedKm !== undefined);

  const distance: Bucket[] = DISTANCE_SPANS.map((lo, i) => ({
    key: String(lo), lo, hi: DISTANCE_SPANS[i + 1], count: 0, ids: [],
  }));
  for (const p of moved) {
    const km = p.movedKm!;
    let i = DISTANCE_SPANS.length - 1;
    while (i > 0 && km < DISTANCE_SPANS[i]) i--;
    distance[i].count++;
    distance[i].ids.push(p.id);
  }

  const centuries = new Map<number, { sum: number; ids: string[] }>();
  for (const p of moved) {
    const y = year(p);
    if (y === undefined) continue;
    const c = centuryOf(y);
    let g = centuries.get(c);
    if (!g) centuries.set(c, (g = { sum: 0, ids: [] }));
    g.sum += p.movedKm!;
    g.ids.push(p.id);
  }

  const both = s.people.filter((p) => p.birthCountry && p.deathCountry);
  const moves = new Map<string, string[]>();
  for (const p of both) {
    if (p.birthCountry === p.deathCountry) continue;
    const key = `${p.birthCountry}>${p.deathCountry}`;
    const ids = moves.get(key);
    if (ids) ids.push(p.id);
    else moves.set(key, [p.id]);
  }

  const birthKey = (pid: string | undefined) => (pid && s.byId.get(pid)?.birthPlaceKey) || undefined;
  const couples = s.families.filter((f) => birthKey(f.husband) && birthKey(f.wife));

  return {
    distance,
    distanceMean: mean(moved.map((p) => p.movedKm!)),
    distanceByCentury: [...centuries]
      .sort((a, b) => a[0] - b[0])
      .map(([century, g]) => ({ century, value: g.sum / g.ids.length, n: g.ids.length, ids: g.ids })),
    emigrants: share(both, (p) => p.birthCountry !== p.deathCountry),
    countryMoves: [...moves]
      .map(([key, ids]) => ({ key, count: ids.length, ids }))
      .sort((a, b) => b.count - a.count || byLabel.compare(a.key, b.key)),
    samePlaceCouples: share(couples, (f) => birthKey(f.husband) === birthKey(f.wife)),
  };
}
