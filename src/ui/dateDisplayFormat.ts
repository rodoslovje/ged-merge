import type { GedDate } from "../gedcom/types";
import { formatGedDate, hasDualYear } from "../normalize/date";
import { DATE_PATTERN_CHOICES, dateProfileFromPattern } from "../normalize/formatOverrides";
import { inferDateProfile } from "../normalize/profile";
import { narrativeLangFor } from "../report/narrativeText";

/** The Settings → Display "Date display" choices: the file's own text (""),
 *  words in the reader's language, or one of the file-format patterns. */
export const DATE_DISPLAY_WORDS = "words";
/** The way Slovenian writes a date ("5. 3. 1850"): a display only — the
 *  spaced form is not a file format the parser reads back, so the file-format
 *  setting does not offer it. */
export const DATE_DISPLAY_SPACED = "D. M. YYYY";
export const DATE_DISPLAY_CHOICES: readonly string[] = ["", DATE_DISPLAY_WORDS, DATE_DISPLAY_SPACED, ...DATE_PATTERN_CHOICES];

/**
 * The on-screen formatter a display choice stands for, or null for the file's
 * own text. A pattern writes each date part as the normalizer would write it
 * in that format, and the qualifier as a sign (`~05.03.1850`, `1850–1860`,
 * `1850 → 1860`); a value no pattern can hold (a calendar, an era, free text)
 * keeps its text.
 * `lang` is read per date, so a language switch needs no new formatter.
 */
export function dateDisplayFormatter(choice: string, lang: () => string): ((d: GedDate) => string) | null {
  if (choice === DATE_DISPLAY_WORDS) return (d) => narrativeLangFor(lang()).dateLabel(d);
  if (choice === DATE_DISPLAY_SPACED) {
    // D.M.YYYY with a space after each dot between numbers: "ABT 5. 3. 1850".
    const compact = dateDisplayFormatter("D.M.YYYY", lang)!;
    return (d) => compact(d).replace(/(\d)\.(?=\d)/g, "$1. ");
  }
  const profile = choice ? dateProfileFromPattern(choice, inferDateProfile([]), "none") : undefined;
  if (!profile) return null;
  const part = (year?: number, month?: number, day?: number) =>
    formatGedDate({ raw: "", qualifier: "exact", year, month, day }, profile);
  return (d) => {
    const whole = formatGedDate(d, profile);
    if (d.calendar !== undefined || hasDualYear(d.raw)) return whole;
    const first = part(d.year, d.month, d.day);
    const second = part(d.year2, d.month2, d.day2);
    const sign = qualifierSign(d.qualifier, first, second);
    return sign ?? whole;
  };
}

/**
 * A qualified date written with signs instead of GEDCOM keywords: ABT/CAL/EST
 * as `~`, BEF `<`, AFT `>`, the range BET … AND … as `a–b`, and the period
 * FROM … TO … as `a → b` — kept apart from the range, since one says when a
 * single event fell and the other how long something lasted. An INT date
 * shows its date; its wording stays in the field's hover with the file's text.
 * Undefined when a part the qualifier needs did not format.
 */
function qualifierSign(qualifier: GedDate["qualifier"], first: string, second: string): string | undefined {
  if (qualifier === "between" || qualifier === "range") {
    if (!first || !second) return undefined;
    return qualifier === "between" ? `${first}–${second}` : `${first} → ${second}`;
  }
  if (!first) return undefined;
  switch (qualifier) {
    case "about":
      return `~${first}`;
    case "before":
      return `<${first}`;
    case "after":
      return `>${first}`;
    case "from":
      return `${first} →`;
    case "to":
      return `→ ${first}`;
    case "interpreted":
    case "exact":
      return first;
    case "unknown":
      return undefined;
  }
}
