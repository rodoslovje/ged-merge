// Data + geometry for the Timeline's "Lines" layout: the root person's blood
// line on a vertical year axis. Ancestors stand at their birth year above the
// root and converge on it, descendants branch out below it; each parent is
// joined to their child by a line. Across, the ancestors keep pedigree order —
// father's side left, mother's right, all the way up — and a person stands
// midway between the parents (or children) they connect, so the lines never
// cross within one side.
//
// Pure: the component (ui/TimelineLines.tsx) turns slots and years into pixels.

import { birthYear } from "../gedcom/lifespan";
import { splitParents } from "./fanLayout";
import type { TreeNode } from "./personTree";

/** One person on the chart. */
export interface LineagePoint {
  /** The tree node's key, unique per position. */
  key: string;
  node: TreeNode;
  /** Generations above (+) or below (−) the root. */
  gen: number;
  /** Horizontal position in slots (one slot per leaf); fractional between. */
  slot: number;
  /** The year the dot stands at — the birth year, else an estimate. */
  year?: number;
  /** `year` is guessed from a parent or child, not recorded. */
  estimated: boolean;
}

/** A parent–child line, from the older to the younger. */
export interface LineageLink {
  from: string;
  to: string;
}

export interface LineageLayout {
  points: LineagePoint[];
  links: LineageLink[];
  /** Slots used, left to right: the chart is `slots` wide. */
  slots: number;
  minYear?: number;
  maxYear?: number;
}

/** A generation's span, for a person whose birth year is not recorded: they
 *  are placed this far from the parent or child that has one. */
export const GENERATION_YEARS = 30;

/** The children a descendant node is drawn with: every union's, then those
 *  with no recorded other parent. */
function offspring(n: TreeNode): TreeNode[] {
  return [...n.partners.flatMap((p) => p.children), ...n.children];
}

/**
 * Lay out the root's ancestors and descendants on one year axis. Either tree
 * may be absent. `yearOf` reads a person's recorded birth year (overridable
 * for tests and for the privacy rule that keeps a living person's year off the
 * chart).
 */
export function layoutLineage(
  ancestors: TreeNode | undefined,
  descendants: TreeNode | undefined,
  yearOf: (n: TreeNode) => number | undefined = (n) => birthYear(n.main),
): LineageLayout {
  const points = new Map<string, LineagePoint>();
  const links: LineageLink[] = [];

  // Ancestors: leaves (people with no parents on the chart) take the next free
  // slot, in pedigree order; everyone else stands between their parents.
  let next = 0;
  const placeAncestor = (n: TreeNode, gen: number): number => {
    const [father, mother] = splitParents(n.children);
    const parents = [father, mother].filter((p): p is TreeNode => !!p);
    let slot: number;
    if (parents.length === 0) {
      slot = next++;
    } else {
      const xs = parents.map((p) => {
        links.push({ from: p.key, to: n.key });
        return placeAncestor(p, gen + 1);
      });
      slot = xs.reduce((a, b) => a + b, 0) / xs.length;
    }
    points.set(n.key, { key: n.key, node: n, gen, slot, year: yearOf(n), estimated: false });
    return slot;
  };
  const rootSlot = ancestors ? placeAncestor(ancestors, 0) : undefined;
  const ancSlots = next;

  // Descendants: the same, downwards, in their own slot run, then shifted so
  // their root lands on the ancestors' root. The two trees number their keys
  // independently, so a descendant's key carries a prefix — except the root,
  // who is one person and one dot.
  const rootKey = ancestors?.key ?? descendants?.key ?? "";
  const descKey = (n: TreeNode) => (n === descendants ? rootKey : `d:${n.key}`);
  const desc: LineagePoint[] = [];
  let dnext = 0;
  const placeDescendant = (n: TreeNode, gen: number): number => {
    const kids = offspring(n);
    let slot: number;
    if (kids.length === 0) {
      slot = dnext++;
    } else {
      const xs = kids.map((c) => {
        links.push({ from: descKey(n), to: descKey(c) });
        return placeDescendant(c, gen - 1);
      });
      slot = (xs[0] + xs[xs.length - 1]) / 2;
    }
    desc.push({ key: descKey(n), node: n, gen, slot, year: yearOf(n), estimated: false });
    return slot;
  };
  const descRootSlot = descendants ? placeDescendant(descendants, 0) : undefined;

  let slots = ancSlots;
  if (descRootSlot !== undefined) {
    const shift = (rootSlot ?? descRootSlot) - descRootSlot;
    let lo = 0;
    let hi = slots - 1;
    for (const p of desc) {
      const slot = p.slot + shift;
      lo = Math.min(lo, slot);
      hi = Math.max(hi, slot);
      if (p.key === rootKey && points.has(rootKey)) continue;
      points.set(p.key, { ...p, slot });
    }
    if (lo < 0) for (const p of points.values()) p.slot -= lo;
    slots = hi - lo + 1;
  }

  estimateYears(points, links);

  let minYear: number | undefined;
  let maxYear: number | undefined;
  for (const p of points.values()) {
    if (p.year === undefined) continue;
    if (minYear === undefined || p.year < minYear) minYear = p.year;
    if (maxYear === undefined || p.year > maxYear) maxYear = p.year;
  }
  return { points: [...points.values()], links, slots: Math.max(slots, 1), minYear, maxYear };
}

/**
 * Fill in the missing years a generation away from a known one: a parent
 * {@link GENERATION_YEARS} before their child's year, a child the same after
 * their parent's. Repeated until nothing changes, so a run of undated
 * generations steps out from the nearest dated one; a person with no dated
 * relative anywhere keeps no year.
 */
function estimateYears(points: Map<string, LineagePoint>, links: LineageLink[]): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of links) {
      const older = points.get(l.from);
      const younger = points.get(l.to);
      if (!older || !younger) continue;
      if (older.year === undefined && younger.year !== undefined) {
        older.year = younger.year - GENERATION_YEARS;
        older.estimated = true;
        changed = true;
      } else if (younger.year === undefined && older.year !== undefined) {
        younger.year = older.year + GENERATION_YEARS;
        younger.estimated = true;
        changed = true;
      }
    }
  }
}
