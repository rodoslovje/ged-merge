// RTF rendering of the reports (Ahnentafel / descendant register), for the
// Export ▾ → RTF download. Same content as the text export in a styled
// word-processor document (Word / LibreOffice / Pages): generation headings,
// "Children of …" group headings, numbered entries with a hanging indent,
// indented fact lines, italic notes and clickable source links. Pure string
// builder so it's unit-testable; the print sheet (ReportView.printDoc) is the
// visual reference for sizes and colours.

import type { Translate } from "../locales/i18n";
import { generationHeading, sourceLabel, tocRows, truncationNote, type ReportData, type ReportEntry, type SourceLine } from "./model";
import { childrenOfLabel, entryNum, factText, reportName, type ReportTextOptions } from "./text";
import { citationMark } from "./narrativeText";

/** Hanging indent for entry bodies, in twips (~0.42" ≈ the page's 2.6em). */
const INDENT = 600;
/** Extra step for a fact's own note/source lines. */
const NESTED = INDENT + 240;

// Colour-table indices (see the \colortbl in reportToRtf).
const CF_FACT = 1; // #222
const CF_MUTED = 2; // #444 — years, dup refs, notes, heading meta
const CF_SOURCE = 3; // #555
const CF_LINK = 4; // #1a4b7a

export function reportToRtf(
  t: Translate,
  data: ReportData,
  direction: "ancestors" | "descendants",
  title: string,
  opts: ReportTextOptions = {},
): string {
  const parts: string[] = [para("\\sa240\\b\\fs30", esc(title))];
  if (opts.toc) {
    // Each row jumps to its generation heading's bookmark (see genBookmark).
    parts.push(para("\\sa100\\b\\fs24", esc(t("report.toc"))));
    for (const row of tocRows(t, data, direction)) {
      parts.push(
        para(
          `\\li${INDENT}\\sa20\\cf${CF_FACT}`,
          `{\\field{\\*\\fldinst{HYPERLINK \\\\l "${genBookmark(row.gen)}"}}{\\fldrslt ${esc(row.label)}}}`,
        ),
      );
    }
  }
  for (const g of data.generations) {
    const h = generationHeading(t, g, direction);
    const meta = [h.range, h.coverage].filter(Boolean).map((s) => `· ${s}`).join(" ");
    const mark = opts.toc ? `{\\*\\bkmkstart ${genBookmark(g.gen)}}{\\*\\bkmkend ${genBookmark(g.gen)}}` : "";
    parts.push(
      para(
        "\\sb240\\sa100\\brdrb\\brdrs\\brdrw15\\brsp60\\b\\fs24",
        `${mark}{\\caps ${esc(h.title)}}${meta ? ` {\\b0\\fs20\\cf${CF_MUTED} ${esc(meta)}}` : ""}`,
      ),
    );
    let lastFam: string | undefined;
    for (const entry of g.entries) {
      // Register generations group children per union, both parents named.
      if (entry.parentNum !== undefined && entry.parentFam !== lastFam) {
        parts.push(para("\\sb160\\sa60\\i", esc(childrenOfLabel(t, entry, opts))));
        lastFam = entry.parentFam;
      }
      parts.push(...entryParas(t, entry, opts));
    }
  }
  const note = truncationNote(t, data);
  if (note) parts.push(para(`\\sb240\\sa100\\i\\cf${CF_MUTED}`, esc(note)));
  // \uc1: one fallback char ("?") follows each \uN escape. Newlines between
  // paragraphs are ignored by RTF readers — kept for readability.
  return (
    "{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1\n" +
    "{\\fonttbl{\\f0\\froman\\fcharset0 Georgia;}}\n" +
    "{\\colortbl;\\red34\\green34\\blue34;\\red68\\green68\\blue68;\\red85\\green85\\blue85;\\red26\\green75\\blue122;}\n" +
    "\\f0\\fs22\n" +
    parts.join("\n") +
    "\n}"
  );
}

