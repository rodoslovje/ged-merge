import { useCallback, useRef } from "react";

/**
 * An identity-stable wrapper around a handler recreated on every render, so it
 * can be passed to `React.memo` children without busting their prop equality.
 * The wrapper always invokes the latest closure (same latest-ref pattern as
 * EditView's `shortcutRef`). Call it from events/effects only — not during the
 * child's render — so the current render's closure is already in place.
 */
export function useStableHandler<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
