import { useEffect, useRef, type RefObject } from "react";
import { registerLayer } from "./shortcuts";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface ModalKeyboardOptions {
  /**
   * The dialog's primary action — what ⌘/Ctrl+Enter does, from any field
   * inside it. Pass `undefined` while the action is unavailable (nothing
   * selected, a required field empty) and the chord does nothing.
   */
  onConfirm?: () => void;
  /**
   * Where focus lands on open. Without it: the first focusable control that
   * is not the × close button, else the container. A dialog whose answer to
   * "where does typing go?" is a field of its own uses `autoFocus` instead —
   * React runs that on mount, ahead of this hook, and the hook then leaves
   * the caret where the dialog put it.
   */
  initialFocus?: RefObject<HTMLElement | null>;
}

/**
 * Makes a modal keyboard-complete: Escape closes it, ⌘/Ctrl+Enter confirms it,
 * Tab/Shift+Tab cycle within it (focus trap), focus moves inside on open, and
 * the previously focused element is restored on close. Attach the returned ref
 * to the modal's inner container (the element that should hold focus — give it
 * `tabIndex={-1}`).
 *
 * Keydown is bound to the container, not the window, so the trap only governs
 * keys while focus is inside the dialog and never competes with global app
 * shortcuts elsewhere. While active the dialog is a registered layer, so
 * `isModalOpen()` holds the bare keys off the page behind it.
 */
export function useModalKeyboard<T extends HTMLElement = HTMLDivElement>(
  active: boolean,
  onClose: () => void,
  options: ModalKeyboardOptions = {},
) {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!active) return;
    const release = registerLayer();
    const node = ref.current;
    const prevFocus = document.activeElement as HTMLElement | null;

    const focusable = () =>
      node
        ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
            (el) => el.offsetParent !== null || el === document.activeElement,
          )
        : [];

    // Move focus inside — unless the dialog has already placed the caret
    // itself (an `autoFocus` field), which taking it back would undo. The ×
    // close button is never the answer: a dialog opening on it makes Enter
    // dismiss it, and Tab walk its whole body before the buttons that matter.
    if (!node?.contains(document.activeElement)) {
      const wanted = optionsRef.current.initialFocus?.current;
      const usable = wanted && !(wanted as HTMLButtonElement).disabled && wanted.offsetParent !== null;
      const target = usable ? wanted : focusable().find((el) => !el.classList.contains("modal-close")) ?? node;
      target?.focus();
    }

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
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        const confirm = optionsRef.current.onConfirm;
        if (!confirm) return;
        e.preventDefault();
        e.stopPropagation();
        confirm();
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
      release();
      // Restore focus to wherever it was before the dialog opened — if that
      // control is still on the page (the button that opened a merge
      // confirmation is often gone by the time it closes).
      if (prevFocus?.isConnected) prevFocus.focus?.();
    };
  }, [active]);

  return ref;
}
