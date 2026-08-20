// Renders planned narrative statements (report/narrative.ts) as prose, one
// sentence per statement, via the locale's narrative.* templates plus the
// language pack's closed-class grammar (report/lang/*). Kept pure so the
// paragraph is unit-testable and shared verbatim by the page, the text
// download and the print sheet.
//
// Template resolution uses i18next context: the key's suffix encodes the
// grammatical situation — the sex (M/F, gendered verb forms in Slovenian)
// plus "p" for the short-subject form (English pronoun / Slovenian verb-first
// clause, which can't start with the clitic "se je"). English defines only
// base keys (context falls through); people of unknown sex always render the
// name-form base key ("rodil/-a se je").

import type { Translate } from "../locales/i18n";
import type { Sex } from "../gedcom/types";
import type { FactLine, ReportEntry, SourceLine } from "./model";
import type { Statement } from "./narrative";
import type { NarrativeLang } from "./lang/types";
import { narrativeEn } from "./lang/en";
import { narrativeSl } from "./lang/sl";

/** The narrative grammar for a UI language (report language = UI language). */
export function narrativeLangFor(lang: string): NarrativeLang {
  return lang.startsWith("sl") ? narrativeSl : narrativeEn;
}

/** An entry's narrative with notes and sources folded in NGSQ-style:
 *  superscript markers on the sentences, one numbered footnote list under the
 *  entry. Short event notes read inline as asides; long ones become footnotes
 *  alongside the source citations, so every note stays tied to its sentence. */
export interface NarrativeEntryText {
  /** The prose paragraph, footnote markers and inline notes included. */
  paragraph: string;
  /** Footnotes in marker order — footnote i renders as `citationMark(i + 1)`.
   *  Record-level sources come first, attached to the opening sentence. */
  footnotes: NarrativeFootnote[];
}

/** One numbered footnote: a source citation, or a long event note. */
export type NarrativeFootnote = { source: SourceLine; note?: never } | { note: string; source?: never };

/** Notes up to this long (and single-line) join the prose parenthetically. */
const NOTE_INLINE_MAX = 160;

/** A thin space separates neighbouring markers ("¹ ²" can't read as "12"). */
const MARK_JOIN = " ";

export function narrativeEntry(
  t: Translate,
  lang: NarrativeLang,
  entry: ReportEntry,
  statements: Statement[],
): NarrativeEntryText {
  const footnotes: NarrativeFootnote[] = [];
  const seen = new Map<string, number>();
  // The same source cited twice keeps its first number (poor man's ibid.).
  const cite = (src: SourceLine): number => {
    const key = `${src.text}\0${src.page ?? ""}\0${src.url ?? ""}`;
    let n = seen.get(key);
    if (n === undefined) {
      footnotes.push({ source: src });
      seen.set(key, (n = footnotes.length));
    }
    return n;
  };

  const sentences = statements.map((stmt, i) => {
    const s = narrativeSentence(t, lang, entry, stmt);
    // Markers after the full stop: the record-level citations open the story,
    // each fact's citations follow the sentence that tells it; a long note
    // becomes the sentence's last footnote, a short one an inline aside.
    const sources = [
      ...(i === 0 ? (entry.sources ?? []) : []),
      ...(stmt.fact?.sources ?? []),
      ...(stmt.fact2?.sources ?? []),
    ];
    const marks = sources.map((src) => citationMark(cite(src)));
    const asides: string[] = [];
    for (const note of [stmt.fact?.note, stmt.fact2?.note]) {
      if (!note) continue;
      if (!note.includes("\n") && note.length <= NOTE_INLINE_MAX) asides.push(` (${note})`);
      else marks.push(citationMark(footnotes.push({ note })));
    }
    return s + marks.join(MARK_JOIN) + asides.join("");
  });
  // No prose at all (nothing but record-level citations): keep the sources
  // in the list so the data still exports, markerless.
  if (sentences.length === 0) for (const src of entry.sources ?? []) cite(src);

  return { paragraph: sentences.join(" "), footnotes };
}

/** Just the prose, for callers (and tests) that need no citation list. */
export function narrativeParagraph(
  t: Translate,
  lang: NarrativeLang,
  entry: ReportEntry,
  statements: Statement[],
): string {
  return narrativeEntry(t, lang, entry, statements).paragraph;
}

const SUPERSCRIPT_DIGITS = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];

/** A 1-based citation number as superscript digits: 1 → "¹", 12 → "¹²". */
export function citationMark(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUPERSCRIPT_DIGITS[Number(d)])
    .join("");
}

