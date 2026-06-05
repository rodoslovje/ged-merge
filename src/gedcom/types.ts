/**
 * Core GEDCOM types.
 *
 * Two layers:
 *  1. The raw line tree (`GedNode`) — a faithful, lossless representation of the
 *     parsed file. Every line becomes a node; nothing is dropped. This is what
 *     we serialize back out so unmodified records round-trip byte-for-(near)byte.
 *  2. The typed domain model (`Individual`, `Family`, …) — a convenient,
 *     version-agnostic projection built on top of the raw tree for matching and
 *     UI. Domain objects keep a pointer back to their raw node.
 */

/** GEDCOM spec versions we understand. */
export type GedcomVersion = "5.5.1" | "7.0" | "unknown";

/** Declared character encoding from HEAD.CHAR (5.5.1) — 7.0 is always UTF-8. */
export type GedcomCharset =
  | "UTF-8"
  | "UNICODE" // UTF-16, per 5.5.1
  | "ANSEL"
  | "ASCII"
  | "ANSI" // non-standard but common; ambiguous, resolved by detection
  | "WINDOWS-1252" // Western European (the usual meaning of "ANSI")
  | "WINDOWS-1250"; // Central European (Brother's Keeper etc. on CE locales)

/**
 * A single parsed GEDCOM line and its children.
 *
 * A line is: `level [@xref@] tag [value]`. Continuation lines (CONT/CONC) are
 * folded into the owning node's `value` during parsing, so they do not appear
 * as separate nodes.
 */
export interface GedNode {
  level: number;
  /** Cross-reference id this line *defines*, e.g. `@I1@` on a record line. */
  xref?: string;
  tag: string;
  /** Line value, with CONT/CONC already folded in. May be an xref pointer. */
  value?: string;
  children: GedNode[];
}

/** Result of parsing raw bytes into a tree, plus detected metadata. */
export interface ParseResult {
  version: GedcomVersion;
  charset: GedcomCharset;
  /** Top-level records (level 0 nodes), including HEAD and TRLR. */
  records: GedNode[];
  /** Non-fatal issues encountered during parse/decode. */
  warnings: ParseWarning[];
}

export interface ParseWarning {
  kind:
    | "encoding"
    | "syntax"
    | "unknown-tag"
    | "version"
    | "structure"
    | "date"
    | "place";
  message: string;
  line?: number;
}

// ---------------------------------------------------------------------------
// Typed domain model
// ---------------------------------------------------------------------------

export type Sex = "M" | "F" | "U";

/** A structured personal name parsed from a NAME line. */
export interface PersonName {
  /** Full reconstructed name for display. */
  full: string;
  given?: string;
  surname?: string;
  prefix?: string;
  suffix?: string;
  nickname?: string;
}

/** Date qualifier per the GEDCOM date grammar. */
export type DateQualifier =
  | "exact"
  | "about" // ABT / EST / CAL
  | "before" // BEF
  | "after" // AFT
  | "between" // BET..AND
  | "from" // FROM
  | "to" // TO
  | "range" // FROM..TO
  | "interpreted"
  | "unknown";

/**
 * A semantically-parsed date, kept alongside its original text so it can be
 * rendered back in the master's observed format.
 */
export interface GedDate {
  /** Original date string exactly as it appeared in the file. */
  raw: string;
  qualifier: DateQualifier;
  /** Primary date as components; undefined parts mean "not specified". */
  year?: number;
  month?: number; // 1-12
  day?: number; // 1-31
  /** Second endpoint for between/range qualifiers. */
  year2?: number;
  month2?: number;
  day2?: number;
}

/** A place, kept raw plus split into its comma-separated hierarchy. */
export interface GedPlace {
  raw: string;
  /** Jurisdiction parts, outermost-last as GEDCOM convention (city..country). */
  parts: string[];
}

/** A dated/placed life event (BIRT, DEAT, MARR, …). */
export interface GedEvent {
  tag: string;
  date?: GedDate;
  place?: GedPlace;
}

export interface Individual {
  id: string; // xref, e.g. "@I1@"
  names: PersonName[];
  sex: Sex;
  events: GedEvent[];
  /** Family ids where this person is a child (FAMC). */
  childOf: string[];
  /** Family ids where this person is a spouse/parent (FAMS). */
  spouseOf: string[];
  /** Back-reference to the raw record for lossless round-tripping. */
  raw: GedNode;
}

export interface Family {
  id: string; // xref, e.g. "@F1@"
  husband?: string; // individual xref
  wife?: string; // individual xref
  children: string[]; // individual xrefs
  events: GedEvent[]; // MARR, DIV, …
  raw: GedNode;
}

/** Fully-built, version-agnostic dataset ready for matching and display. */
export interface Dataset {
  version: GedcomVersion;
  charset: GedcomCharset;
  individuals: Map<string, Individual>;
  families: Map<string, Family>;
  records: GedNode[];
  warnings: ParseWarning[];
}
