import { createContext, useContext } from "react";

/**
 * True inside the published family website (`src/viewer/`), where the app's
 * charts and statistics run on display data only. Components that would hand
 * the reader a GEDCOM — the charts' branch export — leave that out there: the
 * site is for looking, not for taking the tree away as a file.
 */
export const PublishedViewContext = createContext(false);

export function usePublishedView(): boolean {
  return useContext(PublishedViewContext);
}
