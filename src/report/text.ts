// Plain-text rendering of the Ahnentafel report, for the Export ▾ → Text
// download. Same content the page shows: generation headings, numbered
// entries, indented glyph fact lines — kept pure so it's unit-testable.

import type { Translate } from "../locales/i18n";
import { generationLabel, type AhnentafelData, type AhnEntry, type FactLine } from "./ahnentafel";

export interface AhnentafelTextOptions {
  /** Redact presumed-living people: keep their number + name, drop the rest. */
  privacyLiving?: boolean;
}

export function ahnentafelToText(
  t: Translate,
  data: AhnentafelData,
  title: string,
  opts: AhnentafelTextOptions = {},
): string {
  const lines: string[] = [title, "=".repeat(title.length), ""];
  for (const g of data.generations) {
    lines.push(generationLabel(t, g.gen), "");
    for (const entry of g.entries) {
      lines.push(...entryLines(t, entry, opts));
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

function entryLines(t: Translate, entry: AhnEntry, opts: AhnentafelTextOptions): string[] {
  const redacted = !!opts.privacyLiving && entry.living;
  const head = `${entry.num}. ${entry.name}${!redacted && entry.years ? ` (${entry.years})` : ""}`;
  if (entry.dupOf !== undefined) {
    return [`${head} → ${t("ahnentafel.dup", { n: entry.dupOf })}`];
  }
  if (redacted) return [head];
  const indent = " ".repeat(String(entry.num).length + 2);
  return [head, ...entry.facts.map((f) => indent + factText(f))];
}

/** One fact line: `⚭ 4 FEB 1866, Škofja Loka — Marija Oblak`. */
export function factText(f: FactLine): string {
  const when = [f.date, f.place].filter(Boolean).join(", ");
  return `${f.glyph} ${when}${f.spouse ? ` — ${f.spouse}` : ""}`;
}
