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
  if (keyRef.current !== itemsKey || m.count !== count) {
    keyRef.current = itemsKey;
    m.clear();
    m.setCount(count);
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
    const freq = new Map<number, number>();
    let el = tp.nextElementSibling;
    let i = rendered.current.start;
    while (el && el !== bt) {
      const h = el.getBoundingClientRect().height;
      if (h > 0) {
        found.push([i, h]);
        const r = Math.round(h);
        freq.set(r, (freq.get(r) ?? 0) + 1);
      }
      el = el.nextElementSibling;
      i++;
    }
    // Adopt the dominant rendered height as the common one, so a layout switch
    // (e.g. rows wrapping to two lines at a narrower width) re-bases everything
    // instead of piling up per-row corrections.
    let best = 0;
    let bestN = 0;
    for (const [h, n] of freq) {
      if (n > bestN) {
        best = h;
        bestN = n;
      }
    }
    let changed = bestN >= 3 ? m.rebase(best) : false;
    for (const [idx, h] of found) changed = m.measure(idx, h) || changed;
    return changed;
  }, [m]);

  const onScrollOrResize = useCallback(() => {
    const next = getSlice.current();
    const cur = rendered.current;
    if (next.start !== cur.start || next.end !== cur.end) bump();
  }, []);

  // Attach the scroll listener / resize observer to the (possibly changing)
  // scroll container, and re-measure after every commit.
  const attached = useRef<{ el: HTMLElement; target: HTMLElement | Window; ro: ResizeObserver } | null>(null);
  useLayoutEffect(() => {
    const sc = scroller.current;
    if (attached.current && attached.current.el !== sc) {
      attached.current.target.removeEventListener("scroll", onScrollOrResize);
      attached.current.ro.disconnect();
      attached.current = null;
    }
    if (sc && !attached.current) {
      const target: HTMLElement | Window = sc === document.scrollingElement ? window : sc;
      target.addEventListener("scroll", onScrollOrResize, { passive: true });
      const ro = new ResizeObserver(() => {
        if (measureRendered()) bump();
        else onScrollOrResize();
      });
      ro.observe(sc);
      attached.current = { el: sc, target, ro };
    }
    // Real row heights arrived (or changed) — re-render with corrected spacers.
    if (measureRendered()) bump();
    else onScrollOrResize();
  });
  useLayoutEffect(
    () => () => {
      if (attached.current) {
        attached.current.target.removeEventListener("scroll", onScrollOrResize);
        attached.current.ro.disconnect();
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
