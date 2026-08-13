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
  /**
   * Runtime-only annotation (never serialized): the line's value before a
   * load-time reshape replaced it, kept so the UI can still show the
   * original text in a tooltip. See `normalize/normalize.ts`.
   */
  reshapedFrom?: string;
  /**
   * Runtime-only marker (never serialized): set on an event node when an edit
   * or merge adds it ("new") or modifies it ("changed"), so save-time audit
   * stamping (`stampChanCrea`) writes CHAN/CREA onto exactly the events that
   * changed rather than guessing. Preserved by `cloneNode` — the merge stamps
   * a clone of the edit-marked main, and undo/redo snapshots restore the
   * marker state of their side. Consumed (and cleared) during stamping.
   */
  auditStamp?: "new" | "changed";
  /**
   * A source line the parser could not interpret, kept verbatim so saving
   * never silently drops it. Such a node carries the empty tag "" (so no
   * tag-matching logic ever picks it up), has no children, and serializes
   * back as exactly this text at its original position in the stream.
   */
  verbatim?: string;
}

/** Result of parsing raw bytes into a tree, plus detected metadata. */
export interface ParseResult {
  version: GedcomVersion;
  charset: GedcomCharset;
  /** Top-level records (level 0 nodes), including HEAD and TRLR. */
  records: GedNode[];
  /** Non-fatal issues encountered during parse/decode. */
  warnings: ParseWarning[];
  /** Original line-ending ("\n" or "\r\n"), preserved for faithful round-trip. */
  eol: string;
  /** Whether the source ended with a trailing newline. */
  finalNewline: boolean;
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
  /** Machine-readable tag for the warnings the UI reacts to, so it never has to
   *  match on `message`. `undecodable`: bytes the decoder replaced with `�`,
   *  which no save can bring back. */
  code?: "undecodable";
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
  /** `2 TYPE` value (e.g. "married", "maiden", "aka", "nick") for non-primary names. */
  type?: string;
  /** Married surname carried inline on the primary name as a `2 _MARNM` sub-tag
   * (the alternative to a separate `1 NAME` + `2 TYPE married` record). */
  married?: string;
}

/**
 * Field ordering of a numeric date (e.g. "DMY" = `DD.MM.YYYY`, "MDY" =
 * `MM/DD/YYYY`, "YMD" = `YYYY-MM-DD`). Used both to disambiguate numeric dates
 * when parsing and to re-render them in a target style.
 */
export type DateOrder = "DMY" | "MDY" | "YMD";

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
 * rendered back in the main's observed format.
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
  /**
   * The raw value was a deliberate all-unknown placeholder date (e.g.
   * ".__.____" / "__.__.____"): no component is known, but it is an intentional
   * "date unknown" marker, not uninterpretable text. Lets reshaping re-render it
   * in the main's placeholder layout instead of preserving a foreign marker
   * verbatim. (Partial placeholder dates that keep a real year/month are parsed
   * into those components and don't need this flag.)
   */
  placeholder?: boolean;
}

/** A decimal-degree coordinate lifted from `PLAC.MAP` (`LATI`/`LONG`). */
export interface GeoCoord {
  lat: number;
  lon: number;
}

/** A place, kept raw plus split into its comma-separated hierarchy. */
export interface GedPlace {
  raw: string;
  /** Jurisdiction parts, outermost-last as GEDCOM convention (city..country). */
  parts: string[];
  /** Coordinates from the place's `MAP` structure, when present and parseable. */
  coord?: GeoCoord;
  /**
   * Most-specific "place detail" extracted from the leading part — typically a
   * house number (Slovenian hišna številka), e.g. "23" in "Šentvid 23". Two
   * places with the same locality but different detail are different locations.
   */
  detail?: string;
  /** Pre-reshape text, when a load-time reshape changed `raw` (see `GedNode.reshapedFrom`). */
  originalRaw?: string;
  /** The place's `FORM`, naming the jurisdiction level each part stands for
   *  ("Place,Upravna Enota,Country"). Only meaningful on a `PLAC`. */
  form?: string;
}

/**
 * A source citation (`SOUR`) attached to an event, resolved from a pointer to
 * a top-level `SOUR` record (or, for simpler exporters, the citation's own
 * free-text value). See `gedcom/source.ts` for how `url`/`exact` are derived.
 */
