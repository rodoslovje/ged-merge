import { useEffect, useState } from "react";

/** The phone breakpoint, in step with the `720px` media queries in index.css. */
export const PHONE_QUERY = "(max-width: 720px)";

/**
 * True on phone-sized viewports. Most of the responsive work is CSS, but a few
 * places need the layout decision in JS rather than in a media query: where the
 * phone layout renders a *different* component tree (the header's ☰ menu owns
 * the start-person picker instead of the header row) or where an inline style
 * computed in JS has to be skipped (the coordinate picker positions its popover
 * from the pin on a desktop and fills the screen on a phone).
 */
/**
 * Height of the chrome pinned over the top of the page, in px — the app header,
 * which the phone layout makes `position: sticky` because the document itself
 * is the scroller there. Anything that scrolls a row to `scrollTop` has to
 * subtract this, or the row lands *behind* the header instead of under it.
 * Zero on the desktop layout, where the header is not sticky and lists scroll
 * inside their own box.
 */
export function useStickyHeaderInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const head = document.querySelector(".app:not(.tree-shell) > .app-head");
    if (!(head instanceof HTMLElement)) return;
    const measure = () => {
      const sticky = getComputedStyle(head).position === "sticky";
      setInset(sticky ? Math.round(head.getBoundingClientRect().height) + 8 : 0);
    };
    measure();
    // The header grows and shrinks in place — the Save/Undo row appears with the
    // first edit — so watch the element, not just the breakpoint.
    const ro = new ResizeObserver(measure);
    ro.observe(head);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return inset;
}

export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(mq.matches);
    mq.addEventListener("change", onChange);
    // The query can have changed between the initial state and this effect.
    onChange();
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return phone;
}
