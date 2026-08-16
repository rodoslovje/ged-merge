import type { Dataset } from "../gedcom/types";
import type { NormChange, NormalizationReport, NormalizeOptions } from "../normalize/types";
import { childValue } from "../gedcom/node";
import { nativeAliasTags } from "../gedcom/vendorTags";
import { inferMainProfile, collectLayoutValues } from "../normalize/profile";
import { applyFormatOverrides, type FormatOverrides } from "../normalize/formatOverrides";
import { normalizeDataset } from "../normalize/normalize";
import { detectSourceCoverage } from "../gedcom/source";
import { baptismTargetTag, normalizeSourceCoverage } from "./sourceReshape";
import { detectNoteShapes, reshapeNotes } from "./noteReshape";

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
  const result = normalizeDataset(ds, profile, dateValues, {
    ...(options ?? { dates: true, places: true, links: true, names: true, vendorTags: true, stripInternal: true }),
    preserveVendorTags,
    // Never on one's own file — see `NormalizeOptions.tidyPlaceWhitespace`.
    tidyPlaceWhitespace: false,
  });
  // Note shape: restate every note as the file writes notes — a shared record
  // the referrer points at, or inline. The two levels are asked separately:
  // a file's records and its events can hold opposite habits, and "Auto"
  // follows each of them rather than forcing one on both.
  if (options?.noteShape !== false) {
    const detected = detectNoteShapes(ds.records);
    const recordTarget = overrides?.notes ?? detected.record;
    const eventTarget = overrides?.eventNotes ?? detected.event;
    const passes = [
      { target: recordTarget, scope: { record: true, event: false } },
      { target: eventTarget, scope: { record: false, event: true } },
    ];
    let changed = 0;
    const examples: NormChange[] = [];
    for (const { target, scope } of passes) {
      const r = reshapeNotes(result.dataset.records, target, scope);
      changed += r.changed;
      for (const ex of r.examples) if (examples.length < 12) examples.push(ex);
    }
    result.report.notesReshaped = changed;
    result.report.noteShapeExamples = examples;
  }
  // Source coverage: restate each source's what-it-covers in the house shape —
  // the Settings choice, or the file's own majority. An outlier brought in by
  // a merge (a DATA > EVEN source in a flat file, or the reverse) comes in
  // line like a stray date format does.
  if (options?.sourceCoverage !== false) {
    const target = overrides?.sourceCoverage ?? detectSourceCoverage(ds.records);
    const baptismTag = overrides?.baptism ?? baptismTargetTag(ds.records);
    const coverage = normalizeSourceCoverage(result.dataset.records, target, baptismTag);
    result.report.coverageReshaped = coverage.changed;
    result.report.coverageExamples = coverage.examples;
  }
  return result;
}
