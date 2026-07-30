import type { Dataset } from "../gedcom/types";
import type { Translate } from "../locales/i18n";
import { bloodLineage, makeBloodLineageResolver, type Lineage } from "./relationshipPath";

export type { Lineage };

/**
 * Human-readable kinship label between `startId` and `targetId`.
 * Returns undefined when startId === targetId, neither is found,
 * or the relationship is too distant to name.
 */
export function kinshipLabel(
  ds: Dataset,
  startId: string,
  targetId: string,
  t: Translate,
): string | undefined {
  return kinshipLabelFrom(ds, startId, ancestorGens(ds, startId), targetId, t);
}

/**
 * A kinship resolver fixed to one start person, for chart renderers that label
 * every node: the start-side ancestor walk runs once, and each target's label +
 * lineage is computed once and then served from a cache — instead of two full
 * pedigree walks per node per render. Same results as {@link kinshipLabel} /
 * {@link bloodLineage}.
 */
export interface KinshipResolver {
  label: (targetId: string) => string | undefined;
  lineage: (targetId: string) => Lineage | undefined;
}

export function createKinshipResolver(ds: Dataset, startId: string, t: Translate): KinshipResolver {
  const startAncs = ancestorGens(ds, startId);
  const lineageOf = makeBloodLineageResolver(ds, startId);
  const cache = new Map<string, { label?: string; lineage?: Lineage }>();
  const resolve = (targetId: string) => {
    let hit = cache.get(targetId);
    if (!hit) {
      hit = {
        label: kinshipLabelFrom(ds, startId, startAncs, targetId, t),
        lineage: lineageOf(targetId),
      };
      cache.set(targetId, hit);
    }
    return hit;
  };
  return {
    label: (targetId) => resolve(targetId).label,
    lineage: (targetId) => resolve(targetId).lineage,
  };
}

function kinshipLabelFrom(
  ds: Dataset,
  startId: string,
  startAncs: Map<string, number>,
  targetId: string,
  t: Translate,
): string | undefined {
  if (startId === targetId) return t("kinship.start");

  const startIndi = ds.individuals.get(startId);
  const targetIndi = ds.individuals.get(targetId);
  if (!startIndi || !targetIndi) return undefined;

  // Direct spouse
  for (const famId of startIndi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    const spouseId = fam.husband === startId ? fam.wife : fam.husband;
    if (spouseId === targetId) return t("kinship.spouse");
  }

  // The target-side ancestor-generation map (the start side is precomputed).
  const targetAncs = ancestorGens(ds, targetId);

  // Find the closest common ancestor (lowest total hops)
  let bestHG = Infinity, bestTG = Infinity;
  for (const [id, hg] of startAncs) {
    const tg = targetAncs.get(id);
    if (tg !== undefined && hg + tg < bestHG + bestTG) {
      bestHG = hg;
      bestTG = tg;
    }
  }

  // No blood line at all — the relationship may still be a step one (a parent's
  // spouse, a spouse's child, or a step-parent's child from another union).
  if (bestHG === Infinity) return stepLabel(ds, startId, targetId, targetIndi.sex ?? "U", t);

  // Siblings sharing exactly one parent are half-siblings.
  if (bestHG === 1 && bestTG === 1 && sharedParentCount(ds, startId, targetId) === 1) {
    return targetIndi.sex === "F" ? t("kinship.halfSister") : t("kinship.halfBrother");
  }

  return relLabel(bestHG, bestTG, targetIndi.sex ?? "U", t);
}

/** The person's parent ids, across every family they are a child of. */
function parentIds(ds: Dataset, id: string): string[] {
  const out: string[] = [];
  const indi = ds.individuals.get(id);
  for (const famId of indi?.childOf ?? []) {
    const fam = ds.families.get(famId);
    for (const p of [fam?.husband, fam?.wife]) if (p) out.push(p);
  }
  return out;
}

/** The person's spouse/partner ids, across every family they are a spouse in. */
function spouseIds(ds: Dataset, id: string): string[] {
  const out: string[] = [];
  const indi = ds.individuals.get(id);
  for (const famId of indi?.spouseOf ?? []) {
    const fam = ds.families.get(famId);
    const s = fam?.husband === id ? fam?.wife : fam?.husband;
    if (s) out.push(s);
  }
  return out;
}

/** How many parents the two share (1 = half-siblings, 2 = full). */
function sharedParentCount(ds: Dataset, aId: string, bId: string): number {
  const a = new Set(parentIds(ds, aId));
  return new Set(parentIds(ds, bId).filter((p) => a.has(p))).size;
}

/**
 * Step relations, tried only when no common ancestor connects the two:
 * a parent's spouse (step-parent), a spouse's child (step-child), or a
 * step-parent's child from another union (step-sibling).
 */
function stepLabel(
  ds: Dataset,
  startId: string,
  targetId: string,
  sex: string,
  t: Translate,
): string | undefined {
  const f = sex === "F";
  const startParents = parentIds(ds, startId);
  const targetParents = parentIds(ds, targetId);

  if (spouseIds(ds, targetId).some((id) => startParents.includes(id))) {
    return f ? t("kinship.stepMother") : t("kinship.stepFather");
  }
  if (spouseIds(ds, startId).some((id) => targetParents.includes(id))) {
    return f ? t("kinship.stepDaughter") : t("kinship.stepSon");
  }
  for (const p of startParents) {
    if (spouseIds(ds, p).some((id) => targetParents.includes(id))) {
      return f ? t("kinship.stepSister") : t("kinship.stepBrother");
    }
  }
  return undefined;
}

