// Plain-text rendering of the reports (Ahnentafel / descendant register), for
// the Export ▾ → Text download. Same content the page shows: generation
// headings, "Children of no. X" group headings (register only), numbered
// entries, indented glyph fact lines — kept pure so it's unit-testable.

import type { Translate } from "../locales/i18n";
import {
  generationHeading,
  romanIndex,
  sourceLabel,
  type FactLine,
  type PersonRef,
  type ReportData,
  type ReportEntry,
  type SourceLine,
} from "./model";
import { citationMark, type NarrativeEntryText } from "./narrativeText";

export interface ReportTextOptions {
  /** Redact presumed-living people: keep their number + name, drop the rest. */
  privacyLiving?: boolean;
  /** Narrative style: render this prose (paragraph with citation markers,
   *  overflow notes, numbered citations) instead of the glyph fact lines.
   *  Injected by the view, which owns the planner + language pack — keeps
   *  this module free of narrative grammar. */
  narrativeOf?: (entry: ReportEntry) => NarrativeEntryText;
}

export function reportToText(
  t: Translate,
  data: ReportData,
  direction: "ancestors" | "descendants",
  title: string,
  opts: ReportTextOptions = {},
): string {
  const lines: string[] = [title, "=".repeat(title.length), ""];
  for (const g of data.generations) {
    const h = generationHeading(t, g, direction);
    lines.push([h.title, h.range, h.coverage].filter(Boolean).join(" · "), "");
    let lastFam: string | undefined;
    for (const entry of g.entries) {
      // Register generations group children per union, both parents named.
      if (entry.parentNum !== undefined && entry.parentFam !== lastFam) {
        if (lastFam !== undefined) lines.push("");
        lines.push(childrenOfLabel(t, entry, opts.privacyLiving));
        lastFam = entry.parentFam;
      }
      lines.push(...entryLines(t, entry, opts));
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

/** The per-union group heading, naming both parents when the spouse is known
 *  (the parent's register number is redundant next to their name). Names carry
 *  the lifespan like any entry — dropped for the living under privacy. */
export function childrenOfLabel(t: Translate, entry: ReportEntry, privacy = false): string {
  const name = entry.parent && refText(entry.parent, privacy);
  const spouse = entry.parentSpouse && refText(entry.parentSpouse, privacy);
  return spouse
    ? t("register.childrenOfBoth", { name, spouse })
    : t("register.childrenOf", { name });
}

/** A heading person as text: "Luka Renko (1974)". */
function refText(ref: PersonRef, privacy: boolean): string {
  const years = !(privacy && ref.living) && ref.years;
  return years ? `${ref.name} (${years})` : ref.name;
}

/** The entry's leading number: "5." for ancestors and the root, the NGSQ
 *  "5 ii." (register number + roman child index) for register children. */
export function entryNum(entry: ReportEntry): string {
  return entry.childIndex !== undefined ? `${entry.num} ${romanIndex(entry.childIndex)}.` : `${entry.num}.`;
}

function entryLines(t: Translate, entry: ReportEntry, opts: ReportTextOptions): string[] {
  const redacted = !!opts.privacyLiving && entry.living;
  const num = entryNum(entry);
  const head = `${num} ${entry.name}${!redacted && entry.years ? ` (${entry.years})` : ""}`;
  if (entry.dupOf !== undefined) {
    return [`${head} → ${t("ahnentafel.dup", { n: entry.dupOf })}`];
  }
  if (redacted) return [head];
  const indent = " ".repeat(num.length + 1);
  const lines = [head];
  if (opts.narrativeOf) {
    // Narrative style: the prose paragraph (footnote markers included), then
    // the person's own notes and the numbered footnotes (source citations and
    // the event notes too long to weave in).
    const nt = opts.narrativeOf(entry);
    if (nt.paragraph) lines.push(indent + nt.paragraph);
    for (const note of entry.notes ?? []) lines.push(...noteLines(note, indent));
    nt.footnotes.forEach((fn, i) => {
      const mark = citationMark(i + 1);
      if (fn.note !== undefined) {
        const [first, ...rest] = fn.note.split("\n");
        lines.push(`${indent}${mark} ${first}`, ...rest.map((l) => `${indent}  ${l}`));
      } else {
        lines.push(`${indent}${mark} ${sourceText(t, fn.source)}`);
      }
    });
    return lines;
  }
  // Person notes and sources under the name, event ones under their fact line.
  for (const note of entry.notes ?? []) lines.push(...noteLines(note, indent));
  for (const src of entry.sources ?? []) lines.push(indent + sourceText(t, src));
  for (const f of entry.facts) {
    lines.push(indent + factText(t, f));
    if (f.note) lines.push(...noteLines(f.note, indent + "  "));
    for (const src of f.sources ?? []) lines.push(indent + "  " + sourceText(t, src));
  }
  return lines;
}

/** A note's text as indented lines (notes may span several lines). */
function noteLines(note: string, indent: string): string[] {
  return note.split("\n").map((l) => indent + l);
}

/** A source line with its page label and link: `§ title, page 23 — https://…`. */
function sourceText(t: Translate, src: SourceLine): string {
  const label = sourceLabel(t, src);
  return src.url ? `${label} — ${src.url}` : label;
}

/** One fact line, date always first: `⚭ 4 FEB 1866, Škofja Loka — Marija
 *  Oblak`, `⚒ 1958, orodjar`. The AGNC joins the comma run like the place;
 *  the CAUS gets its localized frame: `† 1912, Ljubljana (vzrok: pljučnica)`. */
export function factText(t: Translate, f: FactLine): string {
  const when = [f.date, f.value, f.place, f.agency].filter(Boolean).join(", ");
  const cause = f.cause ? ` ${t("narrative.cause", { cause: f.cause })}` : "";
  return `${f.glyph} ${when}${cause}${f.spouse ? ` — ${f.spouse}` : ""}`;
}
