import type { Association, Dataset } from "../gedcom/types";
import type { AssociationIndex } from "../gedcom/assoc";

/**
 * Relationship paths between the start person and a target individual: the actual
 * chain of people connecting them, for display as a "how are these two related"
 * graph. Two flavours:
 *
 *  - {@link shortestPath} walks any edge (parent/child/spouse), so it also
 *    connects in-laws and step relations. This is the default.
 *  - {@link bloodPath} only walks parent/child edges and meets at the closest
 *    common ancestor (the fork apex) — a pure blood relationship, consistent
 *    with the label from `kinship.ts`. Absent when the two share no ancestor.
 *  - {@link shortestPath} given the file's associations also steps from a
 *    person to their godparent or witness and back — the only connection two
 *    families of one parish often have. It is no kinship, and says so: such a
 *    step carries the association it stands for.
 */

/** Relation of a path step to the *previous* step. */
export type RelationEdge = "parent" | "child" | "spouse" | "assoc";

export interface PathStep {
  id: string;
  /** How this person relates to the previous step. Undefined on the first (start). */
  edge?: RelationEdge;
  /** On an `assoc` step: the association it stands for. */
  assoc?: AssocLink;
}

/** One end of an association, seen from the other. */
export interface AssocLink {
  /** The person at the far end. */
  id: string;
  /** True when they are the associate — the godparent, the witness — of the
   *  near end's event; false when the near end is theirs. */
  associate: boolean;
  assoc: Association;
}

/** Per person, the people an association ties them to, in either direction. */
export type AssocLinks = Map<string, AssocLink[]>;

/** The file's associations as path steps: each joins the associate and the
 *  person whose record or event names them — both partners, for a family's. */
export function assocLinks(ds: Dataset, index: AssociationIndex): AssocLinks {
  const links: AssocLinks = new Map();
  const add = (from: string, link: AssocLink) => {
    const list = links.get(from);
    if (list) list.push(link);
    else links.set(from, [link]);
  };
  for (const [toId, refs] of index) {
    if (!ds.individuals.has(toId)) continue; // a 5.5.1 pointer at a family
    for (const ref of refs) {
      const fam = ref.fromKind === "family" ? ds.families.get(ref.fromId) : undefined;
      for (const id of ref.fromKind === "family" ? [fam?.husband, fam?.wife] : [ref.fromId]) {
        if (id === undefined || id === toId || !ds.individuals.has(id)) continue;
        add(id, { id: toId, associate: true, assoc: ref.assoc });
        add(toId, { id, associate: false, assoc: ref.assoc });
      }
    }
  }
  return links;
}

export interface RelationshipPath {
  kind: "shortest" | "blood" | "assoc";
  /** Start person first, target last (inclusive). A length-1 path means self. */
  steps: PathStep[];
  /** Number of hops = steps.length - 1. */
  hops: number;
  /** Blood paths only: index of the common ancestor (the fork apex) in `steps`. */
  lcaIndex?: number;
}

/** Both available paths for the UI; either may be undefined. */
export interface RelationshipPaths {
  shortest?: RelationshipPath;
  blood?: RelationshipPath;
}

export function relationshipPaths(
  ds: Dataset,
  startId: string,
  targetId: string,
): RelationshipPaths {
  const shortest = shortestPath(ds, startId, targetId);
  const blood = bloodPath(ds, startId, targetId);
  // When the shortest path is already a pure blood path, don't offer it twice.
  return {
    shortest,
    blood: blood && !sameSteps(blood, shortest) ? blood : undefined,
  };
}

/** Shortest connection through parent/child/spouse edges (BFS) — and, given
 *  `assoc`, through the file's associations too: the path is then of the
 *  `assoc` kind when it takes one, and a family link wins a tie. */
