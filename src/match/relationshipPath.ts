import type { Dataset } from "../gedcom/types";

/**
 * Relationship paths between the home person and a target individual: the actual
 * chain of people connecting them, for display as a "how are these two related"
 * graph. Two flavours:
 *
 *  - {@link shortestPath} walks any edge (parent/child/spouse), so it also
 *    connects in-laws and step relations. This is the default.
 *  - {@link bloodPath} only walks parent/child edges and meets at the closest
 *    common ancestor (the fork apex) — a pure blood relationship, consistent
 *    with the label from `kinship.ts`. Absent when the two share no ancestor.
 */

/** Relation of a path step to the *previous* step. */
export type RelationEdge = "parent" | "child" | "spouse";

export interface PathStep {
  id: string;
  /** How this person relates to the previous step. Undefined on the first (home). */
  edge?: RelationEdge;
}

export interface RelationshipPath {
  kind: "shortest" | "blood";
  /** Home person first, target last (inclusive). A length-1 path means self. */
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
  homeId: string,
  targetId: string,
): RelationshipPaths {
  const shortest = shortestPath(ds, homeId, targetId);
  const blood = bloodPath(ds, homeId, targetId);
  // When the shortest path is already a pure blood path, don't offer it twice.
  return {
    shortest,
    blood: blood && !sameSteps(blood, shortest) ? blood : undefined,
  };
}

/** Shortest connection through parent/child/spouse edges (BFS). */
export function shortestPath(
  ds: Dataset,
  homeId: string,
  targetId: string,
): RelationshipPath | undefined {
  if (homeId === targetId) return self(homeId, "shortest");
  if (!ds.individuals.has(homeId) || !ds.individuals.has(targetId)) return undefined;

  const prev = new Map<string, { from: string; edge: RelationEdge }>();
  const seen = new Set([homeId]);
  const queue = [homeId];
  for (let h = 0; h < queue.length; h++) {
    const id = queue[h];
    if (id === targetId) break;
    for (const { id: next, edge } of neighbors(id, ds)) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, { from: id, edge });
      queue.push(next);
    }
  }
  if (!prev.has(targetId)) return undefined;

  const steps: PathStep[] = [];
  let cur = targetId;
  while (cur !== homeId) {
    const p = prev.get(cur)!;
    steps.push({ id: cur, edge: p.edge });
    cur = p.from;
  }
  steps.push({ id: homeId });
  steps.reverse();
  return { kind: "shortest", steps, hops: steps.length - 1 };
}

/** Blood path: two ancestor chains meeting at the closest common ancestor. */
export function bloodPath(
  ds: Dataset,
  homeId: string,
  targetId: string,
): RelationshipPath | undefined {
  if (homeId === targetId) return { ...self(homeId, "blood"), lcaIndex: 0 };
  if (!ds.individuals.has(homeId) || !ds.individuals.has(targetId)) return undefined;

  const homeAnc = ancestors(ds, homeId);
  const targetAnc = ancestors(ds, targetId);

  let lca: string | undefined;
  let best = Infinity;
  for (const [id, { gen }] of homeAnc) {
    const tg = targetAnc.get(id);
    if (tg && gen + tg.gen < best) {
      best = gen + tg.gen;
      lca = id;
    }
  }
  if (!lca) return undefined;

  // home → … → LCA (each step is a "parent" hop going up)
  const up = walkTo(homeAnc, lca, homeId); // [home, …, lca]
  const steps: PathStep[] = up.map((id, i) => ({ id, edge: i === 0 ? undefined : "parent" }));
  const lcaIndex = up.length - 1;

  // LCA → … → target (each step is a "child" hop going down); drop the LCA itself
  const down = walkTo(targetAnc, lca, targetId).slice(0, -1).reverse();
  for (const id of down) steps.push({ id, edge: "child" });

  return { kind: "blood", steps, hops: steps.length - 1, lcaIndex };
}

/**
 * Every distinct bloodline between home and target: one path per most-recent
 * common ancestor (MRCA), so intermarriage / double-cousin cases each surface
 * as their own route. The common-ancestor *couple* (two spouses) is one
 * bloodline, not two — paths that differ only in which spouse is the apex are
 * collapsed. Sorted shortest-first. Empty when they share no ancestor.
 */
export function bloodPaths(
  ds: Dataset,
  homeId: string,
  targetId: string,
): RelationshipPath[] {
  if (homeId === targetId || !ds.individuals.has(homeId) || !ds.individuals.has(targetId)) {
    return [];
  }

  const homeAnc = ancestors(ds, homeId);
  const targetAnc = ancestors(ds, targetId);
  const common = new Set<string>();
  for (const id of homeAnc.keys()) if (targetAnc.has(id)) common.add(id);
  if (common.size === 0) return [];

  const paths: RelationshipPath[] = [];
  const seen = new Set<string>();
  for (const a of common) {
    const up = walkTo(homeAnc, a, homeId); // [home, …, a]
    const down = walkTo(targetAnc, a, targetId); // [target, …, a]
    // Skip A when a *closer* common ancestor already covers this line: an MRCA
    // has no other common ancestor strictly between an endpoint and itself.
    if (interiorHasCommon(up, common) || interiorHasCommon(down, common)) continue;

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

  return paths.sort((a, b) => a.hops - b.hops);
}

/** Which of home's two parental lines a blood relationship runs through. */
export type Lineage = "paternal" | "maternal" | "both";

/**
 * The blood lineage from the home person to the target: which of home's parents
 * the relationship climbs through to reach a common ancestor.
 *
 *  - `"paternal"` / `"maternal"` — reached only via home's father / mother.
 *  - `"both"` — reached via both (e.g. a full sibling shares both parents).
 *  - `undefined` — self, no blood relationship, or the target is a *descendant*
 *    of home (so there is no ancestral line to climb from home's side).
 *
 * Unlike {@link bloodPaths} this does not collapse the common-ancestor couple,
 * so a full sibling correctly resolves to `"both"` rather than one arbitrary side.
 */
export function bloodLineage(
  ds: Dataset,
  homeId: string,
  targetId: string,
): Lineage | undefined {
  if (homeId === targetId) return undefined;
  if (!ds.individuals.has(homeId) || !ds.individuals.has(targetId)) return undefined;

  const homeAnc = ancestors(ds, homeId);
  const targetAnc = ancestors(ds, targetId);

  // Closest common ancestor(s), by total hops; ties (e.g. both parents) all count.
  let best = Infinity;
  for (const [id, h] of homeAnc) {
    const tg = targetAnc.get(id);
    if (tg) best = Math.min(best, h.gen + tg.gen);
  }
  if (best === Infinity) return undefined;

  let paternal = false;
  let maternal = false;
  for (const [id, h] of homeAnc) {
    const tg = targetAnc.get(id);
    if (!tg || h.gen + tg.gen !== best) continue;
    // home is the apex ⇒ target descends from home: no ancestral line to climb.
    if (h.gen === 0) continue;
    const parentId = walkTo(homeAnc, id, homeId)[1]; // home's parent toward this LCA
    const sex = ds.individuals.get(parentId)?.sex;
    if (sex === "M") paternal = true;
    else if (sex === "F") maternal = true;
  }

  if (paternal && maternal) return "both";
  if (paternal) return "paternal";
  if (maternal) return "maternal";
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
