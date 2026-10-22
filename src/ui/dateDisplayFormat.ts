import type { GedDate } from "../gedcom/types";
import { formatGedDate } from "../normalize/date";
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
 * own text. A pattern writes the date as the normalizer would write it in that
 * format — qualifiers keep their standard keyword (`ABT 05.03.1850`), and a
 * value no pattern can hold (a calendar, an era, free text) keeps its text.
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
  return profile ? (d) => formatGedDate(d, profile) : null;
}
