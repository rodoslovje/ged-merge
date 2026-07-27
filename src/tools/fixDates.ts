import type { Dataset, DateOrder, GedNode } from "../gedcom/types";
import { parseDate } from "../gedcom/date";
import { rebuildFamily, rebuildIndividual } from "../gedcom/edit";
import { normalizeDateString } from "../normalize/date";
import { inferDateProfile, collectLayoutValues, isMonthWord } from "../normalize/profile";
import type { DateFormatProfile } from "../normalize/types";
import { cloneRaw, type RecordPatch } from "../ui/historyTypes";

/**
 * One-button repair for the "Unparseable dates" structural-check category.
 *
 * Conservative and deterministic. It repairs three unambiguous cases:
 *
 *  - **Spaced numeric** — a value that fails to parse today but parses cleanly
 *    once stray whitespace around the numeric separators is removed, e.g.
 *    `26. 6. 1912`. Once parseable, it re-renders the date in the file's own
 *    dominant format (the same "house style" the Normalize tool detects) so the
 *    repair matches the rest of the file rather than leaving a lone `26.6.1912`
 *    in a file that otherwise writes `26 JUN 1912`.
 *  - **Comma year-pair** — two ascending bare years like `1951, 1960`, read as
 *    the period the user wrote in shorthand and re-rendered as the formal
 *    `FROM 1951 TO 1960`.
 *  - **Comma'd month-word date** — the US written form `Apr 12, 1979` (also
 *    `12 Apr, 1979`, `Sep, 1979`). The month word already pins the month, so
 *    dropping the comma leaves nothing to guess; the result is re-rendered in
 *    the file's own format like the spaced-numeric case.
 *
 * Anything still ambiguous after these (e.g. free text, or a comma pair that
 * isn't two plausible ascending years) is left untouched, so the fix can't
 * guess intent.
 *
 * Mutates the dataset in place and returns `RecordPatch[]` for the undo stack,
 * following the same convention as `fixBrokenLinks` / `fixSexFromRole`.
 */

/**
 * The file's date house style plus the numeric ordering to assume when parsing an
 * ambiguous numeric source date (e.g. whether `6.4.1975` is D.M or M.D). Computed
 * once per dataset and shared by the count, the fix, and the structural preview
 * so all three always agree on the proposed value.
 */
export interface DateFixContext {
  profile: DateFormatProfile;
  sourceOrder: DateOrder;
}

export function dateFixContext(dataset: Dataset): DateFixContext {
  const { dateValues } = collectLayoutValues(dataset);
  const profile = inferDateProfile(dateValues);
  const sourceOrder = detectSourceOrder(dateValues, profile.numeric?.order);
  return { profile, sourceOrder };
}

/**
 * Best-effort guess of whether the file writes day-first (EU, `DMY`) or
 * month-first (US, `MDY`) dates — needed to decide which number is the month in
 * an ambiguous numeric like `6. 4. 1975`. Weighs evidence across every date in
 * the file:
 *
 *  - **Month-word order** — `26 JUN 1912` votes day-first, `JUN 26 1912` votes
 *    month-first (the clearest signal, and the only one a pure month-word file
 *    offers).
 *  - **Numeric with a field > 12** — that field can only be the day, so its
 *    position settles the order (tolerating stray spaces, as in the dates being
 *    repaired).
 *
 * Ties (or no evidence) fall back to the file's own clean-numeric order, then to
 * day-first — the more common convention worldwide.
 */
function detectSourceOrder(values: string[], numericOrder?: DateOrder): DateOrder {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const raw of values) {
    const t = raw.trim();
    // Month-word ordering carries day/month order directly.
    const dm = t.match(/(?:^|[\s(])(\d{1,2})\.?\s+([A-Za-z]{3,})/);
    if (dm && isMonthWord(dm[2])) { dayFirst++; continue; }
    const md = t.match(/([A-Za-z]{3,})\.?\s+(\d{1,2})(?:[\s,)]|$)/);
    if (md && isMonthWord(md[1])) { monthFirst++; continue; }
    // Numeric (tolerating stray spaces): a year-last value whose first or second
    // field exceeds 12 can only be day-first or month-first respectively.
    const num = t.replace(/\s+/g, "").match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{3,4})$/);
    if (num) {
      const a = +num[1];
      const b = +num[2];
      if (a > 12 && b <= 12) dayFirst++;
      else if (b > 12 && a <= 12) monthFirst++;
    }
  }
  if (monthFirst > dayFirst) return "MDY";
  if (dayFirst > monthFirst) return "DMY";
  return numericOrder && numericOrder !== "YMD" ? numericOrder : "DMY";
}

/** True when `value` is the parser's "garbage" result — no usable date, and not
 *  a deliberate placeholder. Mirrors the detection in `validateStructure`. */
function isUnparseable(value: string): boolean {
  const d = parseDate(value);
  return d.qualifier === "unknown" && d.year == null && d.year2 == null && !d.placeholder;
}

