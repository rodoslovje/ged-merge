import type { Dataset } from "../gedcom/types";
import type { NormalizationReport, NormalizeOptions } from "../normalize/types";
import { childValue } from "../gedcom/node";
import { nativeAliasTags } from "../gedcom/vendorTags";
import { inferMainProfile, collectLayoutValues } from "../normalize/profile";
import { applyFormatOverrides, type FormatOverrides } from "../normalize/formatOverrides";
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
 *
 * `overrides` are the reader's Settings → GEDCOM choices. They win over what
 * the file's own habit says, exactly as they do when an incoming compare file
 * is reshaped on load — otherwise "enforce the house style" would ignore the
 * house style the reader actually picked.
 */
export function bulkNormalize(
  ds: Dataset,
  options?: NormalizeOptions,
  overrides?: FormatOverrides,
): { dataset: Dataset; report: NormalizationReport } {
  const profile = applyFormatOverrides(inferMainProfile(ds), overrides);
  const { dateValues } = collectLayoutValues(ds);
  // Vendor-tag aliases canonicalize toward the spelling *this app* supports —
  // right for an incoming compare file, wrong when the tag is the file's own
  // producer's dialect (a MacFamilyTree file must keep `MISE`, or a re-import
  // into MacFamilyTree loses the fact). Exempt the producer's native aliases,
  // identified from the HEAD>SOUR system id.
  const head = ds.records.find((r) => r.tag === "HEAD");
  const preserveVendorTags = nativeAliasTags(head && childValue(head, "SOUR"));
  return normalizeDataset(ds, profile, dateValues, {
    ...(options ?? { dates: true, places: true, links: true, names: true, vendorTags: true, stripInternal: true }),
    preserveVendorTags,
    // Never on one's own file — see `NormalizeOptions.tidyPlaceWhitespace`.
    tidyPlaceWhitespace: false,
  });
}
