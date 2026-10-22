import type { GedDate } from "./types";
import { dateText } from "./date";

// How a date is shown on screen, as opposed to how the file writes it. By
// default the two are the same text; with Settings → Display "Show dates in
// words" on, the UI installs a formatter here that writes the date in the
// reader's language ("about 5 March 1850", "okoli 5. marca 1850"). Installed
// rather than imported, so this module stays below the report's language code
// and the pure helpers that build labels and hovers need no setting passed in.

let words: ((d: GedDate) => string) | null = null;

/** Install (or with null, remove) the words formatter. */
export function setDateWords(fn: ((d: GedDate) => string) | null): void {
  words = fn;
}

/** True while dates are shown in words. */
export function datesInWords(): boolean {
  return words !== null;
}

/** A date as the screen shows it — the file's own text unless dates are shown
 *  in words; a date the words cannot express keeps its text. */
export function displayDate(d: GedDate): string {
  return (words && !d.placeholder && words(d)) || dateText(d);
}
