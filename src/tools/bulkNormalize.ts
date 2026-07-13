import type { Dataset } from "../gedcom/types";
import type { NormalizationReport, NormalizeOptions } from "../normalize/types";
import { inferMainProfile, collectLayoutValues } from "../normalize/profile";
import { normalizeDataset } from "../normalize/normalize";

/**
 * Enforce the main file's own "house style" across the whole file.
 *
 * The normalization machinery is normally used to reshape an *incoming* compare
 * file to the main's conventions. Here we point it at the main itself: infer
 * the dominant date/place/link conventions from the file, then re-render every
 * record to them so outliers (a stray `MM/DD/YYYY` date, a foreign-language
 * Matricula link) are brought in line. The returned dataset is a clone — the
 * live main is untouched until the caller chooses to save/apply.
 *
 * `options` selects which passes to run; by default all do — including the
 * opt-in internal-tag strip, so the preview report can show what it *would*
 * remove (the panel's checkbox then decides whether the download includes it;
 * load-time normalization never runs it).
 */
export function bulkNormalize(
  ds: Dataset,
  options?: NormalizeOptions,
): { dataset: Dataset; report: NormalizationReport } {
  const profile = inferMainProfile(ds);
  const { dateValues } = collectLayoutValues(ds);
  return normalizeDataset(ds, profile, dateValues, options ?? {
    dates: true, places: true, links: true, names: true, vendorTags: true, stripInternal: true,
  });
}
