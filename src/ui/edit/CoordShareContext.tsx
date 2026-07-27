import { createContext, useContext } from "react";
import type { GeoCoord } from "../../gedcom/types";

// A coordinate picked for one event usually belongs to every event at the same
// place and address — the same house does not move between two baptisms. The
// picker offers to copy the pick to those other events; the Edit view supplies
// the count and the write-back here, so the offer needs no prop drilling
// through the event-row components in between.

export interface CoordShare {
  /** Events elsewhere in the file carrying this exact place + address, not
   *  counting the one being edited. Zero means there is nothing to offer.
   *  Whatever coordinate those events hold is irrelevant — re-pinning an
   *  address they all already share is the main reason to copy a pick. */
  countOthers: (place: string, address: string) => number;
  /** Write `coord` onto every event at this place + address (one undo step). */
  applyToAll: (place: string, address: string, coord: GeoCoord) => void;
}

const CoordShareContext = createContext<CoordShare | null>(null);

export const CoordShareProvider = CoordShareContext.Provider;

/** null outside the Edit view (e.g. the geocode tool's own pickers). */
export function useCoordShare(): CoordShare | null {
  return useContext(CoordShareContext);
}