export function shortestPath(
  ds: Dataset,
  startId: string,
  targetId: string,
  assoc?: AssocLinks,
): RelationshipPath | undefined {
  if (startId === targetId) return self(startId, "shortest");
  if (!ds.individuals.has(startId) || !ds.individuals.has(targetId)) return undefined;

  const prev = new Map<string, { from: string; edge: RelationEdge; assoc?: AssocLink }>();
  const seen = new Set([startId]);
  const queue = [startId];
  for (let h = 0; h < queue.length; h++) {
    const id = queue[h];
    if (id === targetId) break;
    for (const { id: next, edge } of neighbors(id, ds)) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, { from: id, edge });
      queue.push(next);
    }
    for (const link of assoc?.get(id) ?? []) {
      if (seen.has(link.id)) continue;
      seen.add(link.id);
      prev.set(link.id, { from: id, edge: "assoc", assoc: link });
      queue.push(link.id);
    }
  }
  if (!prev.has(targetId)) return undefined;

  const steps: PathStep[] = [];
  let cur = targetId;
  let tied = false;
  while (cur !== startId) {
    const p = prev.get(cur)!;
    steps.push(p.assoc ? { id: cur, edge: p.edge, assoc: p.assoc } : { id: cur, edge: p.edge });
    if (p.assoc) tied = true;
    cur = p.from;
  }
  steps.push({ id: startId });
  steps.reverse();
  return { kind: tied ? "assoc" : "shortest", steps, hops: steps.length - 1 };
}

/** Blood path: two ancestor chains meeting at the closest common ancestor. */
export function bloodPath(
  ds: Dataset,
  startId: string,
  targetId: string,
): RelationshipPath | undefined {
  if (startId === targetId) return { ...self(startId, "blood"), lcaIndex: 0 };
  if (!ds.individuals.has(startId) || !ds.individuals.has(targetId)) return undefined;

  const startAnc = ancestors(ds, startId);
  const targetAnc = ancestors(ds, targetId);

  let lca: string | undefined;
  let best = Infinity;
  for (const [id, { gen }] of startAnc) {
    const tg = targetAnc.get(id);
    if (tg && gen + tg.gen < best) {
      best = gen + tg.gen;
      lca = id;
    }
  }
  if (!lca) return undefined;

  // start → … → LCA (each step is a "parent" hop going up)
  const up = walkTo(startAnc, lca, startId); // [start, …, lca]
  const steps: PathStep[] = up.map((id, i) => ({ id, edge: i === 0 ? undefined : "parent" }));
  const lcaIndex = up.length - 1;

  // LCA → … → target (each step is a "child" hop going down); drop the LCA itself
  const down = walkTo(targetAnc, lca, targetId).slice(0, -1).reverse();
  for (const id of down) steps.push({ id, edge: "child" });

  return { kind: "blood", steps, hops: steps.length - 1, lcaIndex };
}

/** How many ways up to one common ancestor are followed from either person,
 *  and how many bloodlines are offered in all: a village that married its
 *  cousins for two centuries has more than anyone will read. */
const BLOOD_CHAINS = 6;
const BLOOD_PATHS = 12;

/**
 * Every distinct bloodline between start and target: one path per most-recent
 * common ancestor (MRCA) *and per way up to them*, so intermarriage /
 * double-cousin cases each surface as their own route — and so does a person
 * who descends from the same ancestor through both parents. The
 * common-ancestor *couple* (two spouses) is one bloodline, not two — paths
 * that differ only in which spouse is the apex are collapsed. Sorted
 * shortest-first, the first {@link BLOOD_PATHS} of them. Empty when they
 * share no ancestor.
 */
export function bloodPaths(
  ds: Dataset,
  startId: string,
  targetId: string,
): RelationshipPath[] {
  if (startId === targetId || !ds.individuals.has(startId) || !ds.individuals.has(targetId)) {
    return [];
  }

  const startAnc = ancestors(ds, startId);
  const targetAnc = ancestors(ds, targetId);
  const common = new Set<string>();
  for (const id of startAnc.keys()) if (targetAnc.has(id)) common.add(id);
  if (common.size === 0) return [];

  const paths: RelationshipPath[] = [];
  const seen = new Set<string>();
  for (const a of common) {
    // A way up counts only when no *closer* common ancestor already covers it:
    // an MRCA has no other common ancestor strictly between an endpoint and
    // itself. (That also keeps the two legs apart: a person on both would be
    // a common ancestor between them.)
    const ups = chainsTo(ds, startId, a, BLOOD_CHAINS).filter((c) => !interiorHasCommon(c, common)); // [start, …, a]
    if (!ups.length) continue;
    const downs = chainsTo(ds, targetId, a, BLOOD_CHAINS).filter((c) => !interiorHasCommon(c, common)); // [target, …, a]
    for (const up of ups) {
      for (const down of downs) {
        const steps: PathStep[] = up.map((id, i) => ({ id, edge: i === 0 ? undefined : "parent" }));
        const lcaIndex = up.length - 1;
        for (const id of down.slice(0, -1).reverse()) steps.push({ id, edge: "child" });

        // Collapse a common-ancestor couple: two MRCAs that are spouses produce
        // paths with identical legs differing only at the apex, so wildcard the apex.
        const key = steps.map((s, i) => (i === lcaIndex ? "*" : s.id)).join(">");
        if (seen.has(key)) continue;
        seen.add(key);
        paths.push({ kind: "blood", steps, hops: steps.length - 1, lcaIndex });
      }
    }
  }

  return paths.sort((a, b) => a.hops - b.hops).slice(0, BLOOD_PATHS);
}

