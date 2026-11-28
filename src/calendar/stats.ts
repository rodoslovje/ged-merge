// "The family in numbers", seen from one person: descendants generation by
// generation, the known ancestors, every blood relative and how many of them
// live, the oldest known ancestor, the most common surnames and the centuries
// the family was born in. Pure.

import type { Dataset } from "../gedcom/types";
import { birthYear, isPresumedLiving } from "../gedcom/lifespan";
import { primaryName } from "../match/relatives";

export interface FamilyStats {
  /** Descendants per generation: children, grandchildren, great-grandchildren… */
  descendantsByGen: number[];
  descendants: number;
  ancestors: number;
  /** Known ancestors per generation: parents, grandparents… */
  ancestorsByGen: number[];
  /** Generations above the person that hold at least one known ancestor. */
  ancestorGens: number;
  /** Everyone sharing an ancestor with the person (themselves left out). */
  bloodRelatives: number;
  livingBloodRelatives: number;
  /** The known ancestor born earliest. */
  oldestAncestor?: { id: string; year: number };
  /** The surnames most blood relatives (and the person) carry, commonest first. */
  topSurnames: { name: string; count: number }[];
  /** The person and their blood relatives by century of birth (1800 = born
   *  1800–1899), every century from the first to the last. */
  birthsByCentury: { century: number; count: number }[];
}

const TOP_SURNAMES = 5;

function childrenOf(ds: Dataset, id: string): string[] {
  const out: string[] = [];
  for (const famId of ds.individuals.get(id)?.spouseOf ?? []) out.push(...(ds.families.get(famId)?.children ?? []));
  return out;
}

export function familyStats(ds: Dataset, rootId: string, nowYear: number): FamilyStats {
  // Descendants, generation by generation; a person reached twice counts once.
  const seenDown = new Set([rootId]);
  const descendantsByGen: number[] = [];
  let level = [rootId];
  while (level.length) {
    const next: string[] = [];
    for (const id of level) for (const c of childrenOf(ds, id)) if (!seenDown.has(c)) { seenDown.add(c); next.push(c); }
    if (next.length) descendantsByGen.push(next.length);
    level = next;
  }

  // Ancestors with their generation.
  const ancGen = new Map([[rootId, 0]]);
  const queue = [rootId];
  for (let i = 0; i < queue.length; i++) {
    for (const famId of ds.individuals.get(queue[i])?.childOf ?? []) {
      const fam = ds.families.get(famId);
      for (const p of [fam?.husband, fam?.wife]) {
        if (p && !ancGen.has(p)) { ancGen.set(p, ancGen.get(queue[i])! + 1); queue.push(p); }
      }
    }
  }

  // Blood relatives: every ancestor's descendants, each person walked once.
  const blood = new Set<string>(ancGen.keys());
  const walk = [...ancGen.keys()];
  for (let i = 0; i < walk.length; i++) for (const c of childrenOf(ds, walk[i])) if (!blood.has(c)) { blood.add(c); walk.push(c); }
  blood.delete(rootId);

  let living = 0;
  const surnames = new Map<string, number>();
  const centuries = new Map<number, number>();
  for (const id of [rootId, ...blood]) {
    const indi = ds.individuals.get(id);
    const born = birthYear(indi);
    if (born !== undefined) {
      const c = Math.floor(born / 100) * 100;
      centuries.set(c, (centuries.get(c) ?? 0) + 1);
    }
    if (id !== rootId && isPresumedLiving(indi, ds, nowYear)) living++;
    const s = indi && primaryName(indi)?.surname?.trim();
    if (s) surnames.set(s, (surnames.get(s) ?? 0) + 1);
  }
  const topSurnames = [...surnames]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_SURNAMES);
  const birthsByCentury: FamilyStats["birthsByCentury"] = [];
  if (centuries.size) {
    let first = Infinity;
    let last = -Infinity;
    for (const c of centuries.keys()) { if (c < first) first = c; if (c > last) last = c; }
    for (let c = first; c <= last; c += 100) birthsByCentury.push({ century: c, count: centuries.get(c) ?? 0 });
  }

  let oldestAncestor: FamilyStats["oldestAncestor"];
  for (const id of ancGen.keys()) {
    if (id === rootId) continue;
    const y = birthYear(ds.individuals.get(id));
    if (y !== undefined && (!oldestAncestor || y < oldestAncestor.year)) oldestAncestor = { id, year: y };
  }

  // Not `Math.max(...values)`: a very large file's root can have more
  // ancestors than a call takes arguments.
  const ancestorsByGen: number[] = [];
  for (const gen of ancGen.values()) if (gen > 0) ancestorsByGen[gen - 1] = (ancestorsByGen[gen - 1] ?? 0) + 1;

  return {
    descendantsByGen,
    descendants: seenDown.size - 1,
    ancestors: ancGen.size - 1,
    ancestorsByGen,
    ancestorGens: ancestorsByGen.length,
    bloodRelatives: blood.size,
    livingBloodRelatives: living,
    oldestAncestor,
    topSurnames,
    birthsByCentury,
  };
}
