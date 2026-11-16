import { createContext, useContext } from "react";

/**
 * Set inside the published family website (`src/viewer/`), where the app's
 * charts and statistics run on display data only. Components that would hand
 * the reader a GEDCOM — the charts' branch export — leave that out there: the
 * site is for looking, not for taking the tree away as a file.
 */
export interface PublishedView {
  /** The author let visitors download charts, reports and statistics. */
  exports: boolean;
  /** Living people published without details; the timeline leaves them out,
   *  having no years to draw for them. */
  reduced: ReadonlySet<string>;
  /** Open a person's page. A person picked on a chart opens it at once,
   *  rather than the side panel the app shows (see TreeNodePanel). */
  openPerson: (id: string) => void;
}

export const PublishedViewContext = createContext<PublishedView | null>(null);

/** True on the family website. */
export function usePublishedView(): boolean {
  return useContext(PublishedViewContext) !== null;
}

/** The family website's settings; null in the app. */
export function usePublishedSettings(): PublishedView | null {
  return useContext(PublishedViewContext);
}

/** Whether downloads (SVG, PDF, CSV, report files) are offered: always in the
 *  app, on the website only when the author allowed them. */
export function useExportsAllowed(): boolean {
  const view = useContext(PublishedViewContext);
  return !view || view.exports;
}