/**
 * The routes that take exactly one association: the start's family up to a
 * person, that person's godparent or witness (or the one they stood as such
 * for), and on through the associate's family to the target — "my
 * grandfather's godfather was her uncle". One per association (a wedding's
 * witness is tied to both partners, and the nearer one is the route),
 * shortest first, at most `limit`. Unlike {@link shortestPath} with
 * associations, these are offered whether or not kinship joins the two more
 * closely: they answer what else ties them.
 */
export function assocPaths(
  ds: Dataset,
  startId: string,
  targetId: string,
  links: AssocLinks,
  limit = 5,
): RelationshipPath[] {
  if (startId === targetId || !links.size || !ds.individuals.has(startId) || !ds.individuals.has(targetId)) return [];
  const fromStart = familyReach(ds, startId);
  const fromTarget = familyReach(ds, targetId);

  const candidates: { near: string; link: AssocLink; hops: number }[] = [];
  for (const [near, s] of fromStart) {
    for (const link of links.get(near) ?? []) {
      const t = fromTarget.get(link.id);
      if (t) candidates.push({ near, link, hops: s.dist + 1 + t.dist });
    }
  }
  candidates.sort((a, b) => a.hops - b.hops);

  const paths: RelationshipPath[] = [];
  const seen = new Set<string>();
  const taken = new Set<Association>();
  for (const c of candidates) {
    if (paths.length >= limit) break;
    const key = `${c.near}>${c.link.id}`;
    // Godparent and witness to the same person: one route. A couple's
    // witness, reached over either partner: the nearer one's.
    if (seen.has(key) || taken.has(c.link.assoc)) continue;

    // start → … → near, as the walk from the start found it.
    const steps: PathStep[] = [];
    for (let cur = c.near; cur !== startId; ) {
      const p = fromStart.get(cur)!;
      steps.push({ id: cur, edge: p.edge });
      cur = p.from!;
    }
    steps.push({ id: startId });
    steps.reverse();
    steps.push({ id: c.link.id, edge: "assoc", assoc: c.link });
    // associate → … → target: the walk from the target, read backwards.
    for (let cur = c.link.id; cur !== targetId; ) {
      const p = fromTarget.get(cur)!;
      steps.push({ id: p.from!, edge: p.edge === "parent" ? "child" : p.edge === "child" ? "parent" : "spouse" });
      cur = p.from!;
    }
    // A route that passes anyone twice says nothing a shorter one does not.
    if (new Set(steps.map((s) => s.id)).size !== steps.length) continue;
    seen.add(key);
    taken.add(c.link.assoc);
    paths.push({ kind: "assoc", steps, hops: steps.length - 1 });
  }
  return paths;
}

/** Everyone a parent/child/spouse walk reaches from `startId`, each with the
 *  hops, the person they were reached from and their relation to that one. */
function familyReach(ds: Dataset, startId: string): Map<string, { dist: number; from?: string; edge?: RelationEdge }> {
  const reach = new Map<string, { dist: number; from?: string; edge?: RelationEdge }>([[startId, { dist: 0 }]]);
  const queue = [startId];
  for (let h = 0; h < queue.length; h++) {
    const id = queue[h];
    const dist = reach.get(id)!.dist + 1;
    for (const { id: next, edge } of neighbors(id, ds)) {
      if (reach.has(next)) continue;
      reach.set(next, { dist, from: id, edge });
      queue.push(next);
    }
  }
  return reach;
}

/** Up to `cap` parent chains `[fromId, …, ancestorId]`: every way the one
 *  descends from the other, the father's side first. */
