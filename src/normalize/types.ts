import type { DateOrder, DateQualifier, GedcomVersion } from "../gedcom/types";
import type { PrivacyTagStyle } from "../gedcom/private";
import type { LinkLangs } from "./links";

/**
 * The main GEDCOM's "house style", inferred on load. The compare file is
 * converted to match this so that downstream matching compares like-for-like
 * and the merged export stays internally consistent.
 */
export interface MainProfile {
  /** The main file's declared GEDCOM version — the migration target for a
   * compare file declaring a different one. */
  version: GedcomVersion;
  date: DateFormatProfile;
  place: PlaceFormatProfile;
  linkLangs: LinkLangs;
  /** How the main writes places, so incoming places can be reshaped to match on load. */
  placeFmt: PlaceTargetFormat;
  /** How the main records each alternate-name variant, so incoming names can be reshaped to match. */
  nameVariants: NameProfile;
  /** How the main marks an unknown given/surname, so incoming placeholder
   * tokens (`NN`, `____`, `????`) can be reshaped to match. */
  unknownName: UnknownNameTarget;
  /** The main's privacy-marker dialect (MacFamilyTree `PRIV`, MyHeritage
   * `_PRIV Y`, standard `RESN`), so incoming markers are rewritten to match.
   * Absent when the main carries no markers — the compare's dialect then
   * passes through unchanged. */
  privacyStyle?: PrivacyTagStyle;
}

/**
 * How the main records an *unknown* name part, so incoming placeholder tokens
 * are reshaped to the same convention:
 *  - `blank` : the main leaves an unknown given/surname empty — strip incoming
 *              placeholders (`____` → nothing). This is the default.
 *  - `token` : the main writes a literal marker (kept in {@link token}, e.g.
 *              `NN`) — rewrite incoming placeholders to that marker.
 */
export interface UnknownNameTarget {
  form: "blank" | "token";
  /** For `form: "token"`, the main's marker spelling, e.g. "NN" or "N.N.". */
  token?: string;
}

/**
 * A file's overall alternate-name storage style, for the loader's "Name format"
 * line — how it records married/birth/aka/nick names across the board:
 *  - `tags`    : inline sub-tags on the primary `NAME` (`_MARNM`, `_BIRN`, `NICK`…
 *                — Gramps, PAF, Brother's Keeper).
 *  - `records` : separate `1 NAME` records with a `2 TYPE` (GEDCOM 5.5.1 standard).
 *  - `none`    : no alternate names recorded.
 */
export type NameLayout = "tags" | "records" | "none";

/**
 * The alternate-name variants we normalize. Each names the *same logical name*
 * that different programs store in incompatible ways — a separate `2 TYPE x`
 * NAME record vs. an inline sub-tag on the primary name:
 *  - `married` : `TYPE married` record  ⇄  `_MARNM` (surname)
 *  - `birth`   : `TYPE birth`/`maiden`  ⇄  `_BIRN` (surname)
 *  - `aka`     : `TYPE aka` record      ⇄  `_AKA`/`_AKAN` (given)
 *  - `nick`    : `TYPE nick` record     ⇄  `NICK` sub-tag (given)
 */
export type NameVariantKind = "married" | "birth" | "aka" | "nick";

/** How the main writes one name variant, so incoming names are reshaped to it. */
export interface NameVariantTarget {
  /** `record` = a separate `2 TYPE` NAME record; `tag` = an inline sub-tag on the
   * primary name; `none` = the main doesn't use this variant (leave incoming as-is). */
  form: "record" | "tag" | "none";
  /** For `form: "tag"`, the sub-tag to write (e.g. `_MARNM`, `_BIRN`, `_AKA`, `NICK`). */
  tag?: string;
  /** For `form: "record"`, the main's preferred `2 TYPE` token, with its own
   * casing/spelling (e.g. `married`, `Birth`, `maiden`) — so incoming records
   * are also recased/unified to it. */
  type?: string;
}

export type NameProfile = Record<NameVariantKind, NameVariantTarget>;

export interface DateFormatProfile {
  /**
   * When set, the main writes dates numerically (e.g. `DD.MM.YYYY`) and we
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
  /**
   * Character the main writes for an unknown date component (e.g. "_"), or
   * undefined when it omits unknown parts instead. When set, reshaping fills a
   * missing field with a run of this character padded to the field's width
   * ("__" for day/month, "____" for year) rather than dropping the slot — so an
   * incoming "FEB 1900" becomes "__.02.1900" and ".__.____" becomes
   * "__.__.____", matching the main's house style.
   */
  placeholder?: string;
}

/**
 * The major place-formatting conventions we detect, so the incoming file can be
 * reshaped into the main's during merge:
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
  /** Most common number of jurisdiction levels seen in the main. */
  modalDepth: number;
  /** Per-part canonical casing: lowercased part -> canonical form. */
  partCanonical: Map<string, string>;
  /** Whole-place canonical form: normalized key -> canonical raw string. */
  fullCanonical: Map<string, string>;
}

