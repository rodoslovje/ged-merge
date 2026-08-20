import { useCallback, useRef, useState } from "react";
import { familySearchPageUrl, linkKey } from "../../normalize/links";
import { fetchPageHtml, fetchPageTitle } from "../../normalize/urlMetadata";
import {
  fetchBookMeta,
  isFetchableSite,
  recognizeSourceUrl,
  type RecognizedSourceUrl,
  type ReshapeMeta,
} from "../../tools/sourceReshape";

/**
 * Reading the page behind a source's link, for the dialogs that offer it.
 *
 * Both source editors do this — Add Source's *Fetch again*, and the Organize
 * sources editor the moment a traded link settles — and each had written the
 * whole of it out: recognize the site, ask the right reader, keep a spinner,
 * and make sure a slow answer for a link since edited away cannot land in the
 * fields. That last part is the one worth having in one place; the two got it
 * subtly differently, and a stale answer overwriting a reader's edit is the
 * kind of bug nobody reproduces on purpose.
 *
 * What each dialog does with the answer stays its own: Add Source upgrades a
 * field while it still holds the offline proposal, the Organize editor fills
 * what the reader has not typed. Both mean "your own words win"; neither can
 * state it in the other's terms.
 */
export interface SourceLookup {
  /** The site a link is recognized as, or nothing. `readable` narrows it to
   *  the sites a lookup can actually reach — a FamilySearch record page is
   *  recognized but sign-in-only, so a button offering to read it would lie. */
  targetOf(url: string, opts?: { readable?: boolean }): RecognizedSourceUrl | undefined;
  /**
   * Read the page and hand back what it says. A recognized site goes through
   * its own parser; `anyPage` lets an unrecognized link fall back to the page
   * title, which is all a bare URL ever offers.
   *
   * Resolves to `undefined` when the answer is empty *or* when a newer link
   * has been asked for since — in both cases the caller has nothing to write.
   */
  lookUp(url: string, opts?: { anyPage?: boolean }): Promise<ReshapeMeta | undefined>;
  /** A lookup is in flight. */
  fetching: boolean;
  /** The last one came back empty-handed — blocked relay, or a page this
   *  program cannot read. Cleared when the next one starts. */
  failed: boolean;
}

export function useSourceLookup(allowed: boolean): SourceLookup {
  const [fetching, setFetching] = useState(false);
  const [failed, setFailed] = useState(false);
  /** The link whose answer the fields are waiting for. */
  const awaiting = useRef("");

  const targetOf = useCallback((url: string, opts?: { readable?: boolean }) => {
    const trimmed = url.trim();
    if (!trimmed) return undefined;
    const site = recognizeSourceUrl(familySearchPageUrl(trimmed));
    if (!site) return undefined;
    return !opts?.readable || isFetchableSite(site.site, site.bookUrl) ? site : undefined;
  }, []);

  const lookUp = useCallback(
    async (url: string, opts?: { anyPage?: boolean }): Promise<ReshapeMeta | undefined> => {
      const trimmed = url.trim();
      if (!trimmed || !allowed) return undefined;
      const normalized = familySearchPageUrl(trimmed);
      const site = recognizeSourceUrl(normalized);
      const key = linkKey(normalized);
      awaiting.current = key;
      setFetching(true);
      setFailed(false);
      const meta = await (site
        ? fetchBookMeta(site.site, site.bookUrl, fetchPageHtml)
        : opts?.anyPage
          ? fetchPageTitle(normalized).then((title) => (title ? { title } : undefined))
          : Promise.resolve(undefined)
      ).catch(() => undefined);
      // A newer link is on its way: this answer is about a page the reader has
      // already moved on from, and must not touch the fields.
      if (awaiting.current !== key) return undefined;
      setFetching(false);
      setFailed(!meta);
      return meta;
    },
    [allowed],
  );

  return { targetOf, lookUp, fetching, failed };
}
