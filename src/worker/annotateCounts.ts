import { buildMatchMaps, countImportableRelatives, importableMemo, type ImportableMemo, type MatchMaps, type TreeMode } from "../chart/personTree";
import type { Dataset } from "../gedcom/types";
import { listedCandidate, type MatchCandidate, type MatchResult } from "../match/types";
import { applyPlaceOverrides, type FormatOverrides } from "../normalize/formatOverrides";
import { inferPlaceExportFormat } from "../normalize/profile";
import type { PlaceTargetFormat } from "../normalize/types";
import { fieldDiffCounts, individualFieldRows } from "../review/fields";

/** Field labels are irrelevant to the counts computed here, so use a no-op
 *  translator (the worker has no i18n context). */
const rawLabel = (key: string) => key;

/** What the results table counts for one candidate. */
export type CandidateCounts = Required<Pick<MatchCandidate, "newCount" | "diffCount" | "linkCount" | "ancestorCount" | "descendantCount">>;

/** What every candidate of one list is counted with. */
export interface CountContext {
  main: Dataset;
  compare: Dataset;
  maps: MatchMaps;
  /** The same format the review rows and the merge use (mergePlaceFormat):
   *  counted without the overrides, a diff badge could disagree with the rows
   *  the panel actually shows. */
  placeFmt: PlaceTargetFormat;
  /** One memo for the whole list: candidates share their relatives' lines. */
  memo: ImportableMemo;
  /** What the main thread knows and the worker does not — the decisions, as
   *  the review rows and the compare tree read them. */
  confirmed?: ReadonlyMap<string, string>;
  isRejected?: (mainId: string, compareId: string) => boolean;
}

/** The "new", "links" and "differing" field counts of one pair. */
export function fieldCounts(c: MatchCandidate, ctx: CountContext): Pick<CandidateCounts, "newCount" | "diffCount" | "linkCount"> {
  const { main, compare } = ctx;
  return fieldDiffCounts(
    individualFieldRows(rawLabel, main.individuals.get(c.mainId), compare.individuals.get(c.compareId), main, compare, ctx.placeFmt, undefined, false, ctx.confirmed),
  );
}

/** The incoming-only people one pair would bring in, above or below it. */
export function importCount(c: MatchCandidate, ctx: CountContext, mode: TreeMode): number {
  const { main, compare } = ctx;
  return countImportableRelatives(main.individuals.get(c.mainId), compare.individuals.get(c.compareId), main, compare, ctx.maps, mode, ctx.memo, ctx.isRejected);
}

/** Attach per-candidate "new" and "differing" field counts plus the importable
 *  ancestor/descendant counts for the results table — to the list entries,
 *  without the score breakdowns (see `MatchCandidate`). */
export function annotateCounts(
  result: MatchResult,
  main: Dataset,
  compare: Dataset,
  overrides: FormatOverrides | undefined,
): MatchResult {
  const ctx: CountContext = {
    main,
    compare,
    maps: buildMatchMaps(result),
    placeFmt: applyPlaceOverrides(inferPlaceExportFormat(main), overrides),
    memo: importableMemo(),
  };
  return {
    individuals: result.individuals.map((c) => {
      const listed = listedCandidate(c);
      return {
        ...listed,
        ...fieldCounts(listed, ctx),
        ancestorCount: importCount(listed, ctx, "ancestors"),
        descendantCount: importCount(listed, ctx, "descendants"),
      };
    }),
  };
}
