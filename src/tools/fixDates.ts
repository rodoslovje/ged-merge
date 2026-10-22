import type { Dataset, DateOrder, GedNode } from "../gedcom/types";
import { parseDate } from "../gedcom/date";
import { rebuildFamily, rebuildIndividual } from "../gedcom/edit";
import { hasDualYear, isReadable, normalizeDateString } from "../normalize/date";
import { applyDateOverrides, type FormatOverrides } from "../normalize/formatOverrides";
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

export function dateFixContext(dataset: { records: GedNode[] }): DateFixContext {
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

/** One finding's own date: the record it sits on, plus the offending value as the
 *  row shows it — which the structural check truncates for display, so a long
 *  value is matched by its surviving head. */
export interface BadDateRef {
  id: string;
  sample?: string;
}

/** Whether `value` is the date a row showing `sample` is about. */
function isSample(value: string, sample: string): boolean {
  const v = value.trim();
  return sample.endsWith("…") ? v.startsWith(sample.slice(0, -1)) : v === sample;
}

/** @param only — repair just the date one finding names (its row's own button),
 *  instead of every repairable date in the file. */
export function fixDates(dataset: Dataset, only?: BadDateRef): RecordPatch[] {
  const ctx = dateFixContext(dataset);
  return applyDateFixes(dataset, (rec, out) => collectFixes(rec, ctx, out), only);
}

/** Rewrite the dates `collect` proposes, record by record, as undo patches. */
function applyDateFixes(
  dataset: Dataset,
  collect: (rec: GedNode, out: { node: GedNode; next: string }[]) => void,
  only?: BadDateRef,
): RecordPatch[] {
  const patches: RecordPatch[] = [];
  for (const rec of dataset.records) {
    if (only && rec.xref !== only.id) continue;
    const all: { node: GedNode; next: string }[] = [];
    collect(rec, all);
    const fixes = only?.sample ? all.filter((f) => isSample(f.node.value ?? "", only.sample!)) : all;
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

// ── Non-standard dates ───────────────────────────────────────────────────────

/**
 * The date style a date is held to: the file's own, or the format chosen in
 * Settings → GEDCOM (choosing `D MMM YYYY` there holds every date to the
 * GEDCOM standard). Shared by the health check and its fix, so the two always
 * agree on what is non-standard and what it becomes.
 */
export function dateStyleContext(dataset: { records: GedNode[] }, overrides?: FormatOverrides): DateFixContext {
  const ctx = dateFixContext(dataset);
  return { profile: applyDateOverrides(ctx.profile, overrides), sourceOrder: ctx.sourceOrder };
}

/**
 * What a date's format is, without its values: numbers, placeholder runs and
 * month names each collapse to one symbol, case aside. Two dates of one shape
 * read alike to a person — "01 APR 1894" and "1 Apr 1894", "1 June" and
 * "1 Jun" — so only a real difference of format (numeric against month
 * words, a month put first, a non-standard qualifier, a placeholder) counts.
 */
function dateShape(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[_?]+/g, "_")
    .replace(/\d+/g, "9")
    .replace(/\p{L}{3,}/gu, (w) => (isMonthWord(w) ? "M" : w))
    .replace(/\s+/g, " ");
}

/**
 * Whether a readable date is written in another format than the style holds,
 * and if so whether restyling it is safe:
 *  - `fix`: one reading only — `okoli 1850`, `Abt. 1625`, `JAN 27 1809` —
 *    with the value it becomes;
 *  - `ambiguous`: a numeric date whose day and month could be either
 *    (`05/06/1850`), which only the record can settle;
 *  - undefined: in format already, or another check's to report (unreadable,
 *    a day the month lacks, a two-digit year), or kept on purpose (a dual
 *    year "1850/51", which no format has a slot for).
 */
export function nonStandardDate(
  value: string,
  ctx: DateFixContext,
): { kind: "fix"; next: string } | { kind: "ambiguous" } | undefined {
  const raw = value.trim();
  if (!raw || hasDualYear(raw)) return undefined;
  const d = parseDate(raw, ctx.sourceOrder);
  if (!isReadable(d) || d.impossible || d.shortYear) return undefined;
  const next = normalizeDateString(raw, ctx.profile, ctx.sourceOrder);
  if (!next || dateShape(next) === dateShape(raw)) return undefined;
  // Dotted and dashed numbers are written day first wherever they are written;
  // a slash is where the US writes the month first, so only there can the two
  // numbers honestly go either way.
  const dayFirst = parseDate(raw, "DMY");
  const monthFirst = parseDate(raw, "MDY");
  if (raw.includes("/") && (dayFirst.day !== monthFirst.day || dayFirst.month !== monthFirst.month)) {
    return { kind: "ambiguous" };
  }
  return { kind: "fix", next };
}

/** Collect the safe restylings under `node`, skipping CHAN/CREA change
 *  stamps, whose dates are the program's own. */
function collectStyleFixes(node: GedNode, ctx: DateFixContext, out: { node: GedNode; next: string }[]): void {
  if (node.tag === "CHAN" || node.tag === "CREA") return;
  if (node.tag === "DATE" && node.value) {
    const verdict = nonStandardDate(node.value, ctx);
    if (verdict?.kind === "fix") out.push({ node, next: verdict.next });
  }
  for (const child of node.children) collectStyleFixes(child, ctx, out);
}

/** Restyle every non-standard date that has one reading (or just the one a
 *  finding names), leaving the ambiguous ones for the user. */
export function fixNonStandardDates(dataset: Dataset, overrides?: FormatOverrides, only?: BadDateRef): RecordPatch[] {
  const ctx = dateStyleContext(dataset, overrides);
  return applyDateFixes(dataset, (rec, out) => collectStyleFixes(rec, ctx, out), only);
}