/** How the main wants places written, so incoming places can match it. */
export interface PlaceTargetFormat {
  layout: PlaceLayout;
  /** PLAC jurisdiction-part separator, e.g. "," (Renko) or ", ". */
  separator: string;
  /**
   * The separator was *chosen* by the reader (Settings → GEDCOM), not inferred
   * from the file's own habit. A chosen one is imposed on every layout — even
   * the pass-through ones, whose place text is otherwise never rewritten.
   */
  separatorEnforced?: boolean;
  /**
   * Main's preferred display form for each country, keyed by the canonical
   * country token (e.g. "slovenia" → "Slovenija" or "Slovenia"). When present,
   * country names in incoming places are rewritten to match the main's spelling.
   */
  countryPreferred?: Map<string, string>;
  /**
   * Place associations learned from the main's own attested PLAC/ADDR/AGNC,
   * used to recognize a more specific locality than the incoming place names
   * and to fill in jurisdiction levels it omits. See {@link PlaceHierarchy}.
   */
  hierarchy?: PlaceHierarchy;
  /**
   * The `FORM` labels the main writes on its own places, so a place newly
   * completed from a register can declare its levels the same way. See
   * {@link PlaceFormVocabulary}.
   */
  forms?: PlaceFormVocabulary;
}

/**
 * A file's own `PLAC`.`FORM` wording, learned from the places it already has.
 *
 * `FORM` names the jurisdiction level each comma part of a place stands for
 * ("Place,Upravna Enota,Country"), so the wording is per country — the same
 * three-part shape is "Place,Bundesland,Country" in Germany — and per depth.
 * Keyed by both together ({@link placeFormKey}), with a depth-only entry kept
 * for the files that label every country alike.
 *
 * Empty for a file that writes no `FORM` at all: that is a house style too, and
 * one we don't override.
 */
export type PlaceFormVocabulary = Map<string, string>;

/**
 * Place associations learned from the main tree's own attested records —
 * not an external gazetteer, just what the main itself already shows. Lets
 * reshaping recognize that, say, "župnija Šmartin" or "Hafnarjeva pot" names a
 * more specific locality than a generic "Kranj,Slovenia", and that "Kranj"
 * the locality sits under "Kranj,Slovenia" the wider jurisdiction — purely
 * because the main has other records that already spell it out in full.
 */
export interface PlaceHierarchy {
  /** Locality (lowercased) → the main's most-attested jurisdiction chain above it. */
  parentOf: Map<string, string[]>;
  /** Street/address name (lowercased) → the main's most-attested locality. */
  localityOfStreet: Map<string, string>;
}

/** A place reshaped into the main's layout: the parts to write back. */
export interface ReformattedPlace {
  plac?: string;
  addr?: string;
  /** Parish that the main layout has no PLAC/ADDR slot for — goes to AGNC. */
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
 * Which normalization passes to apply. Used by the bulk-normalize tool to let
 * the user opt out of individual transformations (dates / places / links).
 * All passes run when omitted, so load-time normalization is unaffected.
 */
export interface NormalizeOptions {
  dates: boolean;
  places: boolean;
  links: boolean;
  names: boolean;
  /** Rewrite vendor-tag synonyms to their canonical form (`_MILI` → `_MILT`). */
  vendorTags: boolean;
  /** Alias source-tags the vendorTags pass must leave untouched. The
   * bulk-normalize tool sets it to the file's own native dialect
   * (`nativeAliasTags`), so e.g. a MacFamilyTree file keeps its `MISE` instead
   * of gaining a foreign `_MILT`. Load-time compare normalization never sets it. */
  preserveVendorTags?: ReadonlySet<string>;
  /** GEDCOM version migration (compare → main's version). Defaults to on;
   * it only ever fires when the two declared versions actually differ. */
  version?: boolean;
  /** Remove software-internal vendor tags (`_UPD`, `_RINS`, `_COLOR*`, …) from
   * INDI/FAM records. Deliberately lossy, so it's opt-in: off at load time,
   * offered as a checkbox in the bulk-normalize tool. */
  stripInternal?: boolean;
}

/**
 * Summary of what the load-time normalization pass altered in the compare file:
 * dates converted to the main's style, places reshaped into the main's
 * PLAC/ADDR/NOTE layout (when the main's layout calls for it), and links
 * (Matricula Online, Geneanet cemetery) rewritten to the main's language.
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
  /** Alternate names (married/birth/aka/nick) rewritten into the main's convention. */
  nameVariantsReshaped: number;
  /** A handful of illustrative name-variant changes for display. */
  nameVariantExamples: NormChange[];
  /** Unknown-name placeholders (`NN`, `____`, `????`) rewritten to the main's convention. */
  unknownNamesReshaped: number;
  /** A handful of illustrative unknown-name changes for display. */
  unknownNameExamples: NormChange[];
  /** Vendor-tag synonyms rewritten to their canonical tag (`_MILI` → `_MILT`). */
  vendorTagsRenamed: number;
  /** A handful of illustrative vendor-tag renames for display. */
  vendorTagExamples: NormChange[];
  /** Software-internal vendor tags removed by the opt-in strip pass. */
  internalStripped: number;
  /** A handful of illustrative stripped-tag examples for display. */
  internalExamples: NormChange[];
  /** Incoming records merged away as same-person duplicates (detected because
   *  they matched the same main). Set by the worker after matching, so it's
   *  absent until then. */
  consolidatedDuplicates?: number;
  /** Present when the compare file declares a different GEDCOM version than
   *  the main: its version-specific structures were rewritten to the main's
   *  spec (e.g. 5.5.1 `NOTE` records → 7.0 `SNOTE`, date phrases ⇄ `PHRASE`). */
  versionMigration?: {
    from: GedcomVersion;
    to: GedcomVersion;
    changed: number;
    examples: NormChange[];
  };
}
