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

/** One kind's run: requests still open, and every request the run has taken
 *  on since the kind was last idle — so `1 - active / total` estimates how far
 *  a batch ("Look up all") has come. Both drop to 0 once nothing is open. */
export interface ActivityCount {
  active: number;
  total: number;
}

export type ActivitySnapshot = Readonly<Record<ActivityKind, ActivityCount>>;

const IDLE: ActivityCount = { active: 0, total: 0 };
let snapshot: ActivitySnapshot = { places: IDLE, addresses: IDLE, sources: IDLE };
const watchers = new Set<() => void>();

function bump(kind: ActivityKind, by: 1 | -1): void {
  const { active, total } = snapshot[kind];
  const next = Math.max(0, active + by);
  snapshot = { ...snapshot, [kind]: next ? { active: next, total: total + (by > 0 ? 1 : 0) } : IDLE };
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
