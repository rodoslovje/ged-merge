/**
 * A whole-file build that can run in time-bounded slices on the main thread.
 *
 * For results that are as dear to copy as to build: the Batch rows and the
 * Statistics facts of a 494k-person file take 9 s and 8 s to build, and 5 s
 * and 7 s to structured-clone — so building them in a worker would move the
 * work and keep most of the freeze, on the way back. Built here in slices,
 * the page paints between them and nothing is copied.
 *
 * The build is written as a generator that yields its progress (0…1) at each
 * point it can be paused — every few hundred records — and returns the result.
 */
export type BuildSteps<T> = Generator<number, T, void>;

export interface SlicedBuild<T> {
  /** Do about `budgetMs` of work; true when the build has finished. */
  step(budgetMs: number): boolean;
  /** Share of the build done, 0…1; 1 when finished. */
  readonly progress: number;
  /** The result — undefined until the build has finished. */
  readonly result: T | undefined;
}

/** Drive `steps` in slices (see {@link SlicedBuild}). */
export function sliced<T>(steps: BuildSteps<T>): SlicedBuild<T> {
  let progress = 0;
  let done = false;
  let result: T | undefined;
  return {
    get progress() {
      return done ? 1 : progress;
    },
    get result() {
      return result;
    },
    step(budgetMs: number): boolean {
      if (done) return true;
      const deadline = performance.now() + budgetMs;
      do {
        const next = steps.next();
        if (next.done) {
          result = next.value;
          done = true;
          return true;
        }
        progress = next.value;
      } while (performance.now() < deadline);
      return false;
    },
  };
}

/** A build that is already finished — a cached result, handed out as one. */
export function built<T>(result: T): SlicedBuild<T> {
  return { step: () => true, progress: 1, result };
}

/** Run `steps` to the end at once — for callers that need the result now
 *  (a worker, a test, a small file). */
export function finish<T>(steps: BuildSteps<T>): T {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
