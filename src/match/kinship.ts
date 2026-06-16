import type { Dataset } from "../gedcom/types";
import type { Translate } from "../locales/i18n";

/**
 * Human-readable kinship label between `homeId` and `targetId`.
 * Returns undefined when homeId === targetId, neither is found,
 * or the relationship is too distant to name.
 */
export function kinshipLabel(
  ds: Dataset,
  homeId: string,
  targetId: string,
  t: Translate,
): string | undefined {
  if (homeId === targetId) return t("kinship.home");

  const homeIndi = ds.individuals.get(homeId);
  const targetIndi = ds.individuals.get(targetId);
  if (!homeIndi || !targetIndi) return undefined;

  // Direct spouse
  for (const famId of homeIndi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    const spouseId = fam.husband === homeId ? fam.wife : fam.husband;
    if (spouseId === targetId) return t("kinship.spouse");
  }

  // Build ancestor-generation maps for both sides
  const homeAncs = ancestorGens(ds, homeId);
  const targetAncs = ancestorGens(ds, targetId);

  // Find the closest common ancestor (lowest total hops)
  let bestHG = Infinity, bestTG = Infinity;
  for (const [id, hg] of homeAncs) {
    const tg = targetAncs.get(id);
    if (tg !== undefined && hg + tg < bestHG + bestTG) {
      bestHG = hg;
      bestTG = tg;
    }
  }

  if (bestHG === Infinity) return undefined;
  return relLabel(bestHG, bestTG, targetIndi.sex ?? "U", t);
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
 * hg = hops from home to LCA; tg = hops from LCA down to target.
 */
function relLabel(hg: number, tg: number, sex: string, t: Translate): string | undefined {
  const f = sex === "F";

  // Direct ancestor (target is ancestor of home)
  if (hg > 0 && tg === 0) {
    if (hg === 1) return f ? t("kinship.mother") : t("kinship.father");
    if (hg === 2) return f ? t("kinship.grandmother") : t("kinship.grandfather");
    if (hg === 3) return f ? t("kinship.greatGrandmother") : t("kinship.greatGrandfather");
    return (f ? t("kinship.greatGrandmother") : t("kinship.greatGrandfather")) + ` ×${hg - 2}`;
  }

  // Direct descendant (target is descendant of home)
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

  // Great-uncle / Great-aunt (grandparent's sibling)
  if (hg === 3 && tg === 1) return f ? t("kinship.greatAunt") : t("kinship.greatUncle");
  // Grand-nephew / Grand-niece
  if (hg === 1 && tg === 3) return f ? t("kinship.grandNiece") : t("kinship.grandNephew");

  // Cousins
  if (hg >= 2 && tg >= 2) {
    const degree = Math.min(hg, tg) - 1; // 1st, 2nd, 3rd…
    const removed = Math.abs(hg - tg);
    const base =
      degree === 1 ? t("kinship.cousin1") :
      degree === 2 ? t("kinship.cousin2") :
      `${degree}. ${t("kinship.cousin")}`;
    return removed === 0 ? base : `${base} +${removed}`;
  }

  return undefined;
}
