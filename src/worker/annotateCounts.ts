import { buildMatchMaps, countImportableRelatives, importableMemo } from "../chart/personTree";
import type { Dataset } from "../gedcom/types";
import { listedCandidate, type MatchResult } from "../match/types";
import { applyPlaceOverrides, type FormatOverrides } from "../normalize/formatOverrides";
import { inferPlaceExportFormat } from "../normalize/profile";
import { fieldDiffCounts, individualFieldRows } from "../review/fields";

/** Field labels are irrelevant to the counts computed here, so use a no-op
 *  translator (the worker has no i18n context). */
const rawLabel = (key: string) => key;

/** Attach per-candidate "new" and "differing" field counts plus the importable
 *  ancestor/descendant counts for the results table — to the list entries,
 *  without the score breakdowns (see `MatchCandidate`). */
export function annotateCounts(
  result: MatchResult,
  main: Dataset,
  compare: Dataset,
  overrides: FormatOverrides | undefined,
): MatchResult {
  // The same format the review rows and the merge use (mergePlaceFormat):
  // counted without the overrides, a diff badge could disagree with the rows
  // the panel actually shows.
  const placeFmt = applyPlaceOverrides(inferPlaceExportFormat(main), overrides);
  const maps = buildMatchMaps(result);
  // One memo for the whole result: candidates share their relatives' lines.
  const memo = importableMemo();
  return {
    individuals: result.individuals.map((c) => {
      const mainInd = main.individuals.get(c.mainId);
      const compareInd = compare.individuals.get(c.compareId);
      return {
        ...listedCandidate(c),
        ...fieldDiffCounts(individualFieldRows(rawLabel, mainInd, compareInd, main, compare, placeFmt)),
        ancestorCount: countImportableRelatives(mainInd, compareInd, main, compare, maps, "ancestors", memo),
        descendantCount: countImportableRelatives(mainInd, compareInd, main, compare, maps, "descendants", memo),
      };
    }),
  };
}