/**
 * Kinship for display: the human-readable label, the blood {@link Lineage} (for
 * colour-coding and the tooltip), and a `bloodOnly` flag set when no specific
 * kinship could be named but the two are still blood-related — in which case
 * `label` is a generic "blood relative" term and the lineage carries the detail.
 * Returns undefined when there is no relationship at all (or self with no label).
 */
export interface KinshipInfo {
  label: string;
  lineage?: Lineage;
  bloodOnly: boolean;
}

export function kinshipInfo(
  ds: Dataset,
  startId: string,
  targetId: string,
  t: Translate,
): KinshipInfo | undefined {
  const label = kinshipLabel(ds, startId, targetId, t);
  const lineage = bloodLineage(ds, startId, targetId);
  if (label) return { label, lineage, bloodOnly: false };
  // No nameable kinship, but a blood line still connects them — surface that.
  if (lineage) return { label: t("kinship.bloodline"), lineage, bloodOnly: true };
  return undefined;
}

/** CSS modifier class colouring a kinship label by lineage: paternal blue,
 *  maternal purple, both-lines green (none when unrelated by blood). */
export function lineageClass(lineage?: Lineage): string {
  return lineage ? `lineage-${lineage}` : "";
}

/** Full kinship tooltip: the base "<rel> of <start>" plus a lineage line when known. */
export function kinshipTooltip(info: KinshipInfo, startName: string, t: Translate): string {
  const base = info.bloodOnly
    ? t("kinship.bloodlineTooltip", { name: startName })
    : t("kinship.tooltip", { kinship: info.label, name: startName });
  return info.lineage ? `${base} — ${t(`kinship.lineage.${info.lineage}`)}` : base;
}

/** BFS upward through parents, returns Map<personId, generationsAbove>. */
function ancestorGens(ds: Dataset, startId: string): Map<string, number> {
  const map = new Map<string, number>();
  map.set(startId, 0);
  const queue: [string, number][] = [[startId, 0]];
  for (let i = 0; i < queue.length; i++) {
    const [id, gen] = queue[i];
    const indi = ds.individuals.get(id);
    if (!indi) continue;
    for (const famId of indi.childOf) {
      const fam = ds.families.get(famId);
      if (!fam) continue;
      for (const pId of [fam.husband, fam.wife]) {
        if (pId && !map.has(pId)) {
          map.set(pId, gen + 1);
          queue.push([pId, gen + 1]);
        }
      }
    }
  }
  return map;
}

/**
 * Maps generation distances to a kinship label.
 * hg = hops from start to LCA; tg = hops from LCA down to target.
 */
function relLabel(hg: number, tg: number, sex: string, t: Translate): string | undefined {
  const f = sex === "F";

  // Direct ancestor (target is ancestor of start)
  if (hg > 0 && tg === 0) {
    if (hg === 1) return f ? t("kinship.mother") : t("kinship.father");
    if (hg === 2) return f ? t("kinship.grandmother") : t("kinship.grandfather");
    if (hg === 3) return f ? t("kinship.greatGrandmother") : t("kinship.greatGrandfather");
    return (f ? t("kinship.greatGrandmother") : t("kinship.greatGrandfather")) + ` ×${hg - 2}`;
  }

  // Direct descendant (target is descendant of start)
  if (hg === 0 && tg > 0) {
    if (tg === 1) return f ? t("kinship.daughter") : t("kinship.son");
    if (tg === 2) return f ? t("kinship.granddaughter") : t("kinship.grandson");
    if (tg === 3) return f ? t("kinship.greatGranddaughter") : t("kinship.greatGrandson");
    return (f ? t("kinship.greatGranddaughter") : t("kinship.greatGrandson")) + ` ×${tg - 2}`;
  }

  // Sibling
  if (hg === 1 && tg === 1) return f ? t("kinship.sister") : t("kinship.brother");

  // Uncle / Aunt
  if (hg === 2 && tg === 1) return f ? t("kinship.aunt") : t("kinship.uncle");
  // Nephew / Niece
  if (hg === 1 && tg === 2) return f ? t("kinship.niece") : t("kinship.nephew");

  // Great-uncle / Great-aunt and beyond (grandparent's sibling, then ×N)
  if (hg >= 3 && tg === 1) {
    const base = f ? t("kinship.greatAunt") : t("kinship.greatUncle");
    return hg === 3 ? base : base + ` ×${hg - 2}`;
  }
  // Grand-nephew / Grand-niece and beyond
  if (hg === 1 && tg >= 3) {
    const base = f ? t("kinship.grandNiece") : t("kinship.grandNephew");
    return tg === 3 ? base : base + ` ×${tg - 2}`;
  }

  // Cousins
  if (hg >= 2 && tg >= 2) {
    const degree = Math.min(hg, tg) - 1; // 1st, 2nd, 3rd…
    const removed = Math.abs(hg - tg);
    const sx = f ? "F" : "M";
    const base =
      degree === 1 ? t(`kinship.cousin1_${sx}`) :
      degree === 2 ? t(`kinship.cousin2_${sx}`) :
      `${degree}. ${t(`kinship.cousin_${sx}`)}`;
    return removed === 0 ? base : `${base} +${removed}`;
  }

  return undefined;
}
