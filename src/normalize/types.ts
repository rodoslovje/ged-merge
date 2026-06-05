import type { DateQualifier } from "../gedcom/types";

/**
 * The master GEDCOM's "house style", inferred on load. The compare file is
 * converted to match this so that downstream matching compares like-for-like
 * and the merged export stays internally consistent.
 */
export interface MasterProfile {
  date: DateFormatProfile;
  place: PlaceFormatProfile;
}

export interface DateFormatProfile {
  /** Month tokens to emit, indexed 1..12 (index 0 unused), e.g. "JAN". */
  monthTokens: string[];
  /** Whether day numbers are zero-padded ("05" vs "5"). */
  padDay: boolean;
  /** Keyword tokens for single-endpoint qualifiers, e.g. about -> "ABT". */
  qualifierTokens: Record<DateQualifier, string>;
}

export interface PlaceFormatProfile {
  /** Most common number of jurisdiction levels seen in the master. */
  modalDepth: number;
  /** Per-part canonical casing: lowercased part -> canonical form. */
  partCanonical: Map<string, string>;
  /** Whole-place canonical form: normalized key -> canonical raw string. */
  fullCanonical: Map<string, string>;
}

/** One before/after pair recorded for the load report. */
export interface NormChange {
  before: string;
  after: string;
}

/** Summary of what the normalization pass altered in the compare file. */
export interface NormalizationReport {
  datesChanged: number;
  placesChanged: number;
  /** A handful of illustrative changes for display. */
  dateExamples: NormChange[];
  placeExamples: NormChange[];
}
