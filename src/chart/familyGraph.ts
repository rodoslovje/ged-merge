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

import type { AssocRole, Dataset, Individual } from "../gedcom/types";
import type { AssociationIndex } from "../gedcom/assoc";
import type { Translate } from "../locales/i18n";
import { lineColor, paletteColor, type BranchInfo, type NodePosition } from "./nodeColor";
import { bloodKin, OWN_BRANCH } from "./kinshipWheel";

/** The line of the people reached through the root's partner. */
export const SPOUSE_LINE = "spouse";
/** The line of the people reached through a godparent or a witness. */
export const ASSOC_LINE = "assoc";

/** Blood relatives only, everyone linked to the root, or the whole file. */
export type GraphScope = "blood" | "connected" | "file";

export interface GraphNode {
  id: string;
  indi: Individual;
  /** Absent for people in another tree than the root's. */
  pos?: NodePosition;
  /** Generations above (+) or below (−) where their walk started — the root,
   *  or their own tree's first person. */
  gen: number;
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

/** A godparent, witness or other associate and whose event names them. Not a
 *  family link: it joins no hub, and the layout holds it only weakly. */
export interface GraphAssoc {
  /** Layout index of whose event it is: a person, or a family's hub (a
   *  wedding's witness belongs to the couple). */
  a: number;
  /** Node index of the associate. */
  b: number;
  kind: AssocKind;
}

/** The kinds of association the chart tells apart — and shows or hides each
 *  on its own: godparents, witnesses, and everyone else a record names. */
export const ASSOC_KINDS = ["godp", "witn", "other"] as const;
export type AssocKind = (typeof ASSOC_KINDS)[number];

export function assocKind(role: AssocRole): AssocKind {
  return role === "GODP" ? "godp" : role === "WITN" ? "witn" : "other";
}

/** How many associations of each kind the file holds. */
export function assocKindCounts(index: AssociationIndex): Record<AssocKind, number> {
  const counts: Record<AssocKind, number> = { godp: 0, witn: 0, other: 0 };
  for (const refs of index.values()) for (const ref of refs) counts[assocKind(ref.assoc.role)]++;
  return counts;
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
  /** Empty unless the graph was built with the file's associations. */
  assocs: GraphAssoc[];
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

interface Near {
  id: string;
  dGen: number;
  rel: "parent" | "partner" | "child" | "assoc";
  /** A parent who is the family's wife: the mother's side of a line. */
  mother?: boolean;
}

/** The people one link away from `indi`, with the generation step and the
 *  role of each (the role only matters next to the root). */
function neighbours(ds: Dataset, indi: Individual, out: Near[], ties?: AssocTies): void {
  out.length = 0;
  for (const famId of indi.childOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    if (fam.husband) out.push({ id: fam.husband, dGen: 1, rel: "parent" });
    if (fam.wife) out.push({ id: fam.wife, dGen: 1, rel: "parent", mother: true });
  }
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    const other = fam.husband === indi.id ? fam.wife : fam.husband;
    if (other) out.push({ id: other, dGen: 0, rel: "partner" });
    for (const c of fam.children) out.push({ id: c, dGen: -1, rel: "child" });
  }
  // After the family: a godparent who is also an uncle is reached as the uncle.
  const tied = ties?.near.get(indi.id);
  if (tied) for (const n of tied) out.push(n);
}

interface AssocTie {
  fromId: string;
  family: boolean;
  toId: string;
  kind: AssocKind;
}

/** The file's associations as the walk and the chart need them. */
interface AssocTies {
  /** Per person, who an association joins them to — in either direction. */
  near: Map<string, Near[]>;
  list: AssocTie[];
}

/** A godparent stands a generation above the child they held at the font —
 *  mostly one of the parents' own — and everyone else beside whose event it
 *  was. A guess that only places them: no kinship is read off it. */
const BAPTISMS: ReadonlySet<string | undefined> = new Set([undefined, "BIRT", "BAPM", "CHR"]);

function assocTies(ds: Dataset, index: AssociationIndex, kinds?: ReadonlySet<AssocKind>): AssocTies {
  const near = new Map<string, Near[]>();
  const list: AssocTie[] = [];
  const link = (from: string, to: string, dGen: number) => {
    const l = near.get(from);
    if (l) l.push({ id: to, dGen, rel: "assoc" });
    else near.set(from, [{ id: to, dGen, rel: "assoc" }]);
  };
  for (const [toId, refs] of index) {
    if (!ds.individuals.has(toId)) continue; // a 5.5.1 pointer at a family
    for (const ref of refs) {
      const kind = assocKind(ref.assoc.role);
      if (kinds && !kinds.has(kind)) continue;
      const family = ref.fromKind === "family";
      const fam = family ? ds.families.get(ref.fromId) : undefined;
      const whose = family ? [fam?.husband, fam?.wife] : [ref.fromId];
      const up = !family && ref.assoc.role === "GODP" && BAPTISMS.has(ref.eventTag) ? 1 : 0;
      let any = false;
      for (const id of whose) {
        if (id === undefined || id === toId || !ds.individuals.has(id)) continue;
        link(id, toId, up);
        link(toId, id, -up);
        any = true;
      }
      if (any) list.push({ fromId: ref.fromId, family, toId, kind });
    }
  }
  return { near, list };
}

/** The graph's lines named and coloured for the Line axis: each grandparent
 *  line after its grandparent, and the partner's family. */
export function graphBranches(
  graph: FamilyGraph,
  ds: Dataset,
  t: Translate,
  nameOf: (indi: Individual) => string,
): Map<string, BranchInfo> {
  const map = new Map<string, BranchInfo>();
  for (const l of graph.lines) {
    const indi = ds.individuals.get(l.ancestorId);
    map.set(l.key, { label: indi ? nameOf(indi) : t("kin.wedge.unknown"), color: lineColor(l.index, "ancestors") });
  }
  map.set(SPOUSE_LINE, { label: t("network.line.spouse"), color: paletteColor(6) });
  if (graph.assocs.length) map.set(ASSOC_LINE, { label: t("network.line.assoc"), color: paletteColor(8) });
  return map;
}

/** The people around `rootId`, at most `limit` of them, none more than
 *  `maxGen` generations above or below where their walk started.
 *
 *  With `associations` (the file's index of them) a godparent or a witness is
 *  a link too: the walk steps over it — though never off the root's blood in
 *  that scope — so the families a parish register ties together stand on the
 *  chart as one, and each such tie between two people on it is listed in
 *  `assocs`. `kinds` keeps only the associations of those kinds. */
export function buildFamilyGraph(
  ds: Dataset,
  rootId: string,
  scope: GraphScope,
  limit: number,
  maxGen = Infinity,
  associations?: AssociationIndex,
  kinds?: ReadonlySet<AssocKind>,
): FamilyGraph {
  const ties = associations ? assocTies(ds, associations, kinds) : undefined;
  const index = new Map<string, number>();
  const nodes: GraphNode[] = [];
  const lines: GraphLine[] = [];
  const near: Near[] = [];
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
          gen: cur.gen,
          hops: cur.hops,
          tree,
          via: cur.via,
        });
      }
      const here = index.get(cur.id) ?? -1;
      neighbours(ds, indi, near, ties);
      for (const n of near) {
        if (seen.has(n.id) || index.has(n.id) && tree > 0 || blood && !blood.has(n.id)) continue;
        // Past the generation limit the walk stops: no one beyond it is drawn,
        // and no one is reached through them.
        if (Math.abs(cur.gen + n.dGen) > maxGen) continue;
        seen.add(n.id);
        let branch = cur.branch;
        let role: Step["role"] = "other";
        if (n.rel === "assoc") {
          // Their family follows them onto the chart, and is none of the
          // root's lines.
          if (tree === 0) branch = ASSOC_LINE;
        } else if (tree === 0) {
          if (cur.role === "root") role = n.rel === "parent" ? "parent" : n.rel === "partner" ? "spouse" : "other";
          else if (cur.role === "parent" && n.rel === "parent") {
            // A grandparent opens a line of their own, its colour by who they
            // are — the father's or the mother's, father or mother — so a missing
            // grandparent does not shift the others' colours.
            const side = parentSide.get(cur.id) ?? 0;
            const line = { key: n.id, ancestorId: n.id, index: side + (n.mother ? 1 : 0) };
            lines.push(line);
            branch = line.key;
          } else if (cur.role === "spouse" && n.rel === "parent") branch = SPOUSE_LINE;
        }
        queue.push({ id: n.id, gen: cur.gen + n.dGen, role, branch, hops: cur.hops + 1, via: here });
      }
    }
  };

  // Everyone in the trees walked so far, whether the walk drew them or the
  // generation limit cut them off: a person the limit cut off belongs to a
  // tree already on the chart and must not start a "new" one of their own.
  const covered = new Set<string>();
  const cover = (startId: string) => {
    if (maxGen === Infinity) return; // the walk itself drew every one of them
    const queue = [startId];
    covered.add(startId);
    for (let q = 0; q < queue.length; q++) {
      const indi = ds.individuals.get(queue[q]);
      if (!indi) continue;
      neighbours(ds, indi, near, ties);
      for (const n of near) {
        if (covered.has(n.id)) continue;
        covered.add(n.id);
        queue.push(n.id);
      }
    }
  };

  if (rootIndi) walk(rootId, trees++);
  if (scope === "file") {
    if (rootIndi) cover(rootId);
    for (const id of ds.individuals.keys()) {
      if (index.has(id) || covered.has(id)) continue;
      cover(id);
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
  const hubOf = new Map<string, number>();
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
      if (partners.length + children.length >= 2 && partners.length) {
        hubOf.set(famId, nodes.length + families.length);
        families.push({ partners, children });
      }
    }
  }
  const edges: GraphEdge[] = [];
  families.forEach((f, k) => {
    const hub = nodes.length + k;
    for (const p of f.partners) edges.push({ a: p, b: hub, kind: "partner" });
    for (const c of f.children) edges.push({ a: hub, b: c, kind: "child" });
  });
  // Each association between two on the chart, once: from the person whose
  // event it was, or from the couple's hub (a couple with no hub on the chart
  // has one partner on it at most, and the tie is that partner's).
  const assocs: GraphAssoc[] = [];
  if (ties) {
    const drawn = new Set<number>();
    const size = nodes.length + families.length;
    const add = (a: number | undefined, b: number, kind: AssocKind) => {
      if (a === undefined || a === b || drawn.has(a * size + b)) return;
      drawn.add(a * size + b);
      assocs.push({ a, b, kind });
    };
    for (const tie of ties.list) {
      const b = index.get(tie.toId);
      if (b === undefined) continue;
      if (!tie.family) add(index.get(tie.fromId), b, tie.kind);
      else if (hubOf.has(tie.fromId)) add(hubOf.get(tie.fromId), b, tie.kind);
      else {
        const fam = ds.families.get(tie.fromId);
        for (const p of [fam?.husband, fam?.wife]) if (p !== undefined) add(index.get(p), b, tie.kind);
      }
    }
  }
  return { nodes, families, edges, assocs, lines, total: Math.max(total, nodes.length), trees };
}
