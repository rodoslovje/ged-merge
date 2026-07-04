// Plain-text rendering of the reports (Ahnentafel / descendant register), for
// the Export ▾ → Text download. Same content the page shows: generation
// headings, "Children of no. X" group headings (register only), numbered
// entries, indented glyph fact lines — kept pure so it's unit-testable.

import type { Translate } from "../locales/i18n";
import { generationHeading, romanIndex, type FactLine, type ReportData, type ReportEntry } from "./model";

export interface ReportTextOptions {
  /** Redact presumed-living people: keep their number + name, drop the rest. */
  privacyLiving?: boolean;
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
        lines.push(childrenOfLabel(t, entry));
        lastFam = entry.parentFam;
      }
      lines.push(...entryLines(t, entry, opts));
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

/** The per-union group heading, naming both parents when the spouse is known. */
export function childrenOfLabel(t: Translate, entry: ReportEntry): string {
  return entry.parentSpouse
    ? t("register.childrenOfBoth", { n: entry.parentNum, name: entry.parentName, spouse: entry.parentSpouse })
    : t("register.childrenOf", { n: entry.parentNum, name: entry.parentName });
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
  return [head, ...entry.facts.map((f) => indent + factText(f))];
}

/** One fact line, date always first: `⚭ 4 FEB 1866, Škofja Loka — Marija
 *  Oblak`, `⚒ 1958, orodjar`. */
export function factText(f: FactLine): string {
  const when = [f.date, f.value, f.place].filter(Boolean).join(", ");
  return `${f.glyph} ${when}${f.spouse ? ` — ${f.spouse}` : ""}`;
}