export interface SourceCitation {
  /** The cited source's xref (e.g. "@S123@"), or the literal text for an inline citation. */
  sourceId: string;
  /** SOUR.TITL, or an "AUTH, PUBL" fallback when there is no title. */
  title?: string;
  /** SOUR.AGNC — the archive/agency that holds the source. */
  agency?: string;
  /** SOUR.FILN — an archival filing/book number. */
  filingNumber?: string;
  /** The citation's own `PAGE` sub-tag, e.g. a folio or page number. */
  page?: string;
  /** Best link we could resolve: the exact cited page, the source's only
   *  image, or (last resort) the holding repository's website. */
  url?: string;
  /** True when `url` points at the precise cited page rather than a fallback. */
  exact: boolean;
  /** The `OBJE` record xref backing `url`, when it's a specific page image
   *  rather than a repository fallback — lets an edit retarget just that
   *  page's file without touching any other citation of the same source. */
  objeXref?: string;
}

/**
 * One record-level note as an editable reference: its verbatim text plus the
 * shared `0 @N…@ NOTE` record it points to, when it's a pointer note. Unlike
 * the display-oriented `notes` (URLs stripped, markup tidied), `text` is the
 * stored text as-is, so writing it back round-trips losslessly and an edit to
 * a pointer note can be applied to the shared record instead of flattening
 * the pointer into an inline copy.
 */
export interface NoteRef {
  /** xref of the shared NOTE record this note points to; absent = inline note. */
  xref?: string;
  /** Full note text, verbatim — for a pointer note, the referenced record's text. */
  text: string;
  /** Flagged private (MacFamilyTree `PRIV`, MyHeritage `_PRIV Y`, standard
   *  `RESN privacy`/`confidential`) — excluded from publishing, and its URLs
   *  are never surfaced as links or moved into sources. */
  private?: boolean;
}

/** A dated/placed life event (BIRT, DEAT, MARR, …). */
export interface GedEvent {
  tag: string;
  /** Direct value on the event line itself, e.g. "Farmer" in `1 OCCU Farmer`. */
  value?: string;
  /** `2 TYPE` sub-tag value — event sub-type or custom event description (e.g. "Graduation"). */
  type?: string;
  date?: GedDate;
  place?: GedPlace;
  /** Street/house address (ADDR), parsed like a place so it gains a house-number detail. */
  address?: GedPlace;
  /** Agency (AGNC) that recorded or organised the event (e.g. hospital, parish). */
  agency?: string;
  /** Cause (CAUS) associated with the event, e.g. cause of death. */
  cause?: string;
  /** First inline NOTE sub-tag on this event (e.g. parish/facility from packed-place decomposition). */
  note?: string;
  /** The same note with its URLs kept in place — present only when `note`
   *  had links stripped out of it (they live in `links` for merging).
   *  Renderers that show the note verbatim (reports) prefer this. */
  noteWithLinks?: string;
  /** When the event's first NOTE sub-tag is a pointer to a shared NOTE record,
   *  that record's xref — note edits are applied to the record, keeping the
   *  pointer (and the record's sharing) intact. */
  noteXref?: string;
  /** URLs (WWW/URL/_LINK/OBJE.FILE or embedded in text) attached to this event. */
  links?: string[];
  /** The subset of `links` borne by the event's own direct link tags
   *  (WWW/URL/…) — the only ones a link edit may rewrite. The rest live in
   *  note text or shared media records: rewriting those as WWW lines would
   *  duplicate them, and "removing" them would be a no-op. */
  editableLinks?: string[];
  /** Source citations (`SOUR`) attached to this event. */
  sources?: SourceCitation[];
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
  /** URLs attached directly to the record (not to a specific event). */
  links?: string[];
  /** The subset of `links` a link edit may rewrite — see GedEvent.editableLinks. */
  editableLinks?: string[];
  /** Free-text NOTE records attached directly to the individual. */
  notes?: string[];
  /** The same notes with their URLs kept in place — present only when `notes`
   *  had links stripped (they live in `links` for merging). Renderers that
   *  show notes verbatim (reports) prefer this. */
  notesWithLinks?: string[];
  /** Every record-level note as an editable reference (verbatim text + shared-record
   *  identity), including notes `notes` hides because only a URL remains after
   *  stripping. The editing UI works on these; `notes` stays display-only. */
  noteRefs?: NoteRef[];
  /** Source citations (`SOUR`) attached directly to the individual (not to a specific event). */
  sources?: SourceCitation[];
  /** Record-level unique identifiers (`_UID` vendor tag / GEDCOM 7 `UID`),
   *  verbatim. Two records carrying the same identifier are the same person
   *  (same software lineage), which matching uses as a certain pre-match. */
  uids?: string[];
  /** FamilySearch person ids (`_FID` MacFamilyTree / `_FSFTID` RootsMagic),
   *  verbatim — a second identity namespace for the same pre-match. */
  fsids?: string[];
  /** Record flagged private (see {@link NoteRef.private} for the dialects). */
  private?: boolean;
  /** Back-reference to the raw record for lossless round-tripping. */
  raw: GedNode;
}

