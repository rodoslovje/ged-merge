import { useCallback, useLayoutEffect, useReducer, useRef } from "react";

/**
 * Windowed-list virtualization for the app's long flat lists (match results,
 * health-check findings, duplicate pairs). No dependency: a small model of row
 * offsets fed by real measurements, and a hook that renders only the rows near
 * the viewport between two spacer elements.
 *
 * The model assumes rows share one common height (the `base`) — true for all
 * our lists, whose rows are homogeneous at a given container width — and keeps
 * exact per-row corrections for the exceptions (an expanded duplicate compare,
 * a wrapped message). Offsets therefore stay O(log n) with n in the hundreds
 * of thousands, while the few odd rows stay pixel-accurate.
 */

/** Pure windowing math, separated from the DOM so it can be unit-tested. */
export class VirtualModel {
  /** The common row height; adopted from measurements, starts at the estimate. */
  base: number;
  /** Vertical gap between flex rows (0 for block lists). */
  gap = 0;
  count = 0;

  private heights = new Map<number, number>();
  /** Indices of rows whose measured height deviates from `base`, sorted. */
  private devIdx: number[] = [];
  /** devSum[k] = total deviation of devIdx[0..k], for prefix lookups. */
  private devSum: number[] = [];
  private dirty = false;

  constructor(estimate: number) {
    this.base = Math.max(1, estimate);
  }

  setCount(n: number) {
    if (n !== this.count) {
      this.count = n;
      this.dirty = true;
    }
  }

  setGap(g: number) {
    if (g !== this.gap) {
      this.gap = g;
      this.dirty = true;
    }
  }

  /** Drop all measurements (the row data changed, so indices moved). */
  clear() {
    if (this.heights.size > 0) this.dirty = true;
    this.heights.clear();
  }

  /** Record a measured row height. Returns true if it changed the model. */
  measure(index: number, height: number): boolean {
    if (height <= 0 || index < 0 || index >= this.count) return false;
    const prev = this.heights.get(index);
    if (prev !== undefined && Math.abs(prev - height) < 0.5) return false;
    this.heights.set(index, height);
    this.dirty = true;
    return true;
  }

  /**
   * Adopt a new common row height (e.g. the layout switched to two-line rows).
   * Old measurements were taken at the old layout, so they are dropped.
   */
  rebase(b: number): boolean {
    if (b <= 0 || Math.abs(b - this.base) < 0.5) return false;
    this.base = b;
    this.heights.clear();
    this.dirty = true;
    return true;
  }

  /** Top of row `i` relative to the start of the list (gaps included). */
  offsetOf(i: number): number {
    return i * (this.base + this.gap) + this.deviationBefore(i);
  }

  heightOf(i: number): number {
    return this.heights.get(i) ?? this.base;
  }

  totalHeight(): number {
    return this.offsetOf(this.count);
  }

  /** Index of the row containing list-coordinate `y` (clamped to the list). */
  indexAt(y: number): number {
    if (this.count <= 0 || y <= 0) return 0;
    // offsetOf is monotonic: binary-search the largest i with offsetOf(i) <= y.
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsetOf(mid) <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Rows overlapping the viewport [y0, y1], padded by `overscan` rows. */
  range(y0: number, y1: number, overscan: number): { start: number; end: number } {
    if (this.count === 0) return { start: 0, end: 0 };
    const start = Math.max(0, this.indexAt(Math.max(0, y0)) - overscan);
    const end = Math.min(this.count, this.indexAt(Math.max(0, y1)) + 1 + overscan);
    return { start, end };
  }

  /** Total deviation from `base` across rows 0..i-1. */
  private deviationBefore(i: number): number {
    if (this.dirty) this.rebuild();
    // Rightmost deviation index < i.
    let lo = 0;
    let hi = this.devIdx.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.devIdx[mid] < i) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found < 0 ? 0 : this.devSum[found];
  }

  private rebuild() {
    this.dirty = false;
    const entries: [number, number][] = [];
    for (const [i, h] of this.heights) {
      if (i < this.count && Math.abs(h - this.base) > 0.5) entries.push([i, h]);
    }
    entries.sort((a, b) => a[0] - b[0]);
    this.devIdx = [];
    this.devSum = [];
    let acc = 0;
    for (const [i, h] of entries) {
      this.devIdx.push(i);
      acc += h - this.base;
      this.devSum.push(acc);
    }
  }
}

