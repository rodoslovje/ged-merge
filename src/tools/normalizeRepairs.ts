import type { Dataset } from "../gedcom/types";
import type { FormatOverrides } from "../normalize/formatOverrides";
import { detectDialect, type FileDialect } from "../normalize/target";
import { detectSourceCoverage } from "../gedcom/source";
import type { RecordPatch } from "../ui/historyTypes";
import { fixConformance, type ConformanceFixKind } from "./fixConformance";
import { fixDanglingRefs } from "./fixDanglingRefs";
import { fixDates, fixNonStandardDates, type OnDateFix } from "./fixDates";
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
 * The program habits a file kept with its variations keeps, which the health
 * check therefore reports without a fix and Normalize leaves alone:
 *
 *  - `coverage` — a source's own `PLAC`/`DATE`/`AGNC`, where the file's
 *    source coverage (the Settings choice, else its own majority) is the
 *    program's: Normalize's source-coverage pass writes them back there;
 *  - `stamps` — `CHAN`/`CREA` below the records, from a program that stamps
 *    its events that way.
 *
 * A strict target (`overrides.standard`) keeps none.
 */
export function keptHabits(
  dataset: Pick<Dataset, "records">,
  overrides?: FormatOverrides,
  /** The file's dialect, when the caller already has it (detected at load). */
  dialect: FileDialect | undefined = detectDialect(dataset),
): { coverage: boolean; stamps: boolean } {
  if (overrides?.standard) return { coverage: false, stamps: false };
  return {
    coverage: (overrides?.sourceCoverage ?? detectSourceCoverage(dataset.records)) === "vendor",
    stamps: !!dialect?.nestedStamps,
  };
}

/** The repairs `overrides`' target allows on `dataset`: all of them, but the
 *  habits a file kept with its variations keeps (see {@link keptHabits}). */
export function normalizeRepairKinds(dataset: Dataset, overrides?: FormatOverrides): NormalizeRepairKind[] {
  const kept = keptHabits(dataset, overrides);
  return NORMALIZE_REPAIRS.filter((k) => !(k === "agency" && kept.coverage) && !(k === "stamps" && kept.stamps));
}

/** The repairs that rewrite dates: Normalize runs and counts them with its
 *  own date pass, so every date it changes is under one row. */
export const DATE_REPAIRS: ReadonlySet<NormalizeRepairKind> = new Set(["dates", "nonStandard"]);

/** Run one repair over the whole file, in place; its undo patches.
 *  `onDate` is told each date a date repair rewrites. */
export function runNormalizeRepair(dataset: Dataset, kind: NormalizeRepairKind, overrides?: FormatOverrides, onDate?: OnDateFix): RecordPatch[] {
  switch (kind) {
    case "dangling": return fixDanglingRefs(dataset);
    case "dups": return fixDuplicatePointers(dataset);
    case "dates": return fixDates(dataset, undefined, onDate);
    case "nonStandard": return fixNonStandardDates(dataset, overrides, undefined, onDate);
    default: return fixConformance(dataset, kind);
  }
}
