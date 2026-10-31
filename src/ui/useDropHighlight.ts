import { useEffect, useState, type DragEvent } from "react";

/**
 * Which drop target a file drag is lighting up, or null — and the guarantee
 * that it goes out again. A drag that crosses a target but ends somewhere else
 * (dropped on another target, abandoned outside the window) never delivers a
 * `drop` there, and its closing `dragleave` fires at whichever child the
 * pointer last sat over; only end-of-drag events on the window reliably put
 * the highlight out, so they are listened to while it is lit.
 */
export function useDropHighlight<T>(): [T | null, (value: T | null) => void] {
  const [lit, setLit] = useState<T | null>(null);
  useEffect(() => {
    if (lit === null) return;
    const clear = () => setLit(null);
    window.addEventListener("drop", clear);
    window.addEventListener("dragend", clear);
    return () => {
      window.removeEventListener("drop", clear);
      window.removeEventListener("dragend", clear);
    };
  }, [lit]);
  return [lit, setLit];
}

/** A `dragleave` that really leaves the target, not one of its children. */
export function leftTarget(e: DragEvent<HTMLElement>): boolean {
  const next = e.relatedTarget as Node | null;
  return !next || !e.currentTarget.contains(next);
}
