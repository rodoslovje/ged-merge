// The Edit view's "Wider family" panel: the relatives around a person beyond
// the parents, siblings, partners and children Edit already shows as cards.
//
// Three depths bound the walk, the way Family Echo's settings do:
//  - ancestors   — generations up (2 = grandparents),
//  - descendants — generations down (2 = grandchildren),
//  - others      — for every ancestor within reach, how far down their *other*
//                  descendants are followed (1 = uncles & aunts, 2 = first
//                  cousins and nephews/nieces).
// Pure: no React, so it is tested on its own and cheap to call per person.

import type { Dataset } from "../gedcom/types";
import { birthSortKey } from "../gedcom/lifespan";
import { childrenOf, parentsOf } from "./kinshipWheel";

export interface WiderFamilyDepth {
  ancestors: number;
  descendants: number;
  others: number;
  /** Also list each shown relative's partners (aunts and uncles by marriage…). */
  partners: boolean;
}

export type WiderSide = "father" | "mother" | "own";

export interface WiderRelative {
  id: string;
  /** Generations up to the common ancestor, and back down to this person. */
  up: number;
  down: number;
  /** The parent whose line this relative is on; "own" for the person's own
   *  issue and their siblings' (both lines). */
  side: WiderSide;
  /** Set for a partner listed because of the relative it names. */
  partnerOf?: string;
}

/** One heading's worth: everyone at the same blood position. */
export interface WiderGroup {
  up: number;
  down: number;
  members: WiderRelative[];
}

const SIDE_ORDER: Record<WiderSide, number> = { father: 0, mother: 1, own: 2 };

/**
 * The person's wider family, grouped by blood position and ordered nearest
 * first — by blood distance (up + down), elders before juniors at the same
 * distance. Inside a group: father's side, mother's side, then by birth.
 *
 * Each relative is placed by their *closest* path (pedigree collapse can give
 * several), walking distance buckets the way {@link bloodKin} does. Everyone
 * the Edit cards already show — parents, siblings and half-siblings, children —
 * is left out, as are the person's own partners.
 */
export function widerFamily(ds: Dataset, rootId: string, depth: WiderFamilyDepth): WiderGroup[] {
  const root = ds.individuals.get(rootId);
  if (!root) return [];

  // The ancestors within reach, each with the parent's line they are on.
  const lines = new Map<string, { gen: number; side: WiderSide }>([[rootId, { gen: 0, side: "own" }]]);
  const queue = [rootId];
  for (let i = 0; i < queue.length; i++) {
    const at = lines.get(queue[i])!;
    if (at.gen >= depth.ancestors) continue;
    for (const p of parentsOf(ds, queue[i])) {
      if (lines.has(p.id)) continue;
      lines.set(p.id, { gen: at.gen + 1, side: at.gen === 0 ? p.role : at.side });
      queue.push(p.id);
    }
  }

  interface Step { id: string; up: number; down: number; side: WiderSide }
  const buckets: Step[][] = [];
  const push = (m: number, s: Step) => (buckets[m] ??= []).push(s);
  // Sorted so pedigree collapse resolves the same way on every run.
  const seeds = [...lines].sort((a, b) => a[1].gen - b[1].gen || (a[0] < b[0] ? -1 : 1));
  for (const [id, line] of seeds) push(line.gen, { id, up: line.gen, down: 0, side: line.side });

  const placed = new Map<string, Step>();
  for (let m = 0; m < buckets.length; m++) {
    for (const step of buckets[m] ?? []) {
      if (placed.has(step.id)) continue;
      placed.set(step.id, step);
      const reach = step.up === 0 ? depth.descendants : depth.others;
      if (step.down >= reach) continue;
      for (const childId of childrenOf(ds, step.id)) {
        if (!placed.has(childId)) {
          push(m + 1, { id: childId, up: step.up, down: step.down + 1, side: step.up <= 1 ? "own" : step.side });
        }
      }
    }
  }

  // What the cards above already show: the person, parents, siblings, children.
  const onCards = (s: Step) => s.up + s.down <= 1 || (s.up === 1 && s.down === 1);
  const shown: WiderRelative[] = [...placed.values()]
    .filter((s) => !onCards(s))
    .map(({ id, up, down, side }) => ({ id, up, down, side: up <= 1 ? "own" : side }));

  if (depth.partners) {
    const ownPartners = new Set(root.spouseOf.flatMap((f) => {
      const fam = ds.families.get(f);
      return fam ? [fam.husband, fam.wife] : [];
    }));
    const listed = new Set(shown.map((r) => r.id));
    for (const r of [...shown]) {
      if (r.down === 0) continue; // an ancestor's partner is an ancestor, or a step-grandparent
      for (const famId of ds.individuals.get(r.id)?.spouseOf ?? []) {
        const fam = ds.families.get(famId);
        const partner = fam && (fam.husband === r.id ? fam.wife : fam.husband);
        if (!partner || partner === rootId || listed.has(partner) || placed.has(partner) || ownPartners.has(partner)) continue;
        listed.add(partner);
        shown.push({ id: partner, up: r.up, down: r.down, side: r.side, partnerOf: r.id });
      }
    }
  }

  const groups = new Map<string, WiderGroup>();
  for (const r of shown) {
    const key = `${r.up}:${r.down}`;
    if (!groups.has(key)) groups.set(key, { up: r.up, down: r.down, members: [] });
    groups.get(key)!.members.push(r);
  }
  // A partner sorts with the relative it belongs to: same side, same birth key.
  const anchor = (r: WiderRelative) => ds.individuals.get(r.partnerOf ?? r.id);
  for (const g of groups.values()) {
    g.members.sort((a, b) =>
      SIDE_ORDER[a.side] - SIDE_ORDER[b.side]
      || birthSortKey(anchor(a)) - birthSortKey(anchor(b))
      || (a.partnerOf ? 1 : 0) - (b.partnerOf ? 1 : 0));
  }
  return [...groups.values()].sort((a, b) => a.up + a.down - (b.up + b.down) || b.up - a.up);
}
