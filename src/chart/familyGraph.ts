// The 3D network chart's data: people as nodes, parent–child and couple links
// as edges. Walked breadth-first from the root, so a size limit keeps the
// people nearest them; with the whole-file scope the other trees in the file
// follow, each walked from its first person, until the limit is reached.
//
// Each connected person also gets a chart position (see NodePosition): a
// generation relative to the root (a parent is one up, a child one down, a
// partner level) and a line — which of the root's four grandparents the walk
// reached them through, so a cousin's whole cluster wears its grandparent's
// colour. The root's own household stays OWN_BRANCH, the partner's family
// takes SPOUSE_LINE. People in other trees have no position.
//
// Pure: no React, no DOM.

import type { Dataset, Individual } from "../gedcom/types";
import type { NodePosition } from "./nodeColor";
import { OWN_BRANCH } from "./kinshipWheel";

/** The line of the people reached through the root's partner. */
export const SPOUSE_LINE = "spouse";

export type GraphScope = "connected" | "file";

export interface GraphNode {
  id: string;
  indi: Individual;
  /** Absent for people in another tree than the root's. */
  pos?: NodePosition;
  /** Links walked from the root (or from their own tree's first person). */
  hops: number;
  /** 0 for the root's tree, then 1, 2, … for the others in walk order. */
  tree: number;
}

export interface GraphEdge {
  /** Indexes into the nodes: the parent (or the husband) first. */
  a: number;
  b: number;
  kind: "parent" | "couple";
}

/** One of the root's grandparent lines. */
export interface GraphLine {
  key: string;
  ancestorId: string;
  /** 0 father's father, 1 father's mother, 2 mother's father, 3 mother's mother. */
  index: number;
}

export interface FamilyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  lines: GraphLine[];
  /** People the scope holds in all; more than `nodes.length` when cut by the limit. */
  total: number;
  trees: number;
}

interface Step {
  id: string;
  gen: number;
  /** Who the root is to this person, as far as the line rules need it. */
  role: "root" | "parent" | "spouse" | "other";
}

/** The people one link away from `indi`, with the generation step and the
 *  role of each (the role only matters next to the root). */
function neighbours(ds: Dataset, indi: Individual, out: { id: string; dGen: number; rel: "parent" | "partner" | "child" }[]): void {
  out.length = 0;
  for (const famId of indi.childOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    if (fam.husband) out.push({ id: fam.husband, dGen: 1, rel: "parent" });
    if (fam.wife) out.push({ id: fam.wife, dGen: 1, rel: "parent" });
  }
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    const other = fam.husband === indi.id ? fam.wife : fam.husband;
    if (other) out.push({ id: other, dGen: 0, rel: "partner" });
    for (const c of fam.children) out.push({ id: c, dGen: -1, rel: "child" });
  }
}

/** The people around `rootId`, at most `limit` of them. */
export function buildFamilyGraph(ds: Dataset, rootId: string, scope: GraphScope, limit: number): FamilyGraph {
  const index = new Map<string, number>();
  const nodes: GraphNode[] = [];
  const lines: GraphLine[] = [];
  const near: { id: string; dGen: number; rel: "parent" | "partner" | "child" }[] = [];
  let total = 0;
  let trees = 0;

  // The root's parents in father-then-mother order, for the line indexes.
  const rootIndi = ds.individuals.get(rootId);
  const parentSide = new Map<string, number>();
  if (rootIndi) {
    for (const famId of rootIndi.childOf) {
      const fam = ds.families.get(famId);
      if (fam?.husband && !parentSide.has(fam.husband)) parentSide.set(fam.husband, 0);
      if (fam?.wife && !parentSide.has(fam.wife)) parentSide.set(fam.wife, 2);
    }
  }

  const walk = (startId: string, tree: number) => {
    const queue: (Step & { branch: string; hops: number })[] = [
      { id: startId, gen: 0, role: tree === 0 ? "root" : "other", branch: OWN_BRANCH, hops: 0 },
    ];
    const seen = new Set<string>([startId]);
    for (let q = 0; q < queue.length; q++) {
      const cur = queue[q];
      const indi = ds.individuals.get(cur.id);
      if (!indi) continue;
      total++;
      if (nodes.length < limit && !index.has(cur.id)) {
        index.set(cur.id, nodes.length);
        nodes.push({
          id: cur.id,
          indi,
          pos: tree === 0 ? { gen: cur.gen, branch: cur.branch } : undefined,
          hops: cur.hops,
          tree,
        });
      }
      neighbours(ds, indi, near);
      for (const n of near) {
        if (seen.has(n.id) || index.has(n.id) && tree > 0) continue;
        seen.add(n.id);
        let branch = cur.branch;
        let role: Step["role"] = "other";
        if (tree === 0) {
          if (cur.role === "root") role = n.rel === "parent" ? "parent" : n.rel === "partner" ? "spouse" : "other";
          else if (cur.role === "parent" && n.rel === "parent") {
            // A grandparent opens a line of their own.
            const side = parentSide.get(cur.id) ?? 0;
            const taken = lines.filter((l) => l.index >= side && l.index < side + 2).length;
            const line = { key: n.id, ancestorId: n.id, index: side + Math.min(taken, 1) };
            lines.push(line);
            branch = line.key;
          } else if (cur.role === "spouse" && n.rel === "parent") branch = SPOUSE_LINE;
        }
        queue.push({ id: n.id, gen: cur.gen + n.dGen, role, branch, hops: cur.hops + 1 });
      }
    }
  };

  if (rootIndi) walk(rootId, trees++);
  if (scope === "file") {
    for (const id of ds.individuals.keys()) {
      if (index.has(id)) continue;
      // Count the trees past the limit too, so the total stays honest — but a
      // walk that can add no one is cheap: only the counting runs.
      walk(id, trees++);
      if (nodes.length >= limit) {
        // Count the rest of the file without walking it again.
        total = ds.individuals.size;
        break;
      }
    }
  }

  // Edges among the included people, each family once.
  const edges: GraphEdge[] = [];
  const doneFams = new Set<string>();
  for (const node of nodes) {
    for (const famId of node.indi.spouseOf) {
      if (doneFams.has(famId)) continue;
      doneFams.add(famId);
      const fam = ds.families.get(famId);
      if (!fam) continue;
      const h = fam.husband !== undefined ? index.get(fam.husband) : undefined;
      const w = fam.wife !== undefined ? index.get(fam.wife) : undefined;
      if (h !== undefined && w !== undefined) edges.push({ a: h, b: w, kind: "couple" });
      for (const c of fam.children) {
        const ci = index.get(c);
        if (ci === undefined) continue;
        if (h !== undefined) edges.push({ a: h, b: ci, kind: "parent" });
        if (w !== undefined) edges.push({ a: w, b: ci, kind: "parent" });
      }
    }
  }
  return { nodes, edges, lines, total: Math.max(total, nodes.length), trees };
}
