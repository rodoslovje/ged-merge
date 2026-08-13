import type { Dataset } from "../gedcom/types";
import { individualFieldRows } from "../review/fields";
import { DEFAULT_CONFIG } from "../match/types";
import type { Translate } from "../locales/i18n";
import type { RecordPatch } from "../ui/historyTypes";
import { makeDuplicatePair, relationshipCount } from "./duplicates";
import {
  mergeDuplicateChain,
  relatedMergeOrder,
  relatedSeparateRecords,
  type DuplicateMergeStep,
  type RelatedSeparateRecord,
} from "./mergeDuplicate";

/**
 * Collapse a whole duplicate cluster — one person entered N times — into a
 * single record, in one undoable step.
 *
 * This module is a **planner only**: it decides who survives, in what order the
 * records are absorbed, and which relatives are collapsed alongside. Every
 * actual mutation goes through {@link mergeDuplicateChain}, i.e. exactly the
 * pairwise merge the panel's own Merge button runs — so a cluster merge cannot
 * behave differently from doing the same merges by hand (pinned by the
 * equivalence test in `mergeCluster.test.ts`).
 *
 * Steps carry no field choices. An empty `fields` map makes `applyRows` fall
 * back to `defaultChoice` per row — the one-sided value is taken, the more
 * precise date wins, a conflict keeps the survivor — evaluated against the
 * dataset *as it is when that step runs*. Pre-computing choices for all N−1
 * steps up front would key them to `fam.<id>` rows that earlier steps have
 * already folded away.
 */

/**
 * Score floor for the child pairs offered alongside a merge. Unlike parents and
 * partners (structural: one father, one spouse per family), children are paired
 * by name similarity across two sibling sets, so a weak pair is more likely to
 * be two different people who share a name than one person twice.
 */
export const RELATED_CHILD_MIN_SCORE = DEFAULT_CONFIG.probableThreshold * 100;

/**
 * A relative of the cluster's person who is itself entered several times — the
 * six "Franc Stopar" records sitting opposite eight copies of his wife. Offered
 * as one tick, and collapsed by the same planner into its own survivor.
 */
export interface ClusterRelativeGroup {
  /** Stable tick key: the group's member ids, sorted, joined. */
  key: string;
  /** Every record of this relative, sorted. */
  memberIds: string[];
  /** Display name for the tick row. */
  label: string;
  /** The relation that surfaced the group, for the wording. */
  relation: RelatedSeparateRecord["relation"];
  /** Where this group merges relative to the cluster's own chain — parents and
   *  partners before it, children after; see {@link relatedMergeOrder}. */
  when: "before" | "after";
  /** The group's *weakest* link (0–100): it is only as certain as the least
   *  convincing pair holding it together. */
  score: number;
}

/**
 * Which record of a cluster survives: the one with the most linked relatives,
 * so the merges re-point as few relationships as possible — the same rule that
 * orients a single pair in `findDuplicates`. Ties break on the fuller record,
 * then on the id, so the choice never depends on iteration order.
 */
export function pickClusterSurvivor(dataset: Dataset, memberIds: string[]): string | undefined {
  const scored = memberIds
    .map((id) => {
      const indi = dataset.individuals.get(id);
      return indi
        ? { id, rel: relationshipCount(indi, dataset), lines: indi.raw.children.length }
        : undefined;
    })
    .filter((x): x is { id: string; rel: number; lines: number } => !!x);
  scored.sort((a, b) => b.rel - a.rel || b.lines - a.lines || (a.id < b.id ? -1 : 1));
  return scored[0]?.id;
}

/**
 * The relatives that are a separate record on each side, aggregated across the
 * whole cluster instead of one pair.
 *
 * Each member is compared against the survivor exactly as the pairwise panel
 * does, and the resulting links are unioned: if the survivor's "Franc" differs
 * from member B's *and* from member C's, all three Franc records land in one
 * group with one tick. Nothing is merged unless the caller passes the group
 * back to {@link mergeCluster} — every group starts unticked, because merging
 * someone is the user's call, never a side effect of another merge.
 *
 * Note the derivation is the panel's own, not the duplicate scan's: parents and
 * partners align **by role** (one father, one spouse per family), which is what
 * catches the pair the scan itself vetoes — "Štefanija" against "Štefka" reads
 * as two different given names, yet a person has one mother. Children have no
 * such structural anchor, so they keep the {@link RELATED_CHILD_MIN_SCORE}
 * gate, and every group carries its weakest score for the user to judge.
 */
