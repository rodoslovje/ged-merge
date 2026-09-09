import { useEffect, useRef, type RefObject } from "react";

/**
 * The keyboard every list shares — the match list, the duplicate pairs, the
 * health check's findings, the search results, the relative picker. One
 * highlighted row, stepped with ↑/↓, taken to the ends with Home/End, and
 * opened with Enter. The row is the caller's state (a virtual list may not
 * have the element mounted at all), so the helper only says which index comes
 * next.
 */
export interface ListKeyModel {
  count: number;
  /** The highlighted row; −1 when none is. */
  index: number;
  setIndex: (index: number) => void;
  onEnter?: (index: number) => void;
  /** ←/→ step too — the keys Merge and Tools had for their lists before ↑/↓
   *  joined them, kept so a hand used to them is not corrected. */
  horizontal?: boolean;
}

/** Answer a list key; true when the key was one and has been handled. */
export function handleListKey(e: { key: string; preventDefault(): void }, m: ListKeyModel): boolean {
  if (m.count === 0) return false;
  const last = m.count - 1;
  let next: number | undefined;
  switch (e.key) {
    case "ArrowDown": next = m.index < 0 ? 0 : Math.min(m.index + 1, last); break;
    case "ArrowUp": next = m.index < 0 ? last : Math.max(m.index - 1, 0); break;
    case "ArrowRight": if (m.horizontal) next = m.index < 0 ? 0 : Math.min(m.index + 1, last); break;
    case "ArrowLeft": if (m.horizontal) next = m.index < 0 ? last : Math.max(m.index - 1, 0); break;
    case "Home": next = 0; break;
    case "End": next = last; break;
    case "Enter":
      if (!m.onEnter || m.index < 0 || m.index > last) return false;
      e.preventDefault();
      m.onEnter(m.index);
      return true;
  }
  if (next === undefined) return false;
  e.preventDefault();
  if (next !== m.index) m.setIndex(next);
  return true;
}

/**
 * Keeps the keyboard in a list whose rows come and go. A row that is decided,
 * fixed or merged away unmounts with the control that was focused inside it,
 * and the browser drops focus to the body — the next Tab then restarts at the
 * top of the page. This watches for that and parks focus on the list itself
 * (give it `tabIndex={-1}`), from where the list keys keep working. A virtual
 * list scrolling a focused row out of its window is caught the same way.
 */
export function useListFocusKeeper<T extends HTMLElement>(existing?: RefObject<T | null>): RefObject<T | null> {
  const own = useRef<T>(null);
  const ref = existing ?? own;
  const wasInside = useRef(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    function onFocusIn() { wasInside.current = true; }
    function onFocusOut(e: FocusEvent) {
      // Focus going somewhere real is the user's doing; a null target is the
      // browser losing it, which the effect below repairs.
      if (e.relatedTarget) wasInside.current = false;
    }
    node.addEventListener("focusin", onFocusIn);
    node.addEventListener("focusout", onFocusOut);
    return () => {
      node.removeEventListener("focusin", onFocusIn);
      node.removeEventListener("focusout", onFocusOut);
    };
  }, [ref]);

  // After every render: the list was where the keyboard lived and now nothing
  // has it — take it back.
  useEffect(() => {
    if (!wasInside.current || document.activeElement !== document.body) return;
    ref.current?.focus({ preventScroll: true });
  });

  return ref;
}
