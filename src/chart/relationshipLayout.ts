// Top-down pedigree layout for a single relationship path (start → target).
//
// Unlike the left-to-right `tree/treeLayout.ts` (a full descendant tree with
// Bézier connectors), this lays out one *chain* that rises to a common ancestor
// and falls to the target, in the MacFamilyTree "relationship chart" style:
// generations stack vertically (apex on top), each parent/child link draws the
// path-parent together with the child's *other* parent as a couple, and
// connectors are orthogonal elbows. The chain never revisits a generation on the
// same side, so no collision search is needed — a left-to-right column cursor in
// path order keeps every box in its own column.

import type { Dataset, Individual, Sex } from "../gedcom/types";
import { lifespanOf } from "../gedcom/lifespan";
import { NODE_H, NODE_W, PAD, type ChartAlignment } from "./treeLayout";
import { localityParts } from "../gedcom/place";
import { displayName, primaryName } from "../match/relatives";
import { coupleLiving, type MarriageInfo } from "./personTree";
import type { RelationshipPath } from "../match/relationshipPath";

export const ROW_GAP_TD = 72;
export const COL_GAP_TD = 44;
export const ROW_STEP_TD = NODE_H + ROW_GAP_TD;
export const COL_STEP_TD = NODE_W + COL_GAP_TD;

export interface ChartBox {
  key: string;
  id: string;
  name: string;
  years?: string;
  sex: Sex;
  x: number;
  y: number;
  /** True for people on the connecting path; false for context "other parent" boxes. */
  onSpine: boolean;
  /** Marks the two endpoints for emphasis. */
  role?: "start" | "target";
}

export interface ChartLink {
  id: string;
  d: string;
  kind: "partner" | "parent";
  /** The couple's marriage (year + place), on partner links when recorded. */
  marriage?: MarriageInfo;
  /** Label anchor (connector midpoint) for the marriage label. */
  mid?: { x: number; y: number };
}

export interface RelationshipChart {
  boxes: ChartBox[];
  links: ChartLink[];
  width: number;
  height: number;
  /** Start box key — used to pin the initial scroll position. */
  rootKey: string;
}

interface Pos { col: number; row: number; onSpine: boolean; }

