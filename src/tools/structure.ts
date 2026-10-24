import type { Dataset, GedDate, GedNode, ParseWarning } from "../gedcom/types";
import { parseDate } from "../gedcom/date";
import { vendorTagInfo } from "../gedcom/vendorTags";
import { isVoidPointer } from "../gedcom/uri";
import type { FormatOverrides } from "../normalize/formatOverrides";
import { dateFixContext, dateStyleContext, isUnparseable, nonStandardDate, proposeDateFix } from "./fixDates";
import { firstChild } from "../gedcom/node";
import { validateConformance, type ConformanceCategory } from "./conformance/conformance";

/**
 * GEDCOM structural ("spec") validation — a pass over the raw `GedNode` tree and
 * the parser's `ParseWarning`s, rather than the typed domain model.
 *
 * The record-level health check (`validate.ts`) only sees what survived parsing
 * into `Individual`/`Family`. Malformed *lines* — unparsable syntax, bad level
 * numbering, stray CONT/CONC, an encoding glitch, an unknown tag, a date that
 * doesn't parse — never reach it. Many of these are already detected at parse/
 * decode time and stashed in `dataset.warnings`; this pass surfaces them and adds
 * two fresh GedNode-level checks (unknown tags, unparseable dates).
 *
 * Pure and synchronous: it reads only data already on `Dataset` (`records` +
 * `warnings`), so it stays a main-thread tool like the rest of `src/tools/`.
 */

export type StructCategory =
  | "encoding"
  | "syntax"
  | "level"
  | "strayCont"
  | "danglingXref"
  | "duplicateXref"
  | "version"
  | "unknownTag"
  | "customTag"
  | "badDate"
  | "impossibleDate"
  | "reversedRange"
  | "shortYear"
  | "nonStandardDate"
  | "ambiguousDate"
  | ConformanceCategory;

export type StructSeverity = "error" | "warning" | "info";

/** Sort weight per severity — errors first, informational (custom tags) last. */
const SEV_RANK: Record<StructSeverity, number> = { error: 0, warning: 1, info: 2 };

export interface StructIssue {
  category: StructCategory;
  severity: StructSeverity;
  /** i18n key for the message, with optional interpolation values. */
  messageKey: string;
  messageVars?: Record<string, string | number>;
  /** Source line number, for text-level issues folded in from the parser. */
  line?: number;
  /** Enclosing level-0 record xref, when known — the navigate target. */
  recordId?: string;
  /** The enclosing level-0 record's tag (INDI/FAM/SOUR/…), to identify its type. */
  recordTag?: string;
  /** The offending value/tag, truncated for display. */
  sample?: string;
  /** The actual problematic line(s), for a hover tooltip — the reconstructed
   *  GEDCOM line for a tree-walk issue, or the parser's message + line number. */
  tooltip?: string;
  /** For a repairable `badDate` or `nonStandardDate`: the value the one-click
   *  fix would write, so the row can flag itself fixable and preview the result. */
  fix?: string;
  /** Conformance findings: the child-index path from the record to the line
   *  ("3.1"), which is how the fix finds the line again. */
  path?: string;
  /** Conformance `cardinality`: every repeat is an exact copy of the first,
   *  so the fix can drop them without losing anything. */
  repeat?: boolean;
  /** Conformance `badY`: `fix` is the event line's text, which the fix moves
   *  into a NOTE on the event. */
  toNote?: boolean;
  /** Conformance `misplacedTag`: a media record's TITL/FORM beside its FILE,
   *  which the fix moves under it file-wide. */
  relocate?: boolean;
  /** Conformance `misplacedTag`: a source's own AGNC, which the fix moves to
   *  DATA.AGNC file-wide. */
  agency?: boolean;
  /** Conformance `misplacedTag`: every CHAN/CREA below a record, which the
   *  fix lifts onto the record file-wide. */
  stamps?: boolean;
  /** Conformance `misplacedTag`: a source's flat PLAC/DATE, which the fix
   *  restates as DATA > EVEN file-wide. */
  coverage?: boolean;
  /** Conformance `misplacedTag`: a DATE on an association, which the fix
   *  keeps as the association's NOTE file-wide. */
  assoDate?: boolean;
  /** Conformance: MyHeritage's Smart Match citations, whose id the fix keeps
   *  as the citation's PAGE file-wide. */
  smartMatch?: boolean;
  /** Conformance `misplacedTag`: a media record's DATE/PLAC, kept by the fix
   *  as `_DATE`/`_PLACE` file-wide. */
  mediaInfo?: boolean;
  /** Conformance `misplacedTag`: a PEDI on FAM.CHIL, moved by the fix to the
   *  child's FAMC file-wide. */
  childPedi?: boolean;
  /** Set by the findings list on the one row it shows for many equal value
   *  fixes (same line, same value, same fix): how many it stands for. */
  groupCount?: number;
}

