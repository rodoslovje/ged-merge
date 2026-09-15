import { useEffect, useRef, useState, type RefObject } from "react";
import type { Sex } from "../gedcom/types";
import type { Lineage } from "../match/kinship";

// The chart hover card's engine: one delegated pointer listener on the canvas
// resolves the `[data-key]` node under the pointer, waits a beat, and asks the
// host what to say about it. Nothing is attached per node, and the card is
// gone the moment the pointer leaves, the canvas scrolls or a press begins.
// Keyboard focus shows the same card under the focused node.

export interface HoverInfo {
  name: string;
  /** Colours the name; undefined leaves it plain (a redacted person). */
  sex?: Sex | string;
  /** The lifespan, with the age when shown — beside the name, as Edit's cards
   *  and the people list write it. */
  years?: string;
  place?: string;
  kinship?: string;
  kinshipLineage?: Lineage;
  /** A muted last line ("Click to see full details"). */
  hint?: string;
}

export interface ChartHover {
  key: string;
  /** Anchor in the canvas's own coordinates. */
  x: number;
  y: number;
  /** The anchor sits in the right / lower half: the card opens the other way. */
  right: boolean;
  below: boolean;
  info: HoverInfo;
}

const SHOW_DELAY_MS = 220;

export function useChartHover(canvasRef: RefObject<HTMLElement | null>, infoFor: (key: string) => HoverInfo | undefined): ChartHover | null {
  const [hover, setHover] = useState<Omit<ChartHover, "info"> | null>(null);
  const infoRef = useRef(infoFor);
  infoRef.current = infoFor;
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    let key: string | null = null;
    let visible = false;
    let timer = 0;
    let raf = 0;
    let pos = { x: 0, y: 0 };
    // The canvas's screen rect, read once per node the pointer enters rather
    // than on every move: reading it is a forced layout, and a mouse delivers
    // many moves per frame over a chart of thousands of nodes. Anything that
    // could move the canvas under the pointer (a scroll, a wheel, a press)
    // hides the card, and `hide` drops the rect with it.
    let rect: DOMRect | null = null;
    const place = (clientX: number, clientY: number) => {
      rect ??= el.getBoundingClientRect();
      pos = { x: clientX - rect.left, y: clientY - rect.top };
    };
    const show = () => {
      if (!key) return;
      visible = true;
      setHover({ key, x: pos.x, y: pos.y, right: pos.x > el.clientWidth / 2, below: pos.y > el.clientHeight / 2 });
    };
    const hide = () => {
      key = null;
      visible = false;
      rect = null;
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      timer = 0;
      raf = 0;
      setHover(null);
    };
    const keyAt = (target: EventTarget | null) =>
      (target as Element | null)?.closest?.("[data-key]")?.getAttribute("data-key") ?? null;
    const onOver = (e: PointerEvent) => {
      const k = keyAt(e.target);
      if (k === key) return;
      hide();
      if (!k) return;
      key = k;
      place(e.clientX, e.clientY);
      timer = window.setTimeout(show, SHOW_DELAY_MS);
    };
    // The card follows the pointer once shown — one update per frame, however
    // many moves arrived.
    const onMove = (e: PointerEvent) => {
      if (!key) return;
      place(e.clientX, e.clientY);
      if (visible && !raf) raf = requestAnimationFrame(() => { raf = 0; show(); });
    };
    // A press hides the card and then focuses the node it opened — the browser
    // runs that focus as the press's own default action, in the same task — so
    // the focus handler has to let it pass or the card springs straight back
    // up beside the panel the click just opened. The next task clears the flag,
    // leaving a keyboard focus (which follows no press) to show the card.
    let pressing = false;
    const onDown = () => {
      pressing = true;
      window.setTimeout(() => { pressing = false; }, 0);
      hide();
    };
    const onFocus = (e: FocusEvent) => {
      const target = (e.target as Element | null)?.closest?.("[data-key]");
      const k = target?.getAttribute("data-key");
      if (!target || !k || pressing) return;
      hide();
      key = k;
      const r = target.getBoundingClientRect();
      place(r.left + r.width / 2, r.bottom);
      show();
    };
    el.addEventListener("pointerover", onOver);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", hide);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("scroll", hide, { passive: true });
    el.addEventListener("wheel", hide, { passive: true });
    el.addEventListener("focusin", onFocus);
    el.addEventListener("focusout", hide);
    return () => {
      hide();
      el.removeEventListener("pointerover", onOver);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", hide);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("scroll", hide);
      el.removeEventListener("wheel", hide);
      el.removeEventListener("focusin", onFocus);
      el.removeEventListener("focusout", hide);
    };
  }, [canvasRef]);
  if (!hover) return null;
  const info = infoRef.current(hover.key);
  return info ? { ...hover, info } : null;
}
