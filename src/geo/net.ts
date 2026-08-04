/**
 * A signal that aborts after `ms`, combined with the caller's own signal when
 * there is one. Every geo client (GURS RN, Nominatim, GOV) sends its requests
 * through a shared module-level throttle queue, so a single stalled connection
 * would otherwise wedge *every* later lookup app-wide behind it until the
 * browser gave up — minutes of "searching…" with no way out.
 */
export function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  // Modern browsers (and Node ≥ 20 in tests) have the combinators.
  if (typeof AbortSignal.timeout === "function" && typeof AbortSignal.any === "function") {
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), ms);
  if (signal) {
    const follow = () => {
      clearTimeout(timer);
      ctrl.abort(signal.reason);
    };
    if (signal.aborted) follow();
    else signal.addEventListener("abort", follow, { once: true });
  }
  return ctrl.signal;
}

/** How long one register/geocoder request may run before it is cut loose. */
export const GEO_FETCH_TIMEOUT_MS = 20_000;