export interface StructureReport {
  issues: StructIssue[];
  /** Per-category counts, for the summary header. */
  counts: Record<StructCategory, number>;
}

const EMPTY_COUNTS: Record<StructCategory, number> = {
  encoding: 0,
  syntax: 0,
  level: 0,
  strayCont: 0,
  danglingXref: 0,
  duplicateXref: 0,
  version: 0,
  unknownTag: 0,
  customTag: 0,
  badDate: 0,
  impossibleDate: 0,
  reversedRange: 0,
  shortYear: 0,
  nonStandardDate: 0,
  ambiguousDate: 0,
  pointerType: 0,
  cardinality: 0,
  missingLine: 0,
  misplacedTag: 0,
  enumValue: 0,
  valueFormat: 0,
  xrefShape: 0,
};

/**
 * Tags we recognise — the union of every tag GEDCOM 5.5.1, 5.5.5 and 7.0 define
 * (record, substructure, and event tags), audited against each specification's
 * full tag list. Vendor extensions are `_`-prefixed and handled separately, so
 * they never need to appear here. A tag outside this set isn't necessarily
 * illegal, but it's worth surfacing as "unknown".
 */
export const KNOWN_TAGS = new Set<string>([
  // Records / top level
  "HEAD", "TRLR", "INDI", "FAM", "SOUR", "REPO", "OBJE", "NOTE", "SNOTE", "SUBM", "SUBN",
  // Header
  "GEDC", "VERS", "FORM", "CHAR", "LANG", "DEST", "FILE", "COPR", "SCHMA", "TAG", "CORP",
  // Names
  "NAME", "NPFX", "GIVN", "NICK", "SPFX", "SURN", "NSFX", "FONE", "ROMN", "TYPE", "TRAN",
  // Sex / family links / interest
  "SEX", "FAMC", "FAMS", "HUSB", "WIFE", "CHIL", "PEDI", "STAT", "NCHI", "NMR", "ADOP",
  "ANCI", "DESI", "ANCE", "DESC",
  // Individual events
  "BIRT", "CHR", "DEAT", "BURI", "CREM", "BAPM", "BARM", "BASM", "BLES", "CHRA",
  "CONF", "FCOM", "ORDN", "NATU", "EMIG", "IMMI", "CENS", "PROB", "WILL", "GRAD",
  "RETI", "EVEN", "BAPL", "CONL", "ENDL", "SLGC", "INIL",
  // Latter-day Saint ordinance detail: the temple code (5.5.1 + 7.0), and
  // 5.5.1's SUBN ordinance-processing flag and family file name
  "TEMP", "ORDI", "FAMF",
  // A pointer to another INDI record believed to be the same person
  "ALIA",
  // Continuation lines — folded into their value at parse time, listed so a
  // caller asking about a tag by name never reads them as unknown
  "CONT", "CONC",
  // Individual attributes
  "CAST", "DSCR", "EDUC", "IDNO", "NATI", "OCCU", "PROP", "RELI", "RESI", "SSN",
  "TITL", "FACT",
  // Family events
  "MARR", "MARB", "MARC", "MARL", "MARS", "ANUL", "DIV", "DIVF", "ENGA", "SLGS",
  // Event / citation detail
  "DATE", "TIME", "PLAC", "ADDR", "ADR1", "ADR2", "ADR3", "CITY", "STAE", "POST", "CTRY",
  "PHON", "EMAIL", "FAX", "WWW", "AGNC", "CAUS", "AGE", "ASSO", "RELA", "RESN",
  "MAP", "LATI", "LONG", "EXID", "PHRASE", "SDATE", "NO",
  // Source / citation. GEDCOM 5.5-EL's PERI, FILN and EDTN are in neither
  // standard: the vendor registry names them, so they show as a program's own.
  "PAGE", "DATA", "TEXT", "QUAY", "ROLE", "AUTH", "PUBL", "ABBR",
  "REFN", "RIN", "MEDI", "CALN",
  // Multimedia (BLOB is deprecated 5.5 but still seen). CROP + TOP/LEFT/HEIGHT/
  // WIDTH are the GEDCOM 7 multimedia-link crop region (a subregion of an image
  // that depicts the linking record — e.g. one person marked in a group photo).
  "BLOB", "CROP", "TOP", "LEFT", "HEIGHT", "WIDTH",
  // 7.0: a note's media type (text/plain, text/html) under NOTE/SNOTE/TRAN
  "MIME",
  // Change / creation audit; identifiers
  "CHAN", "CREA", "UID", "RFN", "AFN",
]);