export function narrativeSentence(t: Translate, lang: NarrativeLang, entry: ReportEntry, stmt: Statement): string {
  // Unknown sex always names the person — neither language has a safe
  // unknown-sex short form ("they was", clitic-first Slovenian).
  const named = stmt.subject === "name" || entry.sex === "U";
  // The spouse-origin sentence is about the partner, so its gendered forms
  // (possessive / kin word) follow the partner's sex, never the entry's; an
  // unknown-sex partner falls through to the neutral base key.
  const context =
    stmt.kind === "spouseOrigin"
      ? stmt.spouseSex === "M" || stmt.spouseSex === "F"
        ? stmt.spouseSex
        : undefined
      : `${entry.sex}${named ? "" : "p"}`;
  const raw = t(`narrative.${keyOf(stmt)}`, {
    context,
    subject: named ? entry.name : lang.pronoun(entry.sex),
    tail: tailOf(t, stmt.fact, lang, entry.sex),
    tail2: tailOf(t, stmt.fact2, lang, entry.sex),
    value: stmt.fact?.value ?? "",
    spouse: stmt.spouse ?? "",
    father: stmt.father ?? "",
    mother: stmt.mother ?? "",
    children: stmt.childNames ? lang.childCount(stmt.childNames.length) : "",
    names: stmt.childNames ? lang.nameList(stmt.childNames) : "",
  });
  return polish(raw);
}

/** The template key for a statement — most kinds map 1:1, the rest split on
 *  what the data offers (spouse known, occupation value, burial vs cremation). */
function keyOf(stmt: Statement): string {
  // Repeated residences/occupations vary their opening: "residenceThen",
  // "occupationThen", … (see Statement.variant).
  const varied = (base: string) =>
    stmt.variant ? `${base}${stmt.variant.charAt(0).toUpperCase()}${stmt.variant.slice(1)}` : base;
  // Present-tense variants for the presumed living ("njegova žena je" vs
  // "je bila", "imata" vs "imela sta").
  const tensed = (base: string) => (stmt.living ? `${base}Living` : base);
  switch (stmt.kind) {
    case "married":
      if (stmt.spouse) return tensed(stmt.again ? "marriedAgain" : "married");
      return stmt.again ? "marriedAgainNoSpouse" : "marriedNoSpouse";
    case "spouseOrigin":
      // Which parents are named picks the sentence; `living` is the named
      // parents' tense here (the planner set it), not the couple's.
      return tensed(stmt.father && stmt.mother ? "spouseOriginBoth" : stmt.father ? "spouseOriginFather" : "spouseOriginMother");
    case "children":
      return tensed(stmt.couple ? "childrenCouple" : "childrenSolo");
    case "occupation":
      return stmt.fact?.value ? varied("occupation") : "occupationNoValue";
    case "education":
      return stmt.fact?.value ? "education" : "educationNoValue";
    case "residence":
      return varied("residence");
    case "buried":
      return stmt.fact?.tag === "CREM" ? "cremated" : "buried";
    case "diedBuried":
      return stmt.fact2?.tag === "CREM" ? "diedCremated" : "diedBuried";
    default:
      return stmt.kind;
  }
}

/** The sentence's when-and-where(-and-by-whom): "on 5 May 1848 in Škofja
 *  Loka at Župnija Stražišče (vzrok: …)". Facts are gated on having a date or
 *  a place, so a vitals tail is never empty; the optional facts' templates
 *  tolerate an empty one (polish() tidies up). */
function tailOf(t: Translate, f: FactLine | undefined, lang: NarrativeLang, sex: Sex): string {
  if (!f) return "";
  const date = f.parsed ? lang.datePhrase(f.parsed) : (f.date ?? "");
  // Age next to the date: the sex-tagged pair on a marriage / birth ("♂32 ♀28"),
  // or the subject's own gendered age otherwise ("age 40" / "star 40 let").
  const age = f.ages?.length
    ? `(${f.ages.join(" ")})`
    : f.age !== undefined
      ? `(${t("tree.node.agePhrase", { context: sex === "M" || sex === "F" ? sex : undefined, age: f.age })})`
      : "";
  // Prose place: the cleaned hierarchy (duplicate jurisdictions dropped,
  // commas re-spaced) framed by the language; the verbatim string is only a
  // fallback for facts built without the structured fields.
  const loc = f.placeParts ? cleanParts(f.placeParts) : f.addr ? undefined : f.place;
  const place = f.addr || loc ? lang.placePhrase(f.addr, loc) : "";
  // The event's AGNC (parish, school, office) and CAUS (cause of death), in
  // localized nominative-safe frames.
  const agency = f.agency ? t("narrative.agency", { agency: f.agency }) : "";
  const cause = f.cause ? t("narrative.cause", { cause: f.cause }) : "";
  return [date, age, place, agency, cause].filter(Boolean).join(" ");
}

/** "Kranj,Kranj,Slovenia" arrives as parts — drop empty and repeated
 *  jurisdictions ("Kranj, Kranj" → "Kranj") and rejoin with normal spacing. */
function cleanParts(parts: string[]): string | undefined {
  const out: string[] = [];
  for (const part of parts) {
    const p = part.trim();
    if (!p) continue;
    if (out.length && out[out.length - 1].toLowerCase() === p.toLowerCase()) continue;
    out.push(p);
  }
  return out.join(", ") || undefined;
}

/** Tidy a filled template: collapse the gaps empty slots leave behind, then
 *  capitalize — which is what lets Slovenian short-form templates interpolate
 *  an empty {{subject}} and still start the sentence properly. */
function polish(s: string): string {
  const cleaned = s
    .replace(/\s+/g, " ")
    .replace(/ ([.,;:!?])/g, "$1")
    .trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
