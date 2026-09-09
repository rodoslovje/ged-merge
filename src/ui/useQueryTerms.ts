import { useMemo } from "react";
import { queryTerms } from "./globalSearch";

/** The search terms of a filter box, re-split only when its text changes.
 *  Every list that reads a place, an address, a source or a name the way the
 *  person search does takes its terms from here, so they all split alike. */
export function useQueryTerms(query: string): string[] {
  return useMemo(() => queryTerms(query), [query]);
}