function entryParas(t: Translate, entry: ReportEntry, opts: ReportTextOptions): string[] {
  const redacted = !!opts.privacyLiving && entry.living;
  // Hanging indent: the number sits in the margin, the name (and any wrapped
  // lines) align at INDENT; \keepn keeps the head with its first fact line.
  const headFmt = `\\li${INDENT}\\fi-${INDENT}\\tx${INDENT}\\sb60\\keepn`;
  const head =
    `${esc(entryNum(entry))}\\tab {\\b ${esc(reportName(entry, opts))}}` +
    (!redacted && entry.years ? ` {\\cf${CF_MUTED} ${esc(entry.years)}}` : "");
  if (entry.dupOf !== undefined) {
    return [para(headFmt, `${head} {\\cf${CF_MUTED} ${esc(`→ ${t("ahnentafel.dup", { n: entry.dupOf })}`)}}`)];
  }
  if (redacted) return [para(headFmt, head)];
  const paras = [para(headFmt, head)];
  if (opts.narrativeOf) {
    // Narrative style: the prose paragraph (footnote markers included), then
    // the person's own notes and the numbered footnotes (source citations and
    // the event notes too long to weave in).
    const nt = opts.narrativeOf(entry);
    if (nt.paragraph) paras.push(para(`\\li${INDENT}\\cf${CF_FACT}`, esc(nt.paragraph)));
    for (const note of entry.notes ?? []) paras.push(notePara(note, INDENT));
    nt.footnotes.forEach((fn, i) => {
      const mark = citationMark(i + 1);
      if (fn.note !== undefined) paras.push(notePara(`${mark} ${fn.note}`, INDENT));
      else paras.push(sourcePara(t, fn.source, INDENT, mark));
    });
    return paras;
  }
  // Fact lines first (event notes/sources nested under their line), then the
  // person's own notes, then their record-level sources.
  for (const f of entry.facts) {
    paras.push(para(`\\li${INDENT}\\cf${CF_FACT}`, esc(factText(t, f, opts))));
    if (f.note) paras.push(notePara(f.note, NESTED));
    for (const src of f.sources ?? []) paras.push(sourcePara(t, src, NESTED));
  }
  for (const note of entry.notes ?? []) paras.push(notePara(note, INDENT));
  for (const src of entry.sources ?? []) paras.push(sourcePara(t, src, INDENT));
  return paras;
}

/** One paragraph group: `{\pard<fmt> <text>\par}`. */
function para(fmt: string, text: string): string {
  return `{\\pard${fmt} ${text}\\par}`;
}

/** A generation heading's bookmark name — the TOC's HYPERLINK \l target. */
function genBookmark(gen: number): string {
  return `gen${gen}`;
}

/** An italic note paragraph (notes may span several lines → \line breaks). */
function notePara(note: string, indent: number): string {
  return para(`\\li${indent}\\i\\cf${CF_MUTED}`, esc(note));
}

/** A source line: `§ title, page 23` — a clickable HYPERLINK field when the
 *  citation resolved to a URL, with the optional narrative citation mark. */
function sourcePara(t: Translate, src: SourceLine, indent: number, mark?: string): string {
  const label = esc(`${mark ? `${mark} ` : ""}${sourceLabel(t, src)}`);
  const text = src.url
    ? `{\\field{\\*\\fldinst{HYPERLINK "${esc(src.url)}"}}{\\fldrslt{\\cf${CF_LINK}\\ul ${label}}}}`
    : label;
  return para(`\\li${indent}\\fs20\\cf${CF_SOURCE}`, text);
}

/** RTF-escape a string: `\ { }` escaped, newlines become `\line`, non-ASCII
 *  becomes signed-16-bit `\uN?` escapes (supplementary-plane characters as a
 *  UTF-16 surrogate pair, per the RTF spec). */
export function esc(s: string): string {
  let out = "";
  for (const ch of s.replace(/\r\n?/g, "\n")) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\" || ch === "{" || ch === "}") out += `\\${ch}`;
    else if (ch === "\n") out += "\\line ";
    else if (code < 128) out += ch;
    else if (code <= 0xffff) out += uEsc(code);
    else out += uEsc(0xd800 + ((code - 0x10000) >> 10)) + uEsc(0xdc00 + ((code - 0x10000) & 0x3ff));
  }
  return out;
}

/** One UTF-16 code unit as the signed-16-bit `\uN?` control word. */
function uEsc(code: number): string {
  return `\\u${code > 32767 ? code - 65536 : code}?`;
}
