import type { KeyboardEvent } from "react";

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "range", "color"]);

/**
 * Enter commits the edit field you're typing in and hands the keyboard back to
 * the app. Edit fields write on blur, so blurring *is* the commit — and with
 * focus out of the field, the bare app keys work again: `M` switches to Merge
 * instead of typing an "m" into the place you just finished.
 *
 * Left alone:
 *   • textareas — Enter means a line break there — and the DropdownMenu
 *     triggers, whose Enter opens the menu (they are buttons);
 *   • a field that already consumed Enter itself (picking a place suggestion,
 *     choosing a relative), signalled the usual way with `preventDefault`;
 *   • anything inside a dialog, which runs its own keyboard rules.
 */
export function commitFieldOnEnter(e: KeyboardEvent): void {
  if (e.key !== "Enter" || e.defaultPrevented) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  const el = e.target as HTMLInputElement | null;
  if (!el || el.tagName !== "INPUT" || el.closest(".modal-overlay")) return;
  // Only typing fields: a checkbox/radio has nothing to commit, and blurring it
  // would throw away the tab position for no gain.
  if (NON_TEXT_INPUTS.has(el.type)) return;
  e.preventDefault();
  el.blur();
}
