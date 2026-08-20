import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Makes a modal keyboard-complete: Escape closes it, Tab/Shift+Tab cycle within
 * it (focus trap), focus moves inside on open, and the previously focused
 * element is restored on close. Attach the returned ref to the modal's inner
 * container (the element that should hold focus — give it `tabIndex={-1}`).
 *
 * Keydown is bound to the container, not the window, so the trap only governs
 * keys while focus is inside the dialog and never competes with global app
 * shortcuts elsewhere.
 */
export function useModalKeyboard<T extends HTMLElement = HTMLDivElement>(
  active: boolean,
  onClose: () => void,
) {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    const prevFocus = document.activeElement as HTMLElement | null;

    const focusable = () =>
      node
        ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
            (el) => el.offsetParent !== null || el === document.activeElement,
          )
        : [];

    // Move focus inside: first focusable control, else the container itself.
    // A dialog that autofocuses a field of its own has already placed the
    // caret by now — React's `autoFocus` runs on mount, ahead of this effect —
    // and taking it back to the close button would undo the dialog's own
    // answer to "where does typing go?".
    if (!node?.contains(document.activeElement)) (focusable()[0] ?? node)?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        // The key is the dialog's, and nothing behind it may act on the same
        // press: closing this modal must not also close the page underneath.
        // A window-level handler cannot tell — by the time it runs, React has
        // already flushed the close and the modal it would have checked for is
        // gone. (This is exactly what the panels' `isModalOpen()` guard was
        // for, and why a modal whose Escape merely bubbled took its page with
        // it.)
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && (activeEl === first || activeEl === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    }

    node?.addEventListener("keydown", onKey);
    return () => {
      node?.removeEventListener("keydown", onKey);
      // Restore focus to wherever it was before the dialog opened.
      prevFocus?.focus?.();
    };
  }, [active]);

  return ref;
}
