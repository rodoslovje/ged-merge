import { createContext, useContext, useMemo } from "react";
import type { Dataset, Family, Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { familyEventsPreview, personCardPreview } from "../../merge/recordPreview";
import { familyMergeKeyBases, individualFieldRows } from "../../review/fields";
import { confirmedPeople, findConfirmedDecision, pendingFieldChoices, type CandidateDecision, type FieldChoice } from "../../review/types";

/** Relatives and families as Edit's cards and summaries show them after the
 *  save merges a confirmed match — see {@link personCardPreview} and
 *  {@link familyEventsPreview}. Records without one come back unchanged. */
export interface CardMergePreview {
  person: (individual: Individual) => Individual;
  family: (family: Family) => Family;
}

/** Provided by Edit; undefined (no incoming file) leaves everything as recorded. */
export const CardMergePreviewContext = createContext<CardMergePreview | undefined>(undefined);

export function useCardMergePreviewOf(): CardMergePreview | undefined {
  return useContext(CardMergePreviewContext);
}

/** What one confirmed person's merge writes: their incoming record and the
 *  choice of every row it writes (their families' rows included). */
interface Confirmed {
  incoming: Individual;
  pending: Map<string, FieldChoice>;
  /** main family id → its `fam.<id>` row-key base, built on first ask. */
  famKeys?: Map<string, string>;
}

/**
 * The {@link CardMergePreview} for Edit. Lazy and cached per record object:
 * only what is on screen pays for a comparison, and only for people whose
 * match is confirmed; an edit rebuilds the record, so the cache never shows a
 * stale one.
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
    let confirmedPairs: Map<string, string> | undefined;
    const analyses = new WeakMap<Individual, Confirmed | null>();
    const analyse = (individual: Individual): Confirmed | undefined => {
      if (statusById.get(individual.id) !== "confirmed") return undefined;
      const hit = analyses.get(individual);
      if (hit !== undefined) return hit ?? undefined;
      let out: Confirmed | null = null;
      const found = findConfirmedDecision(decisions, individual.id, (id) => compareDataset.individuals.get(id));
      const incoming = found && compareDataset.individuals.get(found.compareId);
      if (found && incoming) {
        confirmedPairs ??= confirmedPeople(decisions);
        const rejected = found.decision.rejectedEvents?.length ? new Set(found.decision.rejectedEvents) : undefined;
        const rows = individualFieldRows(t, individual, incoming, dataset, compareDataset, undefined, rejected, false, confirmedPairs);
        out = { incoming, pending: pendingFieldChoices(rows, found.decision) };
      }
      analyses.set(individual, out);
      return out ?? undefined;
    };

    const people = new WeakMap<Individual, Individual>();
    const person = (individual: Individual) => {
      const hit = people.get(individual);
      if (hit) return hit;
      const a = analyse(individual);
      const out = a ? personCardPreview(individual, a.incoming, (key) => a.pending.get(key)) : individual;
      people.set(individual, out);
      return out;
    };

    const families = new WeakMap<Family, Family>();
    const family = (fam: Family) => {
      const hit = families.get(fam);
      if (hit) return hit;
      let out = fam;
      // Either spouse's confirmed match writes the family's rows; the first
      // one that pairs this family with an incoming one speaks for it.
      for (const id of [fam.husband, fam.wife]) {
        const spouse = id ? dataset.individuals.get(id) : undefined;
        const a = spouse && analyse(spouse);
        if (!spouse || !a) continue;
        a.famKeys ??= familyMergeKeyBases(spouse, a.incoming, dataset, compareDataset, (m, i) => confirmedPairs?.get(i) === m);
        const famKey = a.famKeys.get(fam.id);
        const incFam = famKey && compareDataset.families.get(famKey.slice("fam.".length));
        if (!famKey || !incFam) continue;
        out = familyEventsPreview(fam, incFam, (key) => a.pending.get(`${famKey}.${key}`));
        break;
      }
      families.set(fam, out);
      return out;
    };
    return { person, family };
  }, [dataset, compareDataset, decisions, statusById, t]);
}
