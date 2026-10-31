import type { StatsFacts } from "./facts";

/**
 * The Generations page: one person's ancestors and descendants, generation by
 * generation. It reads the whole file's rows rather than a scope — a
 * generation is a position in one person's tree, not a filter.
 */

/** Ancestor generations are followed no further than this, nor past this many positions. */
const MAX_GENERATIONS = 30;
const MAX_POSITIONS = 250_000;

export interface AncestorGeneration {
  /** 1 = parents, 2 = grandparents, … */
  gen: number;
  /** The positions the generation has (2^gen). */
  slots: number;
  /** The positions filled, counting an ancestor once per position they hold. */
  filled: number;
  /** The ancestors in the generation, each once. */
  ids: string[];
  /** The same, split by the side of the root's family the position stands on —
   *  above the father or above the mother; each side has half the slots. */
  paternal: { filled: number; ids: string[] };
  maternal: { filled: number; ids: string[] };
}

export interface LineageStats {
  ancestors: AncestorGeneration[];
  /** Distinct ancestors over all generations. */
  distinctAncestors: number;
  /** The share of filled positions held by an ancestor who also holds another (pedigree collapse). */
  implex: number;
  /** Ancestors holding more than one position, most positions first. */
  repeated: { id: string; count: number }[];
  /** Descendants by generation (1 = children), each in the first generation they appear in. */
  descendants: { gen: number; ids: string[] }[];
  /** Every descendant, and those presumed living. */
  descendantIds: string[];
  livingDescendants: string[];
  /** Ancestors presumed living. */
  livingAncestors: string[];
}

export function lineageStats(facts: StatsFacts, rootId: string): LineageStats {
  const ancestors: AncestorGeneration[] = [];
  const positions = new Map<string, number>();
  // Each position carries the side it stands on: the root's father opens the
  // paternal side, the mother the maternal one, and their ancestors inherit it.
  type Position = { id: string; paternal: boolean };
  let generation: Position[] = [{ id: rootId, paternal: true }];
  for (let gen = 1; gen <= MAX_GENERATIONS; gen++) {
    const next: Position[] = [];
    for (const { id, paternal } of generation) {
      const p = facts.byId.get(id);
      if (p?.father) next.push({ id: p.father, paternal: gen === 1 ? true : paternal });
      if (p?.mother) next.push({ id: p.mother, paternal: gen === 1 ? false : paternal });
    }
    if (!next.length || next.length > MAX_POSITIONS) break;
    for (const { id } of next) positions.set(id, (positions.get(id) ?? 0) + 1);
    const side = (paternal: boolean) => {
      const on = next.filter((pos) => pos.paternal === paternal);
      return { filled: on.length, ids: [...new Set(on.map((pos) => pos.id))] };
    };
    ancestors.push({
      gen,
      slots: 2 ** gen,
      filled: next.length,
      ids: [...new Set(next.map((pos) => pos.id))],
      paternal: side(true),
      maternal: side(false),
    });
    generation = next;
  }
  const filled = ancestors.reduce((n, g) => n + g.filled, 0);
  const repeated = [...positions]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count);

  const childrenOf = new Map<string, string[]>();
  for (const f of facts.families) {
    for (const parent of [f.husband, f.wife]) {
      if (!parent) continue;
      const kids = childrenOf.get(parent);
      if (kids) kids.push(...f.children);
      else childrenOf.set(parent, [...f.children]);
    }
  }
  const seen = new Set([rootId]);
  const descendants: { gen: number; ids: string[] }[] = [];
  let front = [rootId];
  for (let gen = 1; front.length; gen++) {
    const next: string[] = [];
    for (const id of front) {
      for (const child of childrenOf.get(id) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        next.push(child);
      }
    }
    if (next.length) descendants.push({ gen, ids: next });
    front = next;
  }
  const descendantIds = descendants.flatMap((g) => g.ids);

  return {
    ancestors,
    distinctAncestors: positions.size,
    livingAncestors: [...positions.keys()].filter((id) => facts.byId.get(id)?.living),
    implex: filled ? 1 - positions.size / filled : 0,
    repeated,
    descendants,
    descendantIds,
    livingDescendants: descendantIds.filter((id) => facts.byId.get(id)?.living),
  };
}
