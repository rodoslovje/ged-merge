import type { Dataset } from "../gedcom/types";
import type { FormatOverrides } from "../normalize/formatOverrides";
import { detectDialect } from "../normalize/target";
import type { RecordPatch } from "../ui/historyTypes";
import { fixConformance, type ConformanceFixKind } from "./fixConformance";
import { fixDanglingRefs } from "./fixDanglingRefs";
import { fixDates, fixNonStandardDates } from "./fixDates";
import { fixDuplicatePointers } from "./fixDuplicatePointers";

/**
 * The health check's repairs that Normalize runs after the house-style
 * passes, so one Normalize leaves no finding the health check would fix on
 * its own. The keys are the health check's own fix kinds (`FixKind` in
 * ValidatePanel), so both name a repair alike.
 *
 * Left out are the repairs that decide something about the family rather
 * than about how the file is written: dropping a one-way link, a sex read
 * from a family role, swapped spouses, merging duplicate families, and the
 * media-title removal the health check runs only on the user's word. So is
 * the source-coverage repair: Normalize's own source-coverage pass writes
 * the standard shape wherever the target or the file's habit asks for it.
 */
export type NormalizeRepairKind = "dangling" | "dups" | "dates" | "nonStandard" | Exclude<ConformanceFixKind, "fileTitles" | "coverage">;

/** In the order they run: pointers first, then dates, then the lines the
 *  standard has otherwise. */
export const NORMALIZE_REPAIRS: readonly NormalizeRepairKind[] = [
  "dangling", "dups", "dates", "nonStandard",
  "values", "repeats", "forms", "notes", "relocate", "agency", "citationPage", "mediaInfo",
  "childPedi", "smartMatch", "assoDates", "stamps",
];

/**
 * The repairs `overrides`' target allows on `dataset`. A strict target
 * (`overrides.standard`) takes them all. A file kept with its variations
 * keeps its program's event stamps, as the health check does.
 */
export function normalizeRepairKinds(dataset: Dataset, overrides?: FormatOverrides): NormalizeRepairKind[] {
  if (overrides?.standard || !detectDialect(dataset)?.nestedStamps) return [...NORMALIZE_REPAIRS];
  return NORMALIZE_REPAIRS.filter((k) => k !== "stamps");
}

/** Run one repair over the whole file, in place; its undo patches. */
export function runNormalizeRepair(dataset: Dataset, kind: NormalizeRepairKind, overrides?: FormatOverrides): RecordPatch[] {
  switch (kind) {
    case "dangling": return fixDanglingRefs(dataset);
    case "dups": return fixDuplicatePointers(dataset);
    case "dates": return fixDates(dataset);
    case "nonStandard": return fixNonStandardDates(dataset, overrides);
    default: return fixConformance(dataset, kind);
  }
}