export interface UseVirtualListOptions {
  /** Total number of rows. */
  count: number;
  /** Expected row height in px, before any real measurement. */
  estimate: number;
  /** Rows rendered beyond each edge of the viewport. */
  overscan?: number;
  /** Lists at or below this many rows render in full — no windowing. */
  threshold?: number;
  /**
   * Identity of the row data (the filtered/sorted array itself). When it
   * changes, cached row measurements are dropped because indices moved.
   */
  itemsKey?: unknown;
  /**
   * Height of sticky content at the top of the scroll container that rows must
   * clear when scrolled into view (mirrors the rows' scroll-margin-top).
   */
  scrollMargin?: number;
}

export interface VirtualSlice {
  /** First rendered row index. */
  start: number;
  /** One past the last rendered row index. */
  end: number;
  /** Height of the spacer standing in for rows 0..start-1. */
  padTop: number;
  /** Height of the spacer standing in for rows end..count-1. */
  padBottom: number;
  /** Ref for the spacer element rendered immediately before the rows. */
  topRef: (el: HTMLElement | null) => void;
  /** Ref for the spacer element rendered immediately after the rows. */
  bottomRef: (el: HTMLElement | null) => void;
  /**
   * Scroll to row `i`. `align: "auto"` (default) moves the minimal amount to
   * bring it into view; `align: "start"` positions it at the top.
   */
  scrollToIndex: (i: number, align?: "auto" | "start") => void;
}

