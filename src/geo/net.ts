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

/** A delay that an abort cuts short — the throttle wait below must not burn
 *  its slot (or hold the queue) for a lookup already abandoned. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason instanceof Error ? signal!.reason : new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One provider's serialized, spaced request queue. Every geo client (GURS RN,
 * GOV, Nominatim) talks to a service with a request-rate policy, and rows fan
 * out concurrently — so each provider funnels its calls through one of these:
 * requests run strictly one after another, each starting at least `intervalMs`
 * after the previous one *started*. A task's failure rejects its own caller
 * and nobody else. An aborted task leaves the queue immediately instead of
 * waiting out its slot.
 */
export function createThrottledQueue(intervalMs: number): <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  let lastStart = 0;
  return function enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = async (): Promise<T> => {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const wait = lastStart + intervalMs - Date.now();
      if (wait > 0) await abortableDelay(wait, signal);
      lastStart = Date.now();
      return task();
    };
    const p = tail.then(run, run);
    tail = p.catch(() => undefined);
    return p;
  };
}

/** Statuses worth one retry: rate limiting and transient gateway trouble. */
const RETRYABLE = new Set([429, 502, 503, 504]);
/** Fallback pause before the one retry, and the cap on a server's Retry-After. */
const RETRY_DELAY_MS = 1_500;
const RETRY_AFTER_CAP_MS = 10_000;

/**
 * `fetch` the way every geo provider needs it: the shared timeout combined
 * with the caller's signal, one polite retry on 429/502/503/504 honouring
 * `Retry-After`, and a thrown `HTTP <status>` on anything else that is not ok
 * — so a rate-limited service reads as "try again in a moment" instead of
 * silently becoming "no such place".
 */
export async function geoFetch(url: string | URL, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  const attempt = () => fetch(url, { ...init, signal: timeoutSignal(GEO_FETCH_TIMEOUT_MS, signal) });
  let res = await attempt();
  if (RETRYABLE.has(res.status)) {
    const after = Number(res.headers.get("Retry-After"));
    const pause = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, RETRY_AFTER_CAP_MS) : RETRY_DELAY_MS;
    await abortableDelay(pause, signal);
    res = await attempt();
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}
