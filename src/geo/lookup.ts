/**
 * The lifecycle of one on-demand lookup, and the state every list holds one of.
 *
 * `idle` is "never asked" — the only state that offers the search plainly;
 * `done` with no results is an answer too, and the lists say so in words rather
 * than by leaving the button looking unpressed.
 *
 * One declaration because there were four, identical bar their names: the
 * geocoding places rows, the addresses rows (twice, once per service), the
 * coordinate panel and the place field. They are the same thing — a request
 * someone asked for, its answer, and the two ways it can end.
 */
export interface LookupState<T> {
  state: "idle" | "loading" | "error" | "done";
  results: T[];
}

/** Never asked. Shared so a caller cannot accidentally hold a *different*
 *  empty state, and so an unasked lookup is one object rather than one per
 *  row. */
export const IDLE_LOOKUP: LookupState<never> = { state: "idle", results: [] };
