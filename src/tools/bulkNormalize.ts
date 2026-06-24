import type { Dataset } from "../gedcom/types";
import type { NormalizationReport, NormalizeOptions } from "../normalize/types";
import { inferMasterProfile, collectLayoutValues } from "../normalize/profile";
import { normalizeDataset } from "../normalize/normalize";

/**
 * Enforce the master file's own "house style" across the whole file.
 *
 * The normalization machinery is normally used to reshape an *incoming* compare
 * file to the master's conventions. Here we point it at the master itself: infer
 * the dominant date/place/link conventions from the file, then re-render every
 * record to them so outliers (a stray `MM/DD/YYYY` date, a foreign-language
 * Matricula link) are brought in line. The returned dataset is a clone — the
 * live master is untouched until the caller chooses to save/apply.
 *
 * `options` selects which passes to run; by default all do.
 */
export function bulkNormalize(
  ds: Dataset,
  options?: NormalizeOptions,
): { dataset: Dataset; report: NormalizationReport } {
  const profile = inferMasterProfile(ds);
  const { dateValues } = collectLayoutValues(ds);
  return normalizeDataset(ds, profile, dateValues, options);
}
