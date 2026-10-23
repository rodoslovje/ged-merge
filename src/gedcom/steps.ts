/**
 * A long pass written as a generator that yields between pieces of work, so
 * a caller on the main thread can spread it over several tasks (and let the
 * page paint between them) while every other caller runs it straight through
 * with {@link runSteps} — one implementation, two schedules.
 */
export type Steps<T> = Generator<void, T, void>;

/** Run a stepped pass to its end, synchronously. */
export function runSteps<T>(steps: Steps<T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}