/** Nearest self-or-ancestor that scrolls vertically. */
function findScroller(el: HTMLElement | null): HTMLElement | null {
  for (let node = el; node; node = node.parentElement) {
    if (/auto|scroll|overlay/.test(getComputedStyle(node).overflowY)) return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

/**
 * Top edge of the scrollport in viewport coordinates. For an element scroller
 * that is its own box top — but the document scroller's box top is `-scrollY`,
 * while the edge you actually see through is always 0. Using the box top there
 * makes the visible window drift by a full scroll offset, so the list renders
 * rows nowhere near the ones on screen (blank page at the bottom of a long
 * list). The phone layout scrolls the document, so this path is live.
 */
function scrollportTop(sc: HTMLElement): number {
  return sc === document.scrollingElement ? 0 : sc.getBoundingClientRect().top;
}

/** How many rows to render on the very first pass, before the viewport is known. */
const INITIAL_WINDOW = 40;

/** Re-renders the hook may ask for between two real scroll/resize events. */
const SETTLE_LIMIT = 4;

export function useVirtualList({
  count,
  estimate,
  overscan = 12,
  threshold = 150,
  itemsKey,
  scrollMargin = 0,
}: UseVirtualListOptions): VirtualSlice {
  const [, bump] = useReducer((c: number) => c + 1, 0);

  const model = useRef<VirtualModel | null>(null);
  if (model.current === null) model.current = new VirtualModel(estimate);
  const m = model.current;

  const top = useRef<HTMLElement | null>(null);
  const bottom = useRef<HTMLElement | null>(null);
  const scroller = useRef<HTMLElement | null>(null);

  // Measurements are keyed by index, so they die with the array they measured.
  const keyRef = useRef<unknown>(Symbol());
  // Data set + list width the common row height was last adopted for; see the
  // rebase guard in `measureRendered`.
  const rebasedAt = useRef<{ key: unknown; width: number } | null>(null);
  /**
   * Re-renders this hook has asked for since the last real scroll or resize.
   *
   * The spacers stand in for the unmounted rows at the model's common height,
   * while the mounted rows contribute their true height — so whenever the two
   * disagree by even a fraction of a pixel, the scroller's content height
   * depends on HOW MANY rows are currently mounted. Near the end of the list
   * the browser pins scrollTop to that content height, so a window that grows
   * by one row shifts the scroll offset, which selects the window back one row,
   * which shifts it again. Zoomed to 90% (rows 31.6px tall, base 32) the
   * reported file flips between start=25 and start=26 forever, and React aborts
   * the whole tab with "Maximum update depth exceeded".
   *
   * Adopting an exact base (see `measureRendered`) removes the usual source of
   * that disagreement, but sub-pixel jitter between individual rows can always
   * reintroduce it. So cap the settling: a genuine correction converges in two
   * or three passes, and anything beyond that is a cycle. Being one row off at
   * the edge of the viewport is invisible; a crashed tab is not.
   */
  const settling = useRef(0);
  if (keyRef.current !== itemsKey || m.count !== count) {
    keyRef.current = itemsKey;
    m.clear();
    m.setCount(count);
    settling.current = 0;
  }

  function computeSlice(): { start: number; end: number; padTop: number; padBottom: number } {
    if (count <= threshold) return { start: 0, end: count, padTop: 0, padBottom: 0 };
    const sc = scroller.current;
    const tp = top.current;
    if (!sc || !tp) {
      // First render: refs attach on commit. Render a conservative window and
      // let the layout effect correct it immediately after.
      const end = Math.min(count, INITIAL_WINDOW);
      return { start: 0, end, padTop: 0, padBottom: Math.max(0, m.totalHeight() - m.offsetOf(end)) };
    }
    // Viewport top in list coordinates (0 = top of virtual row 0).
    const y0 = scrollportTop(sc) - tp.getBoundingClientRect().top;
    const vh = sc.clientHeight || window.innerHeight;
    const { start, end } = m.range(y0, y0 + vh, overscan);
    return {
      start,
      end,
      padTop: m.offsetOf(start),
      padBottom: Math.max(0, m.totalHeight() - m.offsetOf(end)),
    };
  }

  const slice = computeSlice();
  const rendered = useRef(slice);
  rendered.current = slice;

  // Latest-closure trampoline so the stable scroll/resize handlers see fresh
  // props and model state.
  const getSlice = useRef(computeSlice);
  getSlice.current = computeSlice;

  /** Measure the rows currently in the DOM (the siblings between the spacers). */
  const measureRendered = useCallback((): boolean => {
    const tp = top.current;
    const bt = bottom.current;
    if (!tp || !bt) return false;
    const found: [number, number][] = [];
    // Rows are bucketed by whole pixels to find the dominant one, but each
    // bucket remembers a REAL measured height. Adopting the rounded number
    // instead would leave `base` permanently off by up to half a pixel per row,
    // and that error is what the spacers vs. the mounted rows disagree about —
    // see the content-height feedback note on `settling` below.
    const freq = new Map<number, { n: number; h: number }>();
    let el = tp.nextElementSibling;
    let i = rendered.current.start;
    while (el && el !== bt) {
      const h = el.getBoundingClientRect().height;
      if (h > 0) {
        found.push([i, h]);
        const r = Math.round(h);
        const bucket = freq.get(r);
        if (bucket) bucket.n++;
        else freq.set(r, { n: 1, h });
      }
      el = el.nextElementSibling;
      i++;
    }
    // Adopt the dominant rendered height as the common one, so a layout switch
    // (e.g. rows wrapping to two lines at a narrower width) re-bases everything
    // instead of piling up per-row corrections.
    let best = 0;
    let bestN = 0;
    for (const { n, h } of freq.values()) {
      if (n > bestN) {
        best = h;
        bestN = n;
      }
    }
    // Rebasing discards every measurement taken so far, so it must not be a
    // per-scroll decision. Findings are grouped by category, so a long list has
    // homogeneous BANDS of differing row height (short one-line messages in one
    // region, ones that wrap at phone width in another). Scrolling across a
    // boundary changes which height dominates the window; the rebase then
    // swings totalHeight by thousands of pixels, which moves the scroll offset
    // (forcibly at the list's end, where it is pinned to the content height),
    // which selects a window back in the previous band. Instrumenting a real
    // 4 MB file showed base flipping 62 -> 80 -> 62 without end, until React
    // bailed out with "Maximum update depth exceeded".
    //
    // Note both sides of that flip were >85% majorities, so a share threshold
    // alone does NOT break the cycle — the load-bearing guard is `layoutChanged`:
    // adopt a base once per data set, and again only when the list's width
    // really changed, which is the layout switch rebasing exists for. Mixed
    // rows still land exactly; that is what the per-row deviation table is for.
    const width = tp.parentElement?.getBoundingClientRect().width ?? 0;
    const prev = rebasedAt.current;
    const layoutChanged =
      prev === null || prev.key !== keyRef.current || Math.abs(prev.width - width) > 0.5;
    let changed = false;
    if (bestN >= 3 && bestN / found.length >= 0.6 && layoutChanged) {
      // Record the decision even when `rebase` is a no-op because the base
      // already matched. Writing this only on a *changed* base left the guard
      // permanently open on every list whose rows happen to be the height the
      // previous list settled on — which is every category the user filters to,
      // since health-check rows all look alike. Instrumenting the reported file
      // showed `layoutChanged` true on all 71 measurement passes of a filtered
      // list: exactly the state this guard exists to prevent.
      rebasedAt.current = { key: keyRef.current, width };
      if (m.rebase(best)) changed = true;
    }
    for (const [idx, h] of found) changed = m.measure(idx, h) || changed;
    return changed;
  }, [m]);

  /** Re-render if the window has moved. Returns whether it asked for one. */
  const syncSlice = useCallback((): boolean => {
    const next = getSlice.current();
    const cur = rendered.current;
    if (next.start === cur.start && next.end === cur.end) return false;
    bump();
    return true;
  }, []);

  // A real scroll or resize: the window is *meant* to move, so let the list
  // settle again from scratch.
  const onScrollOrResize = useCallback(() => {
    settling.current = 0;
    syncSlice();
  }, [syncSlice]);

  /** One post-commit pass: fold in the new measurements, re-render if needed. */
  const settle = useCallback(() => {
    const measured = measureRendered();
    if (settling.current >= SETTLE_LIMIT) return; // cycling — leave it be
    if (measured) {
      settling.current++;
      bump();
    } else if (syncSlice()) {
      settling.current++;
    }
  }, [measureRendered, syncSlice]);

  // Attach the scroll listener / resize observer to the (possibly changing)
  // scroll container, and re-measure after every commit.
  const attached = useRef<{ el: HTMLElement; target: HTMLElement | Window; ro: ResizeObserver | null } | null>(null);
  useLayoutEffect(() => {
    const sc = scroller.current;
    if (attached.current && attached.current.el !== sc) {
      attached.current.target.removeEventListener("scroll", onScrollOrResize);
      attached.current.target.removeEventListener("resize", onScrollOrResize);
      attached.current.ro?.disconnect();
      attached.current = null;
    }
    if (sc && !attached.current) {
      const isDoc = sc === document.scrollingElement;
      const target: HTMLElement | Window = isDoc ? window : sc;
      target.addEventListener("scroll", onScrollOrResize, { passive: true });
      let ro: ResizeObserver | null = null;
      if (isDoc) {
        // Never observe the document scroller: its height IS this list's own
        // output (the spacers), so every re-render would come straight back in
        // as a resize — re-render, resize, re-render, until React gives up with
        // "Maximum update depth exceeded". An element scrollport is safe to
        // observe because its box is fixed by layout, independent of content.
        // What the window scroller actually needs to hear about is the viewport
        // changing size, which is what `resize` reports.
        window.addEventListener("resize", onScrollOrResize);
      } else {
        ro = new ResizeObserver(() => {
          // The scrollport itself changed size — a real layout change, so the
          // settle budget starts over.
          settling.current = 0;
          settle();
        });
        ro.observe(sc);
      }
      attached.current = { el: sc, target, ro };
    }
    // Real row heights arrived (or changed) — re-render with corrected spacers.
    settle();
  });
  useLayoutEffect(
    () => () => {
      if (attached.current) {
        attached.current.target.removeEventListener("scroll", onScrollOrResize);
        attached.current.target.removeEventListener("resize", onScrollOrResize);
        attached.current.ro?.disconnect();
        attached.current = null;
      }
    },
    [onScrollOrResize],
  );

  const scrollMarginRef = useRef(scrollMargin);
  scrollMarginRef.current = scrollMargin;
  const scrollToIndex = useCallback(
    (i: number, align: "auto" | "start" = "auto") => {
      const sc = scroller.current;
      const tp = top.current;
      if (!sc || !tp || i < 0 || i >= m.count) return;
      const listStart = tp.getBoundingClientRect().top - scrollportTop(sc) + sc.scrollTop;
      const rowTop = listStart + m.offsetOf(i);
      if (align === "start") {
        sc.scrollTop = rowTop - scrollMarginRef.current;
        return;
      }
      const rowBottom = rowTop + m.heightOf(i);
      if (rowTop < sc.scrollTop + scrollMarginRef.current) {
        sc.scrollTop = rowTop - scrollMarginRef.current;
      } else if (rowBottom > sc.scrollTop + sc.clientHeight) {
        sc.scrollTop = rowBottom - sc.clientHeight;
      }
    },
    [m],
  );

  const topRef = useCallback((el: HTMLElement | null) => {
    top.current = el;
    if (el) {
      scroller.current = findScroller(el.parentElement);
      const gap = el.parentElement ? parseFloat(getComputedStyle(el.parentElement).rowGap) : 0;
      model.current!.setGap(Number.isFinite(gap) ? gap : 0);
    }
  }, []);
  const bottomRef = useCallback((el: HTMLElement | null) => {
    bottom.current = el;
  }, []);

  return { ...slice, topRef, bottomRef, scrollToIndex };
}
