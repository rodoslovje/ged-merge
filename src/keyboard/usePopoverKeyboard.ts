import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { isEditableTarget, registerLayer } from "./shortcuts";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface PopoverKeyboardOptions {
  /** ↑/↓ and Home/End walk the popover's controls — a menu of items. Off for
   *  a settings panel, where the arrows belong to its own steppers. */
  arrows?: boolean;
}

/**
 * The keyboard of a toggle-button popover — the Export menu, the chart gear,
 * the phone's ☰ and picker menus. While open: Escape closes it and stops
 * there (the chart page or Tools sub-page behind must not leave on the same
 * press), an outside click closes it, focus moves onto its first control on
 * open and back to the trigger on close, Tab or a click that carries focus
 * out closes it, and ↓ on the trigger opens it. The popover is a registered
 * layer while open, so the bare keys hold off the page behind.
 *
 * The component keeps its own `open` state; the hook is told about it and
 * asks for changes through `setOpen`.
 */
export function usePopoverKeyboard<T extends HTMLElement = HTMLDivElement, B extends HTMLElement = HTMLButtonElement>(
  open: boolean,
  setOpen: (open: boolean) => void,
  options: PopoverKeyboardOptions = {},
) {
  const containerRef = useRef<T>(null);
  const triggerRef = useRef<B>(null);
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /** Close and hand focus back to the trigger. */
  function close() {
    setOpenRef.current(false);
    triggerRef.current?.focus();
  }
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    const release = registerLayer();
    const node = containerRef.current;
    const items = () =>
      node ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null) : [];

    function inside(target: EventTarget | null): boolean {
      return !!target && (!!node?.contains(target as Node) || !!triggerRef.current?.contains(target as Node));
    }

    // The first control takes focus, so the arrows and Enter have something to
    // act on straight away — unless the panel has already placed the caret.
    // The trigger lives inside the container too, and it is what a click
    // leaves focused: focus on it counts as outside the panel.
    const active = document.activeElement;
    const onTrigger = !!triggerRef.current?.contains(active);
    if (onTrigger || !node?.contains(active)) items().find((el) => !triggerRef.current?.contains(el))?.focus();

    function onDown(e: MouseEvent) {
      if (!inside(e.target)) setOpenRef.current(false);
    }

    // On the document, in the bubble phase: a listbox inside the panel that
    // stops its own Escape is never overruled, while the window handlers of
    // the page behind — a chart's "leave", a Tools page's "back" — come after
    // and are stopped here.
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (!optionsRef.current.arrows || !inside(e.target) || isEditableTarget(e.target)) return;
      const list = items();
      if (list.length === 0) return;
      const at = list.indexOf(document.activeElement as HTMLElement);
      let next: number | undefined;
      if (e.key === "ArrowDown") next = at < 0 ? 0 : Math.min(at + 1, list.length - 1);
      else if (e.key === "ArrowUp") next = at < 0 ? list.length - 1 : Math.max(at - 1, 0);
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = list.length - 1;
      if (next === undefined) return;
      e.preventDefault();
      list[next].focus();
    }

    // Focus leaving the panel and its trigger — by Tab, or by a click on
    // another control — takes the panel with it.
    function onFocusOut(e: FocusEvent) {
      if (e.relatedTarget && !inside(e.relatedTarget)) setOpenRef.current(false);
    }

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    node?.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      node?.removeEventListener("focusout", onFocusOut);
      release();
    };
  }, [open]);

  /** ↓ on the trigger opens the popover, as on a select. */
  function onTriggerKeyDown(e: ReactKeyboardEvent) {
    if (open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    setOpenRef.current(true);
  }

  return { containerRef, triggerRef, close, onTriggerKeyDown };
}
