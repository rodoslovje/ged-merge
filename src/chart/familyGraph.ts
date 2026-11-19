// The 3D network chart's data: people as nodes, plus one hub node per family
// (a couple and their children) — the partners hang on the hub side by side,
// the children below it, so each family reads as one cluster. Walked breadth-first from the root, so a size limit keeps the
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
import { bloodKin, OWN_BRANCH } from "./kinshipWheel";

/** The line of the people reached through the root's partner. */
export const SPOUSE_LINE = "spouse";

/** Blood relatives only, everyone linked to the root, or the whole file. */
export type GraphScope = "blood" | "connected" | "file";

export interface GraphNode {
  id: string;
  indi: Individual;
  /** Absent for people in another tree than the root's. */
  pos?: NodePosition;
  /** Links walked from the root (or from their own tree's first person). */
  hops: number;
  /** 0 for the root's tree, then 1, 2, … for the others in walk order. */
  tree: number;
  /** The node the walk reached them from; -1 for where a walk started. */
  via: number;
}

/** A family hub. Its layout index is `nodes.length` + its index in `families`. */
export interface GraphFamily {
  /** Node indexes of the partners on the chart (one may be missing). */
  partners: number[];
  children: number[];
}

export interface GraphEdge {
  /** Layout indexes: a partner and their family's hub, or a hub and a child. */
  a: number;
  b: number;
  kind: "partner" | "child";
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
  families: GraphFamily[];
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

/** The people around `rootId`, at most `limit` of them, none more than
 *  `maxGen` generations above or below where their walk started. */
export function buildFamilyGraph(ds: Dataset, rootId: string, scope: GraphScope, limit: number, maxGen = Infinity): FamilyGraph {
  const index = new Map<string, number>();
  const nodes: GraphNode[] = [];
  const lines: GraphLine[] = [];
  const near: { id: string; dGen: number; rel: "parent" | "partner" | "child" }[] = [];
  let total = 0;
  let trees = 0;
  // Blood relatives: the walk only steps onto people of the root's blood — the
  // ancestors and every descendant of theirs, partners left out. Each of them
  // is a parent–child chain away from the root, so the walk still reaches all.
  const blood = scope === "blood" ? new Set(bloodKin(ds, rootId).keys()) : undefined;

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
    const queue: (Step & { branch: string; hops: number; via: number })[] = [
      { id: startId, gen: 0, role: tree === 0 ? "root" : "other", branch: OWN_BRANCH, hops: 0, via: -1 },
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
          via: cur.via,
        });
      }
      const here = index.get(cur.id) ?? -1;
      neighbours(ds, indi, near);
      for (const n of near) {
        if (seen.has(n.id) || index.has(n.id) && tree > 0 || blood && !blood.has(n.id)) continue;
        // Past the generation limit the walk stops: no one beyond it is drawn,
        // and no one is reached through them.
        if (Math.abs(cur.gen + n.dGen) > maxGen) continue;
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
        queue.push({ id: n.id, gen: cur.gen + n.dGen, role, branch, hops: cur.hops + 1, via: here });
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

  // A hub per family with at least two of its people on the chart, each once;
  // the edges join its partners and its children to it.
  const families: GraphFamily[] = [];
  const doneFams = new Set<string>();
  for (const node of nodes) {
    for (const famId of node.indi.spouseOf) {
      if (doneFams.has(famId)) continue;
      doneFams.add(famId);
      const fam = ds.families.get(famId);
      if (!fam) continue;
      const partners: number[] = [];
      for (const p of [fam.husband, fam.wife]) {
        const pi = p !== undefined ? index.get(p) : undefined;
        if (pi !== undefined) partners.push(pi);
      }
      const children: number[] = [];
      for (const c of fam.children) {
        const ci = index.get(c);
        if (ci !== undefined) children.push(ci);
      }
      if (partners.length + children.length >= 2 && partners.length) families.push({ partners, children });
    }
  }
  const edges: GraphEdge[] = [];
  families.forEach((f, k) => {
    const hub = nodes.length + k;
    for (const p of f.partners) edges.push({ a: p, b: hub, kind: "partner" });
    for (const c of f.children) edges.push({ a: hub, b: c, kind: "child" });
  });
  return { nodes, families, edges, lines, total: Math.max(total, nodes.length), trees };
}
