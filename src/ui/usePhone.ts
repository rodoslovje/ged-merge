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
