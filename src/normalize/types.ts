import type { DateOrder, DateQualifier } from "../gedcom/types";
import type { LinkLangs } from "./links";

/**
 * The master GEDCOM's "house style", inferred on load. The compare file is
 * converted to match this so that downstream matching compares like-for-like
 * and the merged export stays internally consistent.
 */
export interface MasterProfile {
  date: DateFormatProfile;
  place: PlaceFormatProfile;
  linkLangs: LinkLangs;
  /** How the master writes places, so incoming places can be reshaped to match on load. */
  placeFmt: PlaceTargetFormat;
}

export interface DateFormatProfile {
  /**
   * When set, the master writes dates numerically (e.g. `DD.MM.YYYY`) and we
   * render in this layout instead of using month words. Otherwise dates use the
   * `[DD ]MON YYYY` month-word form described by the fields below.
   */
  numeric?: NumericDateFormat;
  /** Month tokens to emit, indexed 1..12 (index 0 unused), e.g. "JAN". */
  monthTokens: string[];
  /** Whether day numbers are zero-padded ("05" vs "5"). */
  padDay: boolean;
  /** Keyword tokens for single-endpoint qualifiers, e.g. about -> "ABT". */
  qualifierTokens: Record<DateQualifier, string>;
}

/** A numeric date layout, e.g. `DD.MM.YYYY` = `{order:"DMY", separator:"."}`. */
export interface NumericDateFormat {
  order: DateOrder;
  /** Field separator: ".", "/" or "-". */
  separator: string;
  /** Whether the day is zero-padded ("05" vs "5"). */
  padDay: boolean;
  /** Whether the month is zero-padded ("02" vs "2"). */
  padMonth: boolean;
}

/**
 * The major place-formatting conventions we detect, so the incoming file can be
 * reshaped into the master's during merge:
 *  - `structured-addr`  : comma jurisdiction in PLAC + house number in a separate
 *                         ADDR (Renko).
 *  - `packed-plac`      : everything packed into PLAC — country in parentheses,
 *                         street/parish/facility inline, no ADDR (Brother's
 *                         Keeper, e.g. Kovačič).
 *  - `address-only`     : single "Name 52" in PLAC, no jurisdiction hierarchy.
 *  - `plain-structured` : comma jurisdiction in PLAC, no embedded addresses.
 *  - `unknown`          : too little signal to classify.
 */
export type PlaceLayout =
  | "structured-addr"
  | "packed-plac"
  | "address-only"
  | "plain-structured"
  | "unknown";

export interface PlaceFormatProfile {
  /** Detected place-formatting convention. */
  layout: PlaceLayout;
  /** Most common number of jurisdiction levels seen in the master. */
  modalDepth: number;
  /** Per-part canonical casing: lowercased part -> canonical form. */
  partCanonical: Map<string, string>;
  /** Whole-place canonical form: normalized key -> canonical raw string. */
  fullCanonical: Map<string, string>;
}

/** How the master wants places written, so incoming places can match it. */
export interface PlaceTargetFormat {
  layout: PlaceLayout;
  /** PLAC jurisdiction-part separator, e.g. "," (Renko) or ", ". */
  separator: string;
  /**
   * Master's preferred display form for each country, keyed by the canonical
   * country token (e.g. "slovenia" → "Slovenija" or "Slovenia"). When present,
   * country names in incoming places are rewritten to match the master's spelling.
   */
  countryPreferred?: Map<string, string>;
  /**
   * Place associations learned from the master's own attested PLAC/ADDR/AGNC,
   * used to recognize a more specific locality than the incoming place names
   * and to fill in jurisdiction levels it omits. See {@link PlaceHierarchy}.
   */
  hierarchy?: PlaceHierarchy;
}

/**
 * Place associations learned from the master tree's own attested records —
 * not an external gazetteer, just what the master itself already shows. Lets
 * reshaping recognize that, say, "župnija Šmartin" or "Hafnarjeva pot" names a
 * more specific locality than a generic "Kranj,Slovenia", and that "Kranj"
 * the locality sits under "Kranj,Slovenia" the wider jurisdiction — purely
 * because the master has other records that already spell it out in full.
 */
export interface PlaceHierarchy {
  /** Locality (lowercased) → the master's most-attested jurisdiction chain above it. */
  parentOf: Map<string, string[]>;
  /** Parish name (lowercased, "župnija" stripped) → the master's most-attested locality. */
  localityOfParish: Map<string, string>;
  /** Street/address name (lowercased) → the master's most-attested locality. */
  localityOfStreet: Map<string, string>;
}

/** A place reshaped into the master's layout: the parts to write back. */
export interface ReformattedPlace {
  plac?: string;
  addr?: string;
  /** Parish that the master layout has no PLAC/ADDR slot for — goes to AGNC. */
  agency?: string;
}

/**
 * The major source-citation conventions we detect, so citations can be
 * resolved into a display label and a link with the right strategy:
 *  - `paginated`  : `SOUR` records carry one media item per archive page
 *                   (Matricula-style scans); a citation's `PAGE` is matched
 *                   against them to find the exact page link.
 *  - `repository` : `SOUR` records mostly link out via a `REPO` website with
 *                   no page-level media (e.g. generic Ancestry.com sources).
 *  - `literature` : `SOUR` records are mostly bibliographic (AUTH/PUBL/TEXT)
 *                   with no resolvable link — books, articles.
 *  - `inline`     : event citations are mostly free text directly on the
 *                   `SOUR` line, not pointers to a `SOUR` record.
 *  - `unknown`    : too little signal to classify.
 */
export type SourceLayout = "paginated" | "repository" | "literature" | "inline" | "unknown";

export interface SourceFormatProfile {
  /** Detected source-citation convention. */
  layout: SourceLayout;
}

/** One before/after pair recorded for the load report. */
export interface NormChange {
  before: string;
  after: string;
}

/**
 * Summary of what the load-time normalization pass altered in the compare file:
 * dates converted to the master's style, places reshaped into the master's
 * PLAC/ADDR/NOTE layout (when the master's layout calls for it), and links
 * (Matricula Online, Geneanet cemetery) rewritten to the master's language.
 */
export interface NormalizationReport {
  datesChanged: number;
  /** A handful of illustrative date changes for display. */
  dateExamples: NormChange[];
  placesReshaped: number;
  /** A handful of illustrative place changes for display. */
  placeExamples: NormChange[];
  linksConverted: number;
  /** A handful of illustrative link changes for display. */
  linkExamples: NormChange[];
}
