// Top-down pedigree layout for a single relationship path (home → target).
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
import { NODE_H, NODE_W, PAD } from "../tree/treeLayout";
import { displayName, primaryName } from "./relatives";
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
  role?: "home" | "target";
}

export interface ChartLink {
  id: string;
  d: string;
  kind: "partner" | "parent";
}

export interface RelationshipChart {
  boxes: ChartBox[];
  links: ChartLink[];
  width: number;
  height: number;
  /** Home box key — used to pin the initial scroll position. */
  rootKey: string;
}

interface Pos { col: number; row: number; onSpine: boolean; }

export function buildRelationshipChart(ds: Dataset, path: RelationshipPath): RelationshipChart {
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
  //    tree/treeLayout): the SVG group draws with translate(PAD,PAD).
  let minCol = Infinity;
  for (const p of place.values()) minCol = Math.min(minCol, p.col);
  const xOf = (c: number) => (c - minCol) * COL_STEP_TD;
  const yOf = (r: number) => r * ROW_STEP_TD;

  const boxes: ChartBox[] = order.map((id) => {
    const p = place.get(id)!;
    const indi = ds.individuals.get(id);
    return {
      key: id,
      id,
      name: indi ? displayName(primaryName(indi)) : id,
      years: (indi && lifespanOf(indi)) || undefined,
      sex: indi?.sex ?? "U",
      x: xOf(p.col),
      y: yOf(p.row),
      onSpine: p.onSpine,
      role: id === steps[0].id ? "home" : id === steps[n - 1].id ? "target" : undefined,
    };
  });

  // 5. Connectors. Partner lines are horizontal; parent→child drops are vertical
  //    in the child's column (the box directly above each child is its parent or,
  //    at the apex, the apex's spouse heading the descending rail). Partner lines
  //    dedupe — the apex couple is reachable from both its links.
  const links: ChartLink[] = [];
  const seen = new Set<string>();
  const addPartner = (a: string, b: string) => {
    const pa = place.get(a), pb = place.get(b);
    if (!pa || !pb) return;
    const key = [a, b].sort().join("~");
    if (seen.has(key)) return;
    seen.add(key);
    const [l, r] = pa.col <= pb.col ? [pa, pb] : [pb, pa];
    const y = yOf(l.row) + NODE_H / 2;
    links.push({ id: `p~${key}`, d: `M${xOf(l.col) + NODE_W},${y} H${xOf(r.col)}`, kind: "partner" });
  };
  for (const [a, b] of partners) addPartner(a, b);
  for (const childId of dropChildren) {
    const c = place.get(childId)!;
    const cx = xOf(c.col) + NODE_W / 2;
    links.push({ id: `c~${childId}`, d: `M${cx},${yOf(c.row - 1) + NODE_H} V${yOf(c.row)}`, kind: "parent" });
  }

  const width = Math.max(0, ...boxes.map((b) => b.x + NODE_W)) + PAD * 2;
  const height = Math.max(0, ...boxes.map((b) => b.y + NODE_H)) + PAD * 2;
  return { boxes, links, width, height, rootKey: steps[0].id };
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