function chainsTo(ds: Dataset, fromId: string, ancestorId: string, cap: number): string[][] {
  const parentsOf = (id: string): string[] => {
    const out: string[] = [];
    for (const famId of ds.individuals.get(id)?.childOf ?? []) {
      const fam = ds.families.get(famId);
      if (fam?.husband) out.push(fam.husband);
      if (fam?.wife) out.push(fam.wife);
    }
    return out;
  };
  // Who descends from the ancestor, learnt once per person while climbing — so
  // a branch that never gets there is not climbed again.
  const leads = new Map<string, boolean>();
  const reaches = (id: string): boolean => {
    if (id === ancestorId) return true;
    const known = leads.get(id);
    if (known !== undefined) return known;
    leads.set(id, false); // a person recorded as their own ancestor ends here
    const yes = parentsOf(id).some(reaches);
    leads.set(id, yes);
    return yes;
  };
  const chains: string[][] = [];
  const chain = [fromId];
  const climb = (id: string) => {
    if (chains.length >= cap) return;
    if (id === ancestorId) {
      chains.push([...chain]);
      return;
    }
    for (const p of parentsOf(id)) {
      if (chain.includes(p) || !reaches(p)) continue;
      chain.push(p);
      climb(p);
      chain.pop();
    }
  };
  if (reaches(fromId)) climb(fromId);
  return chains;
}

/**
 * The routes the relationship label names: every bloodline to the target, or —
 * for an in-law with no bloodline of their own — every bloodline to one of the
 * target's spouses plus that marriage, or the start person's marriage plus every
 * bloodline from that spouse (the spouse of a cousin, a wife's cousin). Matches
 * `kinship.ts`, which names an in-law by exactly one marriage off a blood line.
 * Sorted shortest-first; empty when no such route exists.
 */
export function labelPaths(
  ds: Dataset,
  startId: string,
  targetId: string,
): RelationshipPath[] {
  const direct = bloodPaths(ds, startId, targetId);
  if (direct.length > 0) return direct;
  const paths: RelationshipPath[] = [];
  for (const s of spouseIdsOf(ds, targetId)) {
    if (s === startId) continue;
    for (const p of bloodPaths(ds, startId, s)) {
      paths.push({ ...p, steps: [...p.steps, { id: targetId, edge: "spouse" }], hops: p.hops + 1 });
    }
  }
  for (const s of spouseIdsOf(ds, startId)) {
    if (s === targetId) continue;
    for (const p of bloodPaths(ds, s, targetId)) {
      const [first, ...rest] = p.steps;
      paths.push({
        ...p,
        steps: [{ id: startId }, { id: first.id, edge: "spouse" }, ...rest],
        hops: p.hops + 1,
        lcaIndex: p.lcaIndex! + 1,
      });
    }
  }
  return paths.sort((a, b) => a.hops - b.hops);
}

