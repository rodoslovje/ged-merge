import type { KeyboardEvent } from "react";

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "range", "color"]);

/**
 * Where focus goes when a field is left. Blurring to nowhere would drop focus
 * on `<body>`, which throws away the tab position — the next Tab would start
 * again at the top of the page. Focusing the row/section the field sits in
 * keeps it: Tab carries on from there, and the bare app keys work again
 * because a container is not a typing surface.
 */
const FIELD_HOST = ".edit-event, .edit-record-section, .edit-person-header, .edit-family";

/** Leave `el`: commit it (edit fields write on blur) and park focus on its
 *  row, falling back to a plain blur where there is no row to park on. */
export function leaveField(el: HTMLElement): void {
  const host = el.closest<HTMLElement>(FIELD_HOST);
  if (!host) {
    el.blur();
    return;
  }
  // The host is a focus holder, never a tab stop — set once, on first use.
  if (!host.hasAttribute("tabindex")) host.tabIndex = -1;
  host.focus();
}

/**
 * Enter commits the edit field you're typing in and hands the keyboard back to
 * the app. Edit fields write on blur, so leaving *is* the commit — and with
 * focus out of the field, the bare app keys work again: `M` switches to Merge
 * instead of typing an "m" into the place you just finished.
 *
 * Left alone:
 *   • textareas — Enter means a line break there (Escape leaves those) — and
 *     the DropdownMenu triggers, whose Enter opens the menu (they are buttons);
 *   • a field that already consumed Enter itself (picking a place suggestion,
 *     choosing a relative, stepping to the next field of an event row),
 *     signalled the usual way with `preventDefault`;
 *   • anything inside a dialog, which runs its own keyboard rules.
 */
export function commitFieldOnEnter(e: KeyboardEvent): void {
  if (e.key !== "Enter" || e.defaultPrevented) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  const el = e.target as HTMLInputElement | null;
  if (!el || el.tagName !== "INPUT" || el.closest(".modal-overlay")) return;
  // Only typing fields: a checkbox/radio has nothing to commit, and leaving it
  // would throw away the tab position for no gain.
  if (NON_TEXT_INPUTS.has(el.type)) return;
  e.preventDefault();
  leaveField(el);
}

/**
 * Escape leaves the field you're typing in, keeping what you typed — the same
 * commit clicking elsewhere makes. It is the way out of a field that Enter
 * cannot open: a note's textarea (Enter breaks the line there), and an event
 * added from a shortcut whose date you don't have, where the keyboard would
 * otherwise be stuck in an input with `⌫` (go back) typing into it.
 *
 * Left alone: a field that answered Escape itself — a place autocomplete only
 * closes its suggestion list on the first press, so a second one leaves the
 * field — and anything inside a dialog, where Escape closes the dialog.
 */
export function leaveFieldOnEscape(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  const el = e.target as HTMLInputElement | null;
  if (!el || el.closest(".modal-overlay")) return;
  if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return;
  if (el.tagName === "INPUT" && NON_TEXT_INPUTS.has(el.type)) return;
  e.preventDefault();
  leaveField(el);
}

/** Both field keys, as one handler for the Edit view's key listener. */
export function editFieldKeys(e: KeyboardEvent): void {
  commitFieldOnEnter(e);
  leaveFieldOnEscape(e);
}
