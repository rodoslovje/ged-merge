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

import type { Dataset, Sex } from "../gedcom/types";
import { lifespanOf } from "../gedcom/lifespan";
import { NODE_H, NODE_W, PAD, type ChartAlignment } from "../tree/treeLayout";
import { localityParts } from "../gedcom/place";
import { displayName, primaryName } from "./relatives";
import type { MarriageInfo } from "../tree/compareTree";
import type { RelationshipPath } from "./relationshipPath";

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
  let apexIdx = 0;
  for (let i = 0; i < n; i++) if (gen[i] === maxGen) { apexIdx = i; break; }
  const hasDescent = apexIdx < n - 1;

  // 2. Spine columns. A direct ancestral line stays in ONE column (drawn as a
  //    vertical rail); the single sideways step is at the apex, where the path
  //    crosses to the descending rail. Spouse hops also step sideways.
  const col: number[] = [0];
  for (let i = 1; i < n; i++) {
    const e = steps[i].edge;
    if (e === "child") col[i] = col[i - 1] + (steps[i - 1].edge === "parent" ? 1 : 0);
    else if (e === "spouse") col[i] = col[i - 1] + 1;
    else col[i] = col[i - 1]; // parent: same column
  }
  const rowOf = (g: number) => maxGen - g;

  // 3. Place every box. Spine first (path order); each link's "other parent"
  //    (the spouse not on the path) sits one column to the outer side of its
  //    rail. The apex's spouse goes to the descending side so it heads that rail.
  const place = new Map<string, Pos>();
  const order: string[] = [];
  const put = (id: string, c: number, r: number, onSpine: boolean) => {
    if (place.has(id)) return;
    place.set(id, { col: c, row: r, onSpine });
    order.push(id);
  };
  for (let i = 0; i < n; i++) put(steps[i].id, col[i], rowOf(gen[i]), true);

  const partners: [string, string][] = [];
  const dropChildren: string[] = [];
  for (let i = 1; i < n; i++) {
    const e = steps[i].edge!;
    if (e === "spouse") {
      partners.push([steps[i - 1].id, steps[i].id]);
      continue;
    }
    const childId = e === "parent" ? steps[i - 1].id : steps[i].id;
    const parentId = e === "parent" ? steps[i].id : steps[i - 1].id;
    const other = otherParent(ds, childId, parentId);
    if (other) {
      // Ascending links put the spouse on the left rail-edge; the apex couple
      // and descending links put it on the right (the descending rail head).
      const onTargetSide = e === "child" || (i === apexIdx && hasDescent);
      const parentPos = place.get(parentId)!;
      put(other, parentPos.col + (onTargetSide ? 1 : -1), parentPos.row, false);
      partners.push([parentId, other]);
    }
    dropChildren.push(childId);
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
      name: indi ? displayName(primaryName(indi)) : id,
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
  for (const childId of dropChildren) {
    const c = coordOf(place.get(childId)!);
    const d = lr
      ? `M${c.x - ROW_GAP_TD},${c.y + nodeH / 2} H${c.x}`
      : `M${c.x + NODE_W / 2},${c.y - ROW_GAP_TD} V${c.y}`;
    links.push({ id: `c~${childId}`, d, kind: "parent" });
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
    return year || place ? { year, place } : undefined;
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