export function clusterRelativeGroups(
  dataset: Dataset,
  survivorId: string,
  memberIds: string[],
  t: Translate,
): ClusterRelativeGroup[] {
  const survivor = dataset.individuals.get(survivorId);
  if (!survivor) return [];

  const links: RelatedSeparateRecord[] = [];
  for (const id of memberIds) {
    if (id === survivorId) continue;
    const member = dataset.individuals.get(id);
    if (!member) continue;
    links.push(...relatedSeparateRecords(individualFieldRows(t, survivor, member, dataset, dataset)));
  }
  if (links.length === 0) return [];

  // Union the links: two records of the same relative reached from different
  // members belong to one group, one tick.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const l of links) {
    const ra = find(l.aId);
    const rb = find(l.bId);
    if (ra !== rb) parent.set(ra, rb);
  }

  const groups = new Map<string, { ids: Set<string>; links: RelatedSeparateRecord[] }>();
  for (const l of links) {
    const root = find(l.aId);
    let g = groups.get(root);
    if (!g) groups.set(root, (g = { ids: new Set(), links: [] }));
    g.ids.add(l.aId);
    g.ids.add(l.bId);
    g.links.push(l);
  }

  const out: ClusterRelativeGroup[] = [];
  for (const g of groups.values()) {
    const ids = [...g.ids].sort();
    // A group reached as a child from one member and as a partner from another
    // is a partner group: only an all-child group merges after the chain.
    const childOnly = g.links.every((l) => l.relation === "child");
    const relation = childOnly ? "child" : (g.links.find((l) => l.relation !== "child") ?? g.links[0]).relation;
    const score = groupScore(dataset, g.links);
    if (childOnly && score < RELATED_CHILD_MIN_SCORE) continue;
    out.push({
      key: ids.join("|"),
      memberIds: ids,
      label: g.links.find((l) => l.label)?.label ?? "?",
      relation,
      when: relatedMergeOrder(relation),
      score,
    });
  }
  // Strongest first inside each section, so the confident ticks lead.
  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return out;
}

/** A group is only as certain as its weakest link — the pair the user is least
 *  likely to accept is the one that decides whether to tick it at all. */
function groupScore(dataset: Dataset, links: RelatedSeparateRecord[]): number {
  let min = 100;
  for (const l of links) {
    const pair = makeDuplicatePair(dataset, l.aId, l.bId);
    min = Math.min(min, pair?.score ?? 0);
  }
  return min;
}

/**
 * The merge steps a cluster collapse runs, in order:
 *
 *  1. **ticked parent/partner groups** — it is their separate records that keep
 *     the families apart, so folding them first means the chain below finds one
 *     set of parents and one marriage instead of having to drop links;
 *  2. the cluster's own records, richest first, each absorbed into the survivor;
 *  3. **ticked child groups** — they merge cleanly only once their parents are
 *     one couple, which step 2 has just arranged.
 *
 * Exported for the tests and the confirmation preview: the dialog says exactly
 * what will run.
 */
export function clusterMergeSteps(
  dataset: Dataset,
  survivorId: string,
  memberIds: string[],
  groups: ClusterRelativeGroup[],
): DuplicateMergeStep[] {
  const decision = { status: "confirmed" as const, fields: {} };
  const groupSteps = (when: "before" | "after"): DuplicateMergeStep[] =>
    groups
      .filter((g) => g.when === when)
      .flatMap((g) => {
        const keep = pickClusterSurvivor(dataset, g.memberIds);
        if (!keep) return [];
        return absorbOrder(dataset, keep, g.memberIds).map((removedId) => ({
          survivorId: keep,
          removedId,
          decision,
        }));
      });

  return [
    ...groupSteps("before"),
    ...absorbOrder(dataset, survivorId, memberIds).map((removedId) => ({
      survivorId,
      removedId,
      decision,
    })),
    ...groupSteps("after"),
  ];
}

/** The order the survivor absorbs the rest: richest record first, so whatever a
 *  later step has to choose between is already the fuller side. Deterministic —
 *  the same cluster always merges the same way. */
function absorbOrder(dataset: Dataset, survivorId: string, memberIds: string[]): string[] {
  return memberIds
    .filter((id) => id !== survivorId && dataset.individuals.has(id))
    .sort((a, b) => {
      const ia = dataset.individuals.get(a)!;
      const ib = dataset.individuals.get(b)!;
      return (
        relationshipCount(ib, dataset) - relationshipCount(ia, dataset) ||
        ib.raw.children.length - ia.raw.children.length ||
        (a < b ? -1 : 1)
      );
    });
}

/**
 * Collapse the cluster (and the ticked relative groups) into one record each,
 * as a single undoable action. Returns the composed patches, or an empty array
 * if there was nothing to do.
 */
export function mergeCluster(
  dataset: Dataset,
  survivorId: string,
  memberIds: string[],
  groups: ClusterRelativeGroup[],
  t: Translate,
): RecordPatch[] {
  const steps = clusterMergeSteps(dataset, survivorId, memberIds, groups);
  if (steps.length === 0) return [];
  return mergeDuplicateChain(dataset, steps, t);
}

/** Every record a cluster merge removes — the panel drops their pairs from the
 *  list, and the app follows anything pointing at them to the survivor. */
export function clusterRemovedIds(steps: DuplicateMergeStep[]): string[] {
  return [...new Set(steps.map((s) => s.removedId))];
}
