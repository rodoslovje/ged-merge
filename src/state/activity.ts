/**
 * Network work running in the background, counted by kind — what the header's
 * activity indicator shows beside Undo/Redo/Save.
 *
 * Counted where the requests are made (the providers' throttle queues, the
 * source-page relay), not in the components that ask for them: a lookup goes on
 * when its panel closes, and a download the researcher cannot see is exactly
 * the one worth showing. A module-level counter with watchers, like the geo
 * import's snapshot, read through `useSyncExternalStore`.
 */

/** What is being fetched: register/geocoder place lookups, the address
 *  register, or source pages (FamilySearch, Matricula, other source links). */
export type ActivityKind = "places" | "addresses" | "sources";

export type ActivitySnapshot = Readonly<Record<ActivityKind, number>>;

let snapshot: ActivitySnapshot = { places: 0, addresses: 0, sources: 0 };
const watchers = new Set<() => void>();

function bump(kind: ActivityKind, by: number): void {
  snapshot = { ...snapshot, [kind]: Math.max(0, snapshot[kind] + by) };
  for (const fn of watchers) fn();
}

/** Count `work` as one request of `kind` until it settles (resolved, rejected
 *  or aborted — all the same to the count). Returns the same promise. */
export function trackActivity<T>(kind: ActivityKind, work: Promise<T>): Promise<T> {
  bump(kind, 1);
  work.then(
    () => bump(kind, -1),
    () => bump(kind, -1),
  );
  return work;
}

/** The current counts — a stable reference between changes. */
export function activitySnapshot(): ActivitySnapshot {
  return snapshot;
}

export function watchActivity(fn: () => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}
