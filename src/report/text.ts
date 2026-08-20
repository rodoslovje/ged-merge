// Plain-text rendering of the reports (Ahnentafel / descendant register), for
// the Export ▾ → Text download. Same content the page shows: generation
// headings, "Children of no. X" group headings (register only), numbered
// entries, indented glyph fact lines — kept pure so it's unit-testable.

import type { Sex } from "../gedcom/types";
import type { Translate } from "../locales/i18n";
import {
  factAgeSuffix,
  generationHeading,
  truncationNote,
  romanIndex,
  sourceLabel,
  tocRows,
  type FactLine,
  type PersonRef,
  type ReportData,
  type ReportEntry,
  type SourceLine,
} from "./model";
import { citationMark, type NarrativeEntryText } from "./narrativeText";

export interface ReportTextOptions {
  /** Redact presumed-living people: keep their number, replace the name (see
   *  {@link ReportTextOptions.livingNameOf}), drop the rest. */
  privacyLiving?: boolean;
  /** Display name for a redacted living person — their kinship to the root or
   *  the localized "Living" placeholder, same as the chart nodes. Injected by
   *  the view, which owns the kinship resolver; without it the name stays. */
  livingNameOf?: (person: { id: string; sex: Sex }) => string;
  /** Narrative style: render this prose (paragraph with citation markers,
   *  overflow notes, numbered citations) instead of the glyph fact lines.
   *  Injected by the view, which owns the planner + language pack — keeps
   *  this module free of narrative grammar. */
  narrativeOf?: (entry: ReportEntry) => NarrativeEntryText;
  /** Lead with a table of contents: one line per generation, the entry-number
   *  range as the reference (linked to the section where the format can). */
  toc?: boolean;
}

export function reportToText(
  t: Translate,
  data: ReportData,
  direction: "ancestors" | "descendants",
  title: string,
  opts: ReportTextOptions = {},
): string {
  const lines: string[] = [title, "=".repeat(title.length), ""];
  if (opts.toc) {
    lines.push(t("report.toc"));
    for (const row of tocRows(t, data, direction)) lines.push(`  ${row.label}`);
    lines.push("");
  }
  for (const g of data.generations) {
    const h = generationHeading(t, g, direction);
    lines.push([h.title, h.range, h.coverage].filter(Boolean).join(" · "), "");
    let lastFam: string | undefined;
    for (const entry of g.entries) {
      // Register generations group children per union, both parents named.
      if (entry.parentNum !== undefined && entry.parentFam !== lastFam) {
        if (lastFam !== undefined) lines.push("");
        lines.push(childrenOfLabel(t, entry, opts));
        lastFam = entry.parentFam;
      }
      lines.push(...entryLines(t, entry, opts));
    }
    lines.push("");
  }
  const note = truncationNote(t, data);
  if (note) lines.push(note, "");
  return lines.join("\n").replace(/\n+$/, "\n");
}

/** A person's rendered name: the recorded name, or — redacted living under
 *  privacy — the injected kinship/"Living" replacement, like the chart nodes. */
export function reportName(
  p: { id: string; sex: Sex; name: string; living: boolean },
  opts: ReportTextOptions,
): string {
  return opts.privacyLiving && p.living && opts.livingNameOf ? opts.livingNameOf(p) : p.name;
}

/** The per-union group heading, naming both parents when the spouse is known
 *  (the parent's register number is redundant next to their name). Names carry
 *  the lifespan like any entry — dropped for the living under privacy. */
export function childrenOfLabel(t: Translate, entry: ReportEntry, opts: ReportTextOptions = {}): string {
  const name = entry.parent && refText(entry.parent, opts);
  const spouse = entry.parentSpouse && refText(entry.parentSpouse, opts);
  return spouse
    ? t("register.childrenOfBoth", { name, spouse })
    : t("register.childrenOf", { name });
}

/** A heading person as text: "Luka Renko (1974)". */
function refText(ref: PersonRef, opts: ReportTextOptions): string {
  const name = reportName(ref, opts);
  const years = !(opts.privacyLiving && ref.living) && ref.years;
  return years ? `${name} (${years})` : name;
}

/** The entry's leading number: "5." for ancestors and the root, the NGSQ
 *  "5 ii." (register number + roman child index) for register children. */
export function entryNum(entry: ReportEntry): string {
  return entry.childIndex !== undefined ? `${entry.num} ${romanIndex(entry.childIndex)}.` : `${entry.num}.`;
}

function entryLines(t: Translate, entry: ReportEntry, opts: ReportTextOptions): string[] {
  const redacted = !!opts.privacyLiving && entry.living;
  const num = entryNum(entry);
  const head = `${num} ${reportName(entry, opts)}${!redacted && entry.years ? ` (${entry.years})` : ""}`;
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
  // Fact lines first (event notes/sources nested under their line), then the
  // person's own notes, then their record-level sources.
  for (const f of entry.facts) {
    lines.push(indent + factText(t, f, opts));
    if (f.note) lines.push(...noteLines(f.note, indent + "  "));
    for (const src of f.sources ?? []) lines.push(indent + "  " + sourceText(t, src));
  }
  for (const note of entry.notes ?? []) lines.push(...noteLines(note, indent));
  for (const src of entry.sources ?? []) lines.push(indent + sourceText(t, src));
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
 *  Oblak (1845–1913), daughter of Janez Oblak and Neža Zupan`, `⚒ 1958,
 *  orodjar`. The AGNC joins the comma run like the place; the CAUS gets its
 *  localized frame: `† 1912, Ljubljana (vzrok: pljučnica)`. */
export function factText(t: Translate, f: FactLine, opts: ReportTextOptions = {}): string {
  const age = factAgeSuffix(f);
  const datePart = f.date && age ? `${f.date} ${age}` : f.date;
  const when = [datePart, f.value, f.place, f.agency].filter(Boolean).join(", ");
  const cause = f.cause ? ` ${t("narrative.cause", { cause: f.cause })}` : "";
  const lead = when ? `${f.glyph} ${when}` : f.glyph; // an undated ⚭ line leads with the partner alone
  return `${lead}${cause}${spouseText(t, f, opts)}`;
}

/** The ⚭ line's partner tail: name, lifespan, and the NGSQ origin clause
 *  ("daughter of Janez Oblak and Neža Zupan"). Under the privacy option a
 *  living partner keeps the name but loses the years — like the group
 *  headings — and a living parent's name stays out of the origin clause. */
function spouseText(t: Translate, f: FactLine, opts: ReportTextOptions): string {
  if (!f.spouse) return "";
  const priv = !!opts.privacyLiving;
  const years = f.spouseYears && !(priv && f.spouseLiving) ? ` (${f.spouseYears})` : "";
  const father = f.spouseFather && !(priv && f.spouseFather.living) ? f.spouseFather.name : undefined;
  const mother = f.spouseMother && !(priv && f.spouseMother.living) ? f.spouseMother.name : undefined;
  const sfx = f.spouseSex === "M" ? "_M" : f.spouseSex === "F" ? "_F" : "";
  const origin =
    father && mother
      ? t(`register.spouseOriginBoth${sfx}`, { father, mother })
      : father
        ? t(`register.spouseOriginFather${sfx}`, { father })
        : mother
          ? t(`register.spouseOriginMother${sfx}`, { mother })
          : undefined;
  return ` — ${f.spouse}${years}${origin ? `, ${origin}` : ""}`;
}