function truncate(s: string, n = 60): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** Reconstruct the raw GEDCOM line a node came from, for the hover tooltip. */
function nodeLine(node: GedNode): string {
  const xref = node.xref ? ` ${node.xref}` : "";
  // Collapse folded CONT newlines so the tooltip stays one readable line.
  const value = node.value != null ? ` ${node.value.replace(/\n/g, " ⏎ ")}` : "";
  return `${node.level}${xref} ${node.tag}${value}`;
}

/** Map a parser/decoder `ParseWarning` to a structural issue (text-level, line-based). */
function fromWarning(w: ParseWarning): StructIssue | undefined {
  // The parser's message already embeds the offending line/context; pair it with
  // the line number for the tooltip.
  const tooltip = w.line != null ? `${w.message} (line ${w.line})` : w.message;
  const base = { line: w.line, tooltip, messageKey: "tools.validate.struct.issue.parse", messageVars: { detail: w.message } };
  switch (w.kind) {
    case "encoding":
      return { ...base, category: "encoding", severity: "warning" };
    case "syntax":
      return { ...base, category: "syntax", severity: "error" };
    case "version":
      return { ...base, category: "version", severity: "warning" };
    case "structure": {
      // Structure warnings cover three cases, told apart by the message: a
      // stray CONT/CONC with no parent, a duplicate record xref (from
      // buildDataset), and a line whose level skips its parent.
      if (/CONT|CONC/.test(w.message)) return { ...base, category: "strayCont", severity: "error" };
      if (w.message.startsWith("Duplicate xref")) return { ...base, category: "duplicateXref", severity: "error" };
      return { ...base, category: "level", severity: "error" };
    }
    default:
      // "unknown-tag" / "date" / "place" are detected by our own tree walk below.
      return undefined;
  }
}

/** One missing pointer target: every occurrence of a pointer to a record that doesn't exist. */
export interface DanglingXref {
  /** The referenced-but-undefined xref, e.g. "@N12@". */
  xref: string;
  /** How many pointer lines reference it. */
  count: number;
  /** The tag of the first pointer line seen (SOUR, NOTE, OBJE, ASSO, …). */
  tag: string;
  /** Enclosing level-0 record of the first occurrence, for navigation. */
  recordId?: string;
  recordTag?: string;
  /** Reconstructed first offending line, for a hover tooltip. */
  tooltip: string;
  /** True while every occurrence is a family link the record-level check owns
   *  (see {@link isFamilyLinkPointer}) — those are reported, and repaired, as
   *  `brokenLink` findings instead. */
  familyLinkOnly: boolean;
}

/** Is this pointer a family link sitting directly on an INDI/FAM record?
 *
 *  `validateDataset`'s `brokenLink` check reports exactly these, and
 *  `fixBrokenLinks` repairs them (it also sees the one-way links a pure xref
 *  scan can't). So the structure pass hides them and `fixDanglingRefs` leaves
 *  them alone, rather than listing and removing the same line twice. A `FAMC`
 *  deeper in the tree — under an `ADOP` event, say — is nobody else's, and
 *  stays in scope here. */
export function isFamilyLinkPointer(recordTag: string | undefined, tag: string, depth: number): boolean {
  if (depth !== 1) return false;
  if (recordTag === "INDI") return tag === "FAMC" || tag === "FAMS";
  if (recordTag === "FAM") return tag === "HUSB" || tag === "WIFE" || tag === "CHIL";
  return false;
}