export function buildRelationshipChart(
  ds: Dataset,
  path: RelationshipPath,
  alignment: ChartAlignment = "tb",
  nodeH: number = NODE_H,
  /** How a person's name reads — the app's Name-display settings. Defaults to
   *  the plain primary name for callers with no settings to hand. */
  nameOf: (indi: Individual) => string = (indi) => displayName(primaryName(indi)),
): RelationshipChart {
  const steps = path.steps;
  const n = steps.length;
  if (n === 0) return { boxes: [], links: [], width: PAD * 2, height: PAD * 2, rootKey: "" };

  // 1. Generation per step: parent hop goes up (+1), child hop down (-1). The
  //    apex is the highest generation, where the path turns from rising to
  //    falling.
  const gen: number[] = [0];
  for (let i = 1; i < n; i++) {
    const e = steps[i].edge;
    gen[i] = gen[i - 1] + (e === "parent" ? 1 : e === "child" ? -1 : 0);
  }
  const maxGen = Math.max(...gen);
  const rowOf = (g: number) => maxGen - g;

  // 2+3. Columns and placement in one left-to-right walk. Every maximal
  //   same-direction vertical run is ONE column (a straight rail); a rail's
  //   "other parent" context boxes share a reserved column just outside it. A
  //   new rail — the descent past a peak, a re-ascent out of a valley, or a
  //   spouse's own line — starts past everything placed so far (`frontier`), so
  //   rails never overlap and every child always has a box directly above (or,
  //   failing that, an elbow) to hang from. This handles paths that turn more
  //   than once (e.g. through a marriage into another family's pedigree), which
  //   a single rise-and-fall column cursor collapses onto itself.
  const place = new Map<string, Pos>();
  const order: string[] = [];
  const put = (id: string, c: number, r: number, onSpine: boolean) => {
    if (place.has(id)) return;
    place.set(id, { col: c, row: r, onSpine });
    order.push(id);
  };

  const partners: [string, string][] = [];
  const drops: { child: string; parent: string }[] = [];

  put(steps[0].id, 0, rowOf(gen[0]), true);
  let frontier = 0; // rightmost column used by any box so far
  let railCol = 0; // spine column of the rail currently being drawn
  let railSpouseCol: number | null = null; // reserved co-parent column for it
  let railSide = -1; // co-parents left (−1: the start's own climb) or right (+1)
  let descentHead: number | null = null; // column a peak reserved for its descent

  for (let i = 1; i < n; i++) {
    const e = steps[i].edge!;
    const prevId = steps[i - 1].id;
    const row = rowOf(gen[i]);

    if (e === "spouse") {
      // The spouse starts a new rail to the right of everything placed.
      railCol = frontier + 1;
      railSpouseCol = null;
      railSide = 1;
      descentHead = null;
      put(steps[i].id, railCol, row, true);
      frontier = Math.max(frontier, railCol);
      partners.push([prevId, steps[i].id]);
      continue;
    }

    const ascending = e === "parent";
    const childId = ascending ? prevId : steps[i].id;
    const parentId = ascending ? steps[i].id : prevId;
    const parentRow = rowOf(gen[ascending ? i : i - 1]);
    const other = otherParent(ds, childId, parentId);

    if (ascending) {
      // Re-ascending out of a valley (child→parent) starts a fresh rail.
      if (steps[i - 1].edge === "child") {
        railCol = frontier + 1;
        railSpouseCol = null;
        railSide = 1;
      }
      put(steps[i].id, railCol, row, true);
      const peak = i + 1 < n && steps[i + 1].edge === "child";
      if (other) {
        if (peak) {
          // The co-parent heads the coming descent: placed to the right, with
          // the descent rail hanging directly below it.
          put(other, frontier + 1, row, false);
          descentHead = place.get(other)!.col;
        } else {
          if (railSpouseCol === null) railSpouseCol = railSide < 0 ? railCol - 1 : frontier + 1;
          put(other, railSpouseCol, row, false);
        }
        partners.push([steps[i].id, other]);
        frontier = Math.max(frontier, place.get(other)!.col);
      }
      // The child sits directly below its on-spine parent in the same column.
      drops.push({ child: childId, parent: parentId });
    } else if (steps[i - 1].edge === "child") {
      // Continue the current descent rail downward.
      put(steps[i].id, railCol, row, true);
      if (other) {
        if (railSpouseCol === null) railSpouseCol = frontier + 1;
        put(other, railSpouseCol, parentRow, false);
        partners.push([parentId, other]);
        frontier = Math.max(frontier, railSpouseCol);
      }
      drops.push({ child: childId, parent: parentId }); // previous member, above
    } else {
      // Start a new descent rail: crossing a peak, or descending from a spouse.
      railSpouseCol = null;
      railSide = 1;
      if (descentHead !== null && other && place.get(other)?.col === descentHead) {
        // The peak's co-parent already heads this column, directly above.
        railCol = descentHead;
        put(steps[i].id, railCol, row, true);
        drops.push({ child: childId, parent: other });
      } else {
        railCol = frontier + 1;
        put(steps[i].id, railCol, row, true);
        if (other) {
          put(other, railCol, parentRow, false); // directly above the child
          partners.push([parentId, other]);
          drops.push({ child: childId, parent: other });
        } else {
          drops.push({ child: childId, parent: parentId }); // elbow from the parent
        }
      }
      descentHead = null;
      frontier = Math.max(frontier, railCol);
    }
  }

  // 4. Coordinates, normalized so the leftmost column is 0. PAD-relative (like
  //    tree/treeLayout): the SVG group draws with translate(PAD,PAD). Generations
  //    advance along the "depth" axis (vertical in the native top-down form),
  //    siblings/spouses along "breadth"; for "lr" the two axes swap. Step sizes
  //    follow the box dimension each axis advances along so nothing overlaps.
  const lr = alignment === "lr";
  const depthStep = lr ? NODE_W + ROW_GAP_TD : nodeH + ROW_GAP_TD;
  const breadthStep = lr ? nodeH + COL_GAP_TD : NODE_W + COL_GAP_TD;
  let minCol = Infinity;
  for (const p of place.values()) minCol = Math.min(minCol, p.col);
  const depthPx = (r: number) => r * depthStep;
  const breadthPx = (c: number) => (c - minCol) * breadthStep;
  const coordOf = (p: Pos) => ({
    x: lr ? depthPx(p.row) : breadthPx(p.col),
    y: lr ? breadthPx(p.col) : depthPx(p.row),
  });

  const boxes: ChartBox[] = order.map((id) => {
    const p = place.get(id)!;
    const indi = ds.individuals.get(id);
    const { x, y } = coordOf(p);
    return {
      key: id,
      id,
      name: indi ? nameOf(indi) : id,
      years: (indi && lifespanOf(indi)) || undefined,
      sex: indi?.sex ?? "U",
      x,
      y,
      onSpine: p.onSpine,
      role: id === steps[0].id ? "start" : id === steps[n - 1].id ? "target" : undefined,
    };
  });

  // 5. Connectors. Partner lines run along the breadth axis (horizontal in TB,
  //    vertical in LR); parent→child drops run along the depth axis from the box
  //    directly "above" each child (its parent or, at the apex, the apex's spouse
  //    heading the descending rail). Partner lines dedupe — the apex couple is
  //    reachable from both its links. ROW_GAP_TD is the gap between generations.
  const links: ChartLink[] = [];
  const seen = new Set<string>();
  const addPartner = (a: string, b: string) => {
    const pa = place.get(a), pb = place.get(b);
    if (!pa || !pb) return;
    const key = [a, b].sort().join("~");
    if (seen.has(key)) return;
    seen.add(key);
    // Order the couple along the breadth axis (lower column first).
    const [lo, hi] = pa.col <= pb.col ? [pa, pb] : [pb, pa];
    const cLo = coordOf(lo), cHi = coordOf(hi);
    const d = lr
      ? `M${cLo.x + NODE_W / 2},${cLo.y + nodeH} V${cHi.y}`
      : `M${cLo.x + NODE_W},${cLo.y + nodeH / 2} H${cHi.x}`;
    // Label anchor: LR stacks the couple vertically, so the gap between them has
    // room — sit on the connector. TB places them side by side with only a narrow
    // column gap, so drop the label just under the couple where it has space.
    const mid = lr
      ? { x: cLo.x + NODE_W / 2, y: (cLo.y + nodeH + cHi.y) / 2 }
      : { x: (cLo.x + cHi.x + NODE_W) / 2, y: cLo.y + nodeH + 13 };
    links.push({ id: `p~${key}`, d, kind: "partner", marriage: coupleMarriage(ds, a, b), mid });
  };
  for (const [a, b] of partners) addPartner(a, b);
  for (const { child, parent } of drops) {
    const c = coordOf(place.get(child)!);
    const p = coordOf(place.get(parent)!);
    // Orthogonal drop from the parent to the child, jogging across at the midway
    // gap when they sit in different columns — and collapsing to a straight line
    // when aligned. Along the depth axis the parent always precedes the child.
    const d = lr
      ? `M${p.x + NODE_W},${p.y + nodeH / 2} H${(p.x + NODE_W + c.x) / 2} V${c.y + nodeH / 2} H${c.x}`
      : `M${p.x + NODE_W / 2},${p.y + nodeH} V${(p.y + nodeH + c.y) / 2} H${c.x + NODE_W / 2} V${c.y}`;
    links.push({ id: `c~${child}`, d, kind: "parent" });
  }

  const width = Math.max(0, ...boxes.map((b) => b.x + NODE_W)) + PAD * 2;
  const height = Math.max(0, ...boxes.map((b) => b.y + nodeH)) + PAD * 2;
  return { boxes, links, width, height, rootKey: steps[0].id };
}

/** The marriage of the couple `a`+`b` — the year + most-specific locality of the
 *  MARR event in the family where they are spouses together, if recorded. */
function coupleMarriage(ds: Dataset, a: string, b: string): MarriageInfo | undefined {
  const indi = ds.individuals.get(a);
  if (!indi) return undefined;
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam || (fam.husband !== b && fam.wife !== b)) continue;
    const marr = fam.events.find((e) => e.tag === "MARR");
    if (!marr) return undefined;
    const year = marr.date?.year !== undefined ? String(marr.date.year) : undefined;
    const place = marr.place ? localityParts(marr.place)[0] : undefined;
    return year || place ? { year, place, ...(coupleLiving(fam, ds) ? { living: true } : null) } : undefined;
  }
  return undefined;
}

/** The child's parent that *isn't* the one on the path, if recorded. */
function otherParent(ds: Dataset, childId: string, parentId: string): string | undefined {
  const child = ds.individuals.get(childId);
  if (!child) return undefined;
  for (const famId of child.childOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    if (fam.husband === parentId) return fam.wife;
    if (fam.wife === parentId) return fam.husband;
  }
  return undefined;
}
