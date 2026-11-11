/**
 * The display the series settles on in episode 3 (display settings), applied
 * up front to every later episode: France Prešeren as the start person,
 * kinship by every name with the direct line in bold, ages, and dates in the
 * Slovenian form for the Slovenian videos (the file's own GEDCOM form for the
 * English ones).
 *
 * Written to the app's own settings key before the page loads (make.ts), so it
 * is what a viewer who followed episode 3 would see.
 */
import type { Lang } from "./types.ts";

/** France Prešeren's record in both main demo files (keyed like `targetFileKey`). */
const FRANCE = "@I113441@";

export function seriesSettings(lang: Lang): Record<string, unknown> {
  return {
    showKinship: true,
    emphasizeDirect: true,
    showAge: true,
    dateDisplay: lang === "sl" ? "D. M. YYYY" : "",
    startPersons: { "preseren-hawlina": FRANCE, "preseren-hawlina-porocni": FRANCE },
  };
}
