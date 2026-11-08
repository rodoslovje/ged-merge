import { createContext, useContext, useMemo } from "react";
import type { Dataset, Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { personCardPreview } from "../../merge/recordPreview";
import { individualFieldRows } from "../../review/fields";
import { confirmedPeople, findConfirmedDecision, pendingFieldChoices, type CandidateDecision } from "../../review/types";

/** A relative as their card shows them after the save merges their confirmed
 *  match — see {@link personCardPreview}. */
export type CardMergePreview = (individual: Individual) => Individual;

/** Provided by Edit; undefined (no incoming file) leaves cards as recorded. */
export const CardMergePreviewContext = createContext<CardMergePreview | undefined>(undefined);

export function useCardMergePreviewOf(): CardMergePreview | undefined {
  return useContext(CardMergePreviewContext);
}

/**
 * The {@link CardMergePreview} for Edit's relative cards. Lazy and cached per
 * record object: only the cards on screen pay for a comparison, and only for
 * people whose match is confirmed; an edit rebuilds the record, so the cache
 * never shows a stale one.
 */
export function useCardMergePreview(
  dataset: Dataset,
  compareDataset: Dataset | undefined,
  decisions: Map<string, CandidateDecision> | undefined,
  statusById: ReadonlyMap<string, string>,
  t: Translate,
): CardMergePreview | undefined {
  return useMemo(() => {
    if (!decisions || !compareDataset) return undefined;
    let confirmed: Map<string, string> | undefined;
    const cache = new WeakMap<Individual, Individual>();
    return (individual: Individual) => {
      if (statusById.get(individual.id) !== "confirmed") return individual;
      const hit = cache.get(individual);
      if (hit) return hit;
      let out = individual;
      const found = findConfirmedDecision(decisions, individual.id, (id) => compareDataset.individuals.get(id));
      const incoming = found && compareDataset.individuals.get(found.compareId);
      if (found && incoming) {
        confirmed ??= confirmedPeople(decisions);
        const rejected = found.decision.rejectedEvents?.length ? new Set(found.decision.rejectedEvents) : undefined;
        const rows = individualFieldRows(t, individual, incoming, dataset, compareDataset, undefined, rejected, false, confirmed);
        const pending = pendingFieldChoices(rows, found.decision);
        out = personCardPreview(individual, incoming, (key) => pending.get(key));
      }
      cache.set(individual, out);
      return out;
    };
  }, [dataset, compareDataset, decisions, statusById, t]);
}
