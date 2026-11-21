import { useEffect, useMemo, useState, type DependencyList } from "react";
import type { SlicedBuild } from "../tools/sliced";

/** Work done at once, in the render that starts a build: a file of ordinary
 *  size is finished within it, so its panel never shows a loading state. */
const FIRST_SLICE_MS = 40;
/** Work per later slice: long enough to make headway, short enough that the
 *  page paints and answers between slices. */
const SLICE_MS = 14;

/**
 * A whole-file build run in slices on the main thread (see `tools/sliced`).
 * `start` makes a new build whenever `deps` change; the result is `undefined`
 * until it is finished, and `progress` runs 0…1 meanwhile.
 */
export function useSlicedBuild<T>(start: () => SlicedBuild<T>, deps: DependencyList): { result: T | undefined; progress: number } {
  const build = useMemo(() => {
    const b = start();
    b.step(FIRST_SLICE_MS);
    return b;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller's deps say when to start again
  }, deps);
  // Re-renders as the build moves on: the build itself is the state.
  const [, setShown] = useState(0);

  useEffect(() => {
    if (build.result !== undefined) return;
    let timer: number | undefined;
    let percent = Math.floor(build.progress * 100);
    const run = () => {
      const done = build.step(SLICE_MS);
      const now = done ? 100 : Math.floor(build.progress * 100);
      // The end always shows: a build may report 100 % a step before it is done.
      if (done || now !== percent) {
        percent = now;
        setShown((n) => n + 1);
      }
      timer = done ? undefined : window.setTimeout(run, 0);
    };
    timer = window.setTimeout(run, 0);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [build]);

  return { result: build.result, progress: build.progress };
}