export interface Family {
  id: string; // xref, e.g. "@F1@"
  husband?: string; // individual xref
  wife?: string; // individual xref
  children: string[]; // individual xrefs
  events: GedEvent[]; // MARR, DIV, …
  /** URLs attached directly to the family record (not to a specific event). */
  links?: string[];
  /** The subset of `links` a link edit may rewrite — see GedEvent.editableLinks. */
  editableLinks?: string[];
  /** Free-text NOTE records attached directly to the family. */
  notes?: string[];
  /** The same notes with their URLs kept in place (see {@link Individual.notesWithLinks}). */
  notesWithLinks?: string[];
  /** Editable note references (see {@link Individual.noteRefs}). */
  noteRefs?: NoteRef[];
  /** Source citations (`SOUR`) attached directly to the family (not to a specific event). */
  sources?: SourceCitation[];
  /** Record flagged private (see {@link NoteRef.private} for the dialects). */
  private?: boolean;
  raw: GedNode;
}

/**
 * Whether the main GEDCOM file uses CHAN/CREA audit timestamps, detected on
 * load. Drives whether `stampChanCrea` writes them into the saved output.
 */
export interface ChanCreaUsage {
  /** Any INDI or FAM record has a direct CHAN child. */
  recordChan: boolean;
  /** Any INDI or FAM record has a direct CREA child. */
  recordCrea: boolean;
  /** Any event node under an INDI/FAM has a direct CHAN child. */
  eventChan: boolean;
  /** Any event node under an INDI/FAM has a direct CREA child. */
  eventCrea: boolean;
  /**
   * Which MyHeritage `_UPD` change stamp the file writes on its INDI/FAM
   * records, if any: the `1 _UPD <timestamp>` tag, or the older event
   * spelling (`1 EVEN <timestamp>` + `2 TYPE _UPD`). `false` when the file
   * uses neither. A file that stamps its records this way has them refreshed
   * on save exactly as a CHAN file does, so its own convention stays true
   * rather than going stale on the records this app touched.
   */
  recordUpd: false | "tag" | "event";
}

/** Fully-built, version-agnostic dataset ready for matching and display. */
export interface Dataset {
  version: GedcomVersion;
  charset: GedcomCharset;
  individuals: Map<string, Individual>;
  families: Map<string, Family>;
  records: GedNode[];
  warnings: ParseWarning[];
  /** Original line-ending ("\n" or "\r\n"), preserved for faithful round-trip. */
  eol: string;
  /** Whether the source ended with a trailing newline. */
  finalNewline: boolean;
  /** Detected CHAN/CREA usage — governs whether save stamps audit timestamps. */
  chanCreaUsage: ChanCreaUsage;
  /**
   * Set on datasets imported from a source whose format doesn't reliably carry
   * birth dates (the genealogical-index matches CSV, whose family rows often
   * record only a marriage date). Matching uses it to scope the marriage-based
   * birth plausibility fallback: only a record from such a source may
   * substitute marriage-year plausibility for a missing birth date. For a
   * regular GEDCOM a missing birth date is a data gap, and the flat
   * missing-key penalty stands.
   */
  sparseBirthDates?: boolean;
}