function spouseIdsOf(ds: Dataset, id: string): string[] {
  const out: string[] = [];
  for (const famId of ds.individuals.get(id)?.spouseOf ?? []) {
    const fam = ds.families.get(famId);
    const s = fam && (fam.husband === id ? fam.wife : fam.husband);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Which of start's two parental lines a blood relationship runs through. */
export type Lineage = "paternal" | "maternal" | "both";

/**
 * The blood lineage from the start person to the target: which of start's parents
 * the relationship climbs through to reach a common ancestor.
 *
 *  - `"paternal"` / `"maternal"` — reached only via start's father / mother.
 *  - `"both"` — reached via both (e.g. a full sibling shares both parents).
 *  - `undefined` — self, no blood relationship, or the target is a *descendant*
 *    of start (so there is no ancestral line to climb from start's side).
 *
 * Unlike {@link bloodPaths} this does not collapse the common-ancestor couple,
 * so a full sibling correctly resolves to `"both"` rather than one arbitrary side.
 */
export function bloodLineage(
  ds: Dataset,
  startId: string,
  targetId: string,
): Lineage | undefined {
  if (!ds.individuals.has(startId)) return undefined;
  return bloodLineageFrom(ds, startId, ancestors(ds, startId), targetId);
}

/**
 * A blood-lineage resolver fixed to one start person: the start-side ancestor
 * walk runs once up front, so resolving many targets (every node of a chart)
 * costs only each target's own walk. Same results as {@link bloodLineage}.
 */
export function makeBloodLineageResolver(
  ds: Dataset,
  startId: string,
): (targetId: string) => Lineage | undefined {
  if (!ds.individuals.has(startId)) return () => undefined;
  const startAnc = ancestors(ds, startId);
  return (targetId) => bloodLineageFrom(ds, startId, startAnc, targetId);
}

function bloodLineageFrom(
  ds: Dataset,
  startId: string,
  startAnc: Map<string, { gen: number; from?: string }>,
  targetId: string,
): Lineage | undefined {
  if (startId === targetId || !ds.individuals.has(targetId)) return undefined;

  const targetAnc = ancestors(ds, targetId);

  // Closest common ancestor(s), by total hops; ties (e.g. both parents) all count.
  let best = Infinity;
  for (const [id, h] of startAnc) {
    const tg = targetAnc.get(id);
    if (tg) best = Math.min(best, h.gen + tg.gen);
  }
  if (best === Infinity) return undefined;

  let paternal = false;
  let maternal = false;
  for (const [id, h] of startAnc) {
    const tg = targetAnc.get(id);
    if (!tg || h.gen + tg.gen !== best) continue;
    // start is the apex ⇒ target descends from start: no ancestral line to climb.
    if (h.gen === 0) continue;
    const parentId = walkTo(startAnc, id, startId)[1]; // start's parent toward this LCA
    const side = parentSideOf(ds, startId, parentId);
    if (side === "paternal") paternal = true;
    else if (side === "maternal") maternal = true;
  }

  if (paternal && maternal) return "both";
  if (paternal) return "paternal";
  if (maternal) return "maternal";
  return undefined;
}

/** Which parental side a parent of `childId` stands on: by sex when known, and
 *  otherwise by the parent's role in the child's family (HUSB = father's side)
 *  — so an unsexed parent still carries a lineage instead of dropping it. */
function parentSideOf(ds: Dataset, childId: string, parentId: string): "paternal" | "maternal" | undefined {
  const sex = ds.individuals.get(parentId)?.sex;
  if (sex === "M") return "paternal";
  if (sex === "F") return "maternal";
  for (const famId of ds.individuals.get(childId)?.childOf ?? []) {
    const fam = ds.families.get(famId);
    if (fam?.husband === parentId) return "paternal";
    if (fam?.wife === parentId) return "maternal";
  }
  return undefined;
}

/** Whether any node of `chain` other than its endpoints is a common ancestor. */
function interiorHasCommon(chain: string[], common: Set<string>): boolean {
  for (let i = 1; i < chain.length - 1; i++) if (common.has(chain[i])) return true;
  return false;
}

// ---------------------------------------------------------------------------

function self(id: string, kind: "shortest" | "blood"): RelationshipPath {
  return { kind, steps: [{ id }], hops: 0 };
}

/** Parents, spouses, and children of `id`, each tagged with the edge type. */
function* neighbors(id: string, ds: Dataset): Generator<{ id: string; edge: RelationEdge }> {
  const indi = ds.individuals.get(id);
  if (!indi) return;

  for (const famId of indi.childOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    if (fam.husband) yield { id: fam.husband, edge: "parent" };
    if (fam.wife) yield { id: fam.wife, edge: "parent" };
  }
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    const spouse = fam.husband === id ? fam.wife : fam.husband;
    if (spouse) yield { id: spouse, edge: "spouse" };
    for (const child of fam.children) yield { id: child, edge: "child" };
  }
}

/**
 * BFS upward through parents from `startId`. Each entry records the generation
 * above start and the descendant we reached it through (`from`, one step closer
 * to start), so a chain back to start can be reconstructed.
 */
function ancestors(ds: Dataset, startId: string): Map<string, { gen: number; from?: string }> {
  const map = new Map<string, { gen: number; from?: string }>();
  map.set(startId, { gen: 0 });
  const queue = [startId];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const gen = map.get(id)!.gen;
    const indi = ds.individuals.get(id);
    if (!indi) continue;
    for (const famId of indi.childOf) {
      const fam = ds.families.get(famId);
      if (!fam) continue;
      for (const pId of [fam.husband, fam.wife]) {
        if (pId && !map.has(pId)) {
          map.set(pId, { gen: gen + 1, from: id });
          queue.push(pId);
        }
      }
    }
  }
  return map;
}

/** Reconstruct [start, …, ancestorId] by following `from` pointers down. */
function walkTo(
  anc: Map<string, { gen: number; from?: string }>,
  ancestorId: string,
  startId: string,
): string[] {
  const chain = [ancestorId];
  let cur = ancestorId;
  while (cur !== startId) {
    cur = anc.get(cur)!.from!;
    chain.push(cur);
  }
  return chain.reverse();
}

function sameSteps(a: RelationshipPath, b: RelationshipPath | undefined): boolean {
  if (!b || a.steps.length !== b.steps.length) return false;
  return a.steps.every((s, i) => s.id === b.steps[i].id);
}