/**
 * The safely-repaired form of an unparseable date, or `undefined` if it can't be
 * fixed without guessing. Collapses whitespace hugging a `.`/`/`/`-` separator
 * (the spaced-numeric case) and/or drops commas (the `Apr 12, 1979` case); the
 * first cleanup that parses is re-rendered in the file's format. Anything else
 * is left alone.
 */
export function proposeDateFix(value: string, ctx: DateFixContext): string | undefined {
  if (!isUnparseable(value)) return undefined;

  // A comma-separated year pair ("1951, 1960") is shorthand for a period; render
  // it as the formal FROM…TO form before falling back to the cleanups below.
  const period = proposeYearPeriod(value);
  if (period) return period;

  for (const cleaned of cleanupCandidates(value)) {
    if (isUnparseable(cleaned)) continue; // still unparseable → not a safe fix
    const formatted = normalizeDateString(cleaned, ctx.profile, ctx.sourceOrder);
    if (!formatted || formatted === value.trim()) continue;
    return formatted;
  }
  return undefined;
}

/**
 * Punctuation cleanups to try, in order, on an unparseable value: whitespace
 * hugging a `.`/`/`/`-` separator removed, commas dropped, then both. Each is
 * only ever *accepted* when the result parses, so a cleanup can't turn free text
 * into a date it doesn't say — "Sep, 1979" becomes "SEP 1979", while
 * "1979, Ljubljana" stays unparseable and is left alone.
 */
function cleanupCandidates(value: string): string[] {
  const trimmed = value.trim();
  const out: string[] = [];
  for (const c of [
    collapseSeparators(trimmed),
    dropCommas(trimmed),
    dropCommas(collapseSeparators(trimmed)),
  ]) {
    if (c !== "" && c !== trimmed && !out.includes(c)) out.push(c);
  }
  return out;
}

const collapseSeparators = (s: string) => s.replace(/\s*([./-])\s*/g, "$1").trim();
const dropCommas = (s: string) => s.replace(/,/g, " ").replace(/\s+/g, " ").trim();

/**
 * A comma-separated pair of bare years ("1951, 1960"), read as a period the user
 * wrote in shorthand and re-rendered as the formal `FROM y1 TO y2`. Returns
 * undefined unless the value is exactly two plausible years in ascending order —
 * the only shape we can confidently read as a span rather than guess at.
 */
function proposeYearPeriod(value: string): string | undefined {
  const m = value.trim().match(/^(\d{3,4})\s*,\s*(\d{3,4})$/);
  if (!m) return undefined;
  const a = +m[1];
  const b = +m[2];
  if (a < 100 || b < 100 || a > 2200 || b > 2200) return undefined;
  if (a >= b) return undefined; // must be a genuine ascending span
  return `FROM ${a} TO ${b}`;
}

/** Collect (node, repaired value) pairs for every fixable DATE under `node`. */
function collectFixes(node: GedNode, ctx: DateFixContext, out: { node: GedNode; next: string }[]): void {
  if (node.tag === "DATE" && node.value && node.value.trim()) {
    const next = proposeDateFix(node.value, ctx);
    if (next) out.push({ node, next });
  }
  for (const child of node.children) collectFixes(child, ctx, out);
}

/** How many unparseable dates can be safely repaired. */
export function countFixableDates(dataset: Dataset): number {
  const ctx = dateFixContext(dataset);
  let count = 0;
  for (const rec of dataset.records) {
    const fixes: { node: GedNode; next: string }[] = [];
    collectFixes(rec, ctx, fixes);
    count += fixes.length;
  }
  return count;
}

export function fixDates(dataset: Dataset): RecordPatch[] {
  const ctx = dateFixContext(dataset);
  const patches: RecordPatch[] = [];
  for (const rec of dataset.records) {
    const fixes: { node: GedNode; next: string }[] = [];
    collectFixes(rec, ctx, fixes);
    if (fixes.length === 0) continue;

    // Top-level non-INDI/FAM records (e.g. OBJE/SOUR) carry dates too; patch them
    // directly against `dataset.records` by xref via the "record" patch type.
    const type = rec.tag === "INDI" ? "individual" : rec.tag === "FAM" ? "family" : "record";
    if (type === "record" && !rec.xref) continue; // can't address it for undo

    const before = cloneRaw(rec);
    for (const f of fixes) f.node.value = f.next;

    // Re-derive the typed projection so events reflect the repaired date.
    if (type === "individual" && rec.xref) {
      const indi = dataset.individuals.get(rec.xref);
      if (indi) rebuildIndividual(dataset, indi);
    } else if (type === "family" && rec.xref) {
      const fam = dataset.families.get(rec.xref);
      if (fam) rebuildFamily(dataset, fam);
    }

    patches.push({ type, id: rec.xref ?? "", before, after: cloneRaw(rec) });
  }
  return patches;
}
