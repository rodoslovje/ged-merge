import type { GedDate } from "./types";
import { dateText, withPhrase } from "./date";

// How a date is shown on screen, as opposed to how the file writes it. By
// default the two are the same text; Settings → Display "Date display" can
// instead show dates in words in the reader's language ("about 5 March
// 1850", "okoli 5. marca 1850") or in a chosen pattern ("05.03.1850"). The UI
// installs that formatter here rather than this module importing it, so it
// stays below the report's language code and the normalizer, and the pure
// helpers that build labels and hovers need no setting passed in.

let formatter: ((d: GedDate) => string) | null = null;

/** Install (or with null, remove) the on-screen date formatter. */
export function setDateDisplay(fn: ((d: GedDate) => string) | null): void {
  formatter = fn;
}

/** True while dates are shown otherwise than the file writes them. */
export function datesReformatted(): boolean {
  return formatter !== null;
}

/** A date as the screen shows it — the file's own text unless another display
 *  is chosen; a date the display cannot express keeps its text. A GEDCOM 7
 *  date's own wording (`PHRASE`) is kept either way. */
export function displayDate(d: GedDate): string {
  const shown = formatter && !d.placeholder && formatter(d);
  if (!shown) return dateText(d);
  return d.phrase && !shown.includes(d.phrase) ? withPhrase(shown, d.phrase) : shown;
}