/** Is this node's value a pointer (`@X1@`) rather than plain text? "@#…@" is a
 *  GEDCOM escape (e.g. a DATE calendar escape), not a pointer, and `@VOID@` is
 *  the 7.0 null pointer — it names no record, so it can never dangle. */
export function isPointerValue(value: string | undefined): value is string {
  const v = value?.trim();
  return !!v && /^@[^@]+@$/.test(v) && !v.startsWith("@#") && !isVoidPointer(v);
}

/**
 * Find every pointer value (`@xref@`) whose target record does not exist,
 * grouped by missing xref. Covers all standard-tag pointers anywhere in the
 * tree — SOUR/NOTE/OBJE citations, ASSO/ALIA associations, HEAD.SUBM, … —
 * including the family links the record-level check owns, which carry
 * `familyLinkOnly` so a caller can leave those to it (the save-time gate
 * doesn't: it must catch every dangling pointer in what's about to be written).
 * Vendor-extension (`_`) subtrees are skipped: their values follow the
 * vendor's own vocabulary, not ours to audit. Pure; also used as the
 * save-time consistency check on the records about to be downloaded.
 */
export function findDanglingXrefs(records: GedNode[]): DanglingXref[] {
  const defined = new Set<string>();
  for (const r of records) if (r.xref) defined.add(r.xref);

  const missing = new Map<string, DanglingXref>();
  const visit = (node: GedNode, depth: number, recordId?: string, recordTag?: string): void => {
    if (node.tag.startsWith("_")) return;
    const v = node.value?.trim();
    if (isPointerValue(v) && !defined.has(v)) {
      const familyLink = isFamilyLinkPointer(recordTag, node.tag, depth);
      const seen = missing.get(v);
      if (seen) {
        seen.count++;
        seen.familyLinkOnly &&= familyLink;
      } else {
        missing.set(v, {
          xref: v, count: 1, tag: node.tag, recordId, recordTag,
          tooltip: nodeLine(node), familyLinkOnly: familyLink,
        });
      }
    }
    for (const child of node.children) visit(child, depth + 1, recordId, recordTag);
  };
  for (const rec of records) visit(rec, 0, rec.xref, rec.tag);
  return [...missing.values()];
}

/**
 * Bare field tags declared by the file's own MacFamilyTree source-template
 * field records:
 *
 *     0 @TF7@ _STF
 *     1 _NKY SourceTemplate_KeyName_Cemetery
 *     1 _TAG CEME
 *
 * A source built from such a template writes the field value as a bare
 * level-1 tag (`1 CEME Pokopališče Zgornje Bitnje`), so the declared tags are
 * part of the file's own vocabulary — classify them from the declaration
 * instead of flagging them as unknown. Returns tag → readable field name
 * derived from the `_NKY` key ("MicrofilmRollNumber" → "microfilm roll
 * number"). Place-template fields (`_PTF`) are skipped: their `_TAG` values
 * are localized place-part labels ("Gemeinde"), never emitted as GEDCOM tags.
 */
function templateFieldTags(records: GedNode[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const rec of records) {
    if (rec.tag !== "_STF") continue;
    const tag = firstChild(rec, "_TAG")?.value?.trim();
    // Only tag-shaped declarations, and never shadow a standard tag.
    if (!tag || !/^[A-Z][A-Z0-9_]{2,14}$/.test(tag) || KNOWN_TAGS.has(tag)) continue;
    const key = firstChild(rec, "_NKY")?.value?.trim();
    const name = key?.split("_").pop()?.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    fields.set(tag, name || tag);
  }
  return fields;
}

/** A range whose second end comes before its first (`BET 1860 AND 1850`). An
 *  end missing a month or a day is compared at the precision both share. */
function isReversedRange(d: GedDate): boolean {
  if (d.qualifier !== "between" && d.qualifier !== "range") return false;
  const from = [d.year, d.month, d.day];
  const to = [d.year2, d.month2, d.day2];
  for (let i = 0; i < 3; i++) {
    const a = from[i];
    const b = to[i];
    if (a === undefined || b === undefined) return false;
    if (a !== b) return b < a;
  }
  return false;
}

