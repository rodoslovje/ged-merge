/**
 * Add source dialogs confirmed while their page lookup was still running —
 * each entry settles once its Add has been written. Save waits for them, so
 * the file it writes holds every source the user has added.
 */
const pending = new Set<Promise<void>>();

/** Track an Add that is waiting for its lookup. Called after the dialog has
 *  handed the promise to its caller, whose write is then chained first and
 *  done by the time this entry settles. */
export function trackPendingAdd(done: Promise<unknown>): void {
  const settled = done.then(() => undefined, () => undefined);
  pending.add(settled);
  void settled.then(() => pending.delete(settled));
}

export function hasPendingAdds(): boolean {
  return pending.size > 0;
}

/** Resolves once no Add is waiting any more — including one confirmed while
 *  the earlier ones were still on their way. */
export async function pendingAddsSettled(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}
