import type { ScopedFacts } from "./scope";
import { decadeGrid, DECADE_TOP, type PlaceDecades } from "./placeFlows";

/** The Names page's surname pictures. */

/** The commonest surnames among the dated births, by decade. */
export function surnameDecades(s: ScopedFacts, top = DECADE_TOP): Omit<PlaceDecades, "places"> {
  return decadeGrid(s, (p) => (p.surname && p.surnameKey ? [p.surnameKey, p.surname] : undefined), top);
}