export function validateStructure(ds: Dataset, overrides?: FormatOverrides): StructureReport {
  const issues: StructIssue[] = [];
  const counts: Record<StructCategory, number> = { ...EMPTY_COUNTS };

  const push = (issue: StructIssue) => {
    issues.push(issue);
    counts[issue.category]++;
  };

  // (a) Fold in what the parser/decoder already caught at load time.
  for (const w of ds.warnings) {
    const issue = fromWarning(w);
    if (issue) push(issue);
  }

  // The file's date house style, so a fixable bad date can preview the value the
  // one-click fix would write (in the file's own format).
  const fixCtx = dateFixContext(ds);
  // The format a date is held to: the file's own, or the one chosen in
  // Settings → GEDCOM — the same the non-standard date fix writes.
  const styleCtx = dateStyleContext(ds, overrides);

  // (b) Walk the raw tree once for unknown tags and unparseable dates, tracking
  //     the enclosing level-0 record so deep issues can navigate to it.
  //     Unknown tags are de-duplicated per tag (one issue, with an occurrence
  //     count and the first place it was seen) to avoid flooding the list.
  type TagTally = { count: number; recordId?: string; recordTag?: string; tooltip: string };
  const unknown = new Map<string, TagTally>();
  // Every distinct vendor-extension (`_`) tag, with its occurrence count — an
  // inventory so the user can see what non-standard tags a file carries, rather
  // than the validator silently ignoring them.
  const custom = new Map<string, TagTally>();

  // Field tags the file's own MacFamilyTree source templates declare — the
  // file's vocabulary, so classified custom rather than unknown.
  const templateFields = templateFieldTags(ds.records);

  const tally = (map: Map<string, TagTally>, tag: string, node: GedNode, recordId?: string, recordTag?: string) => {
    const seen = map.get(tag);
    if (seen) seen.count++;
    else map.set(tag, { count: 1, recordId, recordTag, tooltip: nodeLine(node) });
  };

  // `stamp`: inside a CHAN/CREA change stamp, whose date the program writes
  // for itself — its format is the program's, not a style the user keeps.
  const visit = (node: GedNode, recordId?: string, recordTag?: string, stamp = false) => {
    const tag = node.tag;
    // A vendor extension (`_FOO`) marks the root of a vendor-defined subtree: record
    // the outermost one in the inventory and skip the whole subtree from any further
    // validation. Everything beneath it — nested `_` tags, standard-looking tags
    // (e.g. `COLR` under `_LABL`), even dates — is the vendor's own vocabulary
    // (MacFamilyTree's `_STF` source templates, `_STO` storage, `_LABL` labels, …),
    // not ours to audit. CONT/CONC are folded by the parser, so never appear here.
    if (tag.startsWith("_")) {
      tally(custom, tag, node, recordId, recordTag);
      return;
    }
    if (!KNOWN_TAGS.has(tag)) {
      // A bare (non-`_`) tag the vendor registry knows (MacFamilyTree's RACE/
      // SECG/MISE/…) or the file's own source templates declare is that
      // program's own data, not a spec violation — report it as a classified
      // custom tag, info-severity, like its `_` siblings.
      // Its subtree still validates normally (unlike `_` subtrees).
      if (vendorTagInfo(tag) || templateFields.has(tag)) tally(custom, tag, node, recordId, recordTag);
      else tally(unknown, tag, node, recordId, recordTag);
    }

    if (tag === "DATE" && node.value && node.value.trim()) {
      const d = parseDate(node.value);
      // No date to read in it (see isUnparseable): a deliberate ".__.____"
      // placeholder and a "(date phrase)" are fine.
      if (isUnparseable(node.value)) {
        // If the one-click fix could safely repair it, preview the result in the
        // tooltip and mark the row fixable.
        const fix = proposeDateFix(node.value, fixCtx);
        push({
          category: "badDate",
          severity: "warning",
          recordId,
          recordTag,
          sample: truncate(node.value),
          tooltip: fix ? `${nodeLine(node)} → ${fix}` : nodeLine(node),
          fix,
          messageKey: "tools.validate.struct.issue.badDate",
          messageVars: { sample: truncate(node.value) },
        });
      } else {
        const flag = (category: StructCategory, severity: StructSeverity, fix?: string) =>
          push({
            category,
            severity,
            recordId,
            recordTag,
            sample: truncate(node.value!),
            tooltip: fix ? `${nodeLine(node)} → ${fix}` : nodeLine(node),
            fix,
            messageKey: `tools.validate.struct.issue.${category}`,
            messageVars: { sample: truncate(node.value!) },
          });
        // Readable, but naming a day its month does not have (31 FEB). Which
        // part is wrong is a question for the record, so there is no fix —
        // nor for the two below, whose right reading only the source knows.
        if (d.impossible) flag("impossibleDate", "warning");
        if (isReversedRange(d)) flag("reversedRange", "warning");
        if (d.shortYear) flag("shortYear", "warning");
        // A sound date written outside the standard (or the chosen format): one
        // with a single reading carries the fix that restyles it; one whose day
        // and month could swap is the user's to settle.
        if (!stamp) {
          const verdict = nonStandardDate(node.value, styleCtx);
          if (verdict?.kind === "fix") flag("nonStandardDate", "warning", verdict.next);
          else if (verdict?.kind === "ambiguous") flag("ambiguousDate", "warning");
        }
      }
    }

    for (const child of node.children) visit(child, recordId, recordTag, stamp || tag === "CHAN" || tag === "CREA");
  };

  for (const rec of ds.records) visit(rec, rec.xref, rec.tag);

  // (c) Pointers into nowhere: references to records that don't exist. Family
  //     links on an INDI/FAM are the record-level check's ("Broken links",
  //     which has its own fix and also sees one-way links), so they're not
  //     repeated here.
  for (const d of findDanglingXrefs(ds.records)) {
    if (d.familyLinkOnly) continue;
    push({
      category: "danglingXref",
      severity: "error",
      recordId: d.recordId,
      recordTag: d.recordTag,
      sample: d.xref,
      tooltip: d.tooltip,
      messageKey: "tools.validate.struct.issue.danglingXref",
      messageVars: { tag: d.tag, xref: d.xref, count: d.count },
    });
  }

  for (const [tag, { count, recordId, recordTag, tooltip }] of unknown) {
    push({
      category: "unknownTag",
      severity: "warning",
      recordId,
      recordTag,
      sample: tag,
      tooltip,
      messageKey: "tools.validate.struct.issue.unknownTag",
      messageVars: { tag, count },
    });
  }

  for (const [tag, { count, recordId, recordTag, tooltip }] of custom) {
    // A tag the vendor-extension registry knows gets a classified message
    // ("MyHeritage — last-updated timestamp") instead of the opaque inventory
    // line. Both language variants of the meaning travel as interpolation vars
    // so this stays a pure, i18n-free pass.
    const field = templateFields.get(tag);
    const info = vendorTagInfo(tag) ?? (field !== undefined
      ? {
          software: "MacFamilyTree",
          category: "citation" as const,
          meaning: { en: `source-template field (${field})`, sl: `polje predloge vira (${field})` },
        }
      : undefined);
    push({
      category: "customTag",
      severity: "info",
      recordId,
      recordTag,
      sample: tag,
      tooltip,
      messageKey: info ? "tools.validate.struct.issue.customTagKnown" : "tools.validate.struct.issue.customTag",
      messageVars: info
        ? { tag, count, software: info.software, meaningEn: info.meaning.en, meaningSl: info.meaning.sl }
        : { tag, count },
    });
  }

  // (d) The file held against the structure table of the GEDCOM version it
  //     declares: line counts, tag placement, pointer targets, enumerated values.
  for (const issue of validateConformance(ds)) push(issue);

  // Errors first, then by category, then by line (text issues) / sample.
  const CATEGORY_ORDER: StructCategory[] = ["encoding", "syntax", "level", "strayCont", "danglingXref", "duplicateXref", "pointerType", "version", "unknownTag", "misplacedTag", "cardinality", "missingLine", "enumValue", "valueFormat", "xrefShape", "badDate", "impossibleDate", "reversedRange", "shortYear", "nonStandardDate", "ambiguousDate", "customTag"];
  issues.sort((a, b) => {
    if (a.severity !== b.severity) return SEV_RANK[a.severity] - SEV_RANK[b.severity];
    if (a.category !== b.category) return CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    if (a.line != null && b.line != null) return a.line - b.line;
    return (a.sample ?? "").localeCompare(b.sample ?? "");
  });

  return { issues, counts };
}
