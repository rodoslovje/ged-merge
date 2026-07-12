import type { KeyboardEvent } from "react";

/** A native `<select>` doesn't open on Enter on macOS (only Space), so open its
 * picker explicitly on Enter — this makes the select-based menus (event-type ▾,
 * "+ Add" field list, the add-event/source chips) fully keyboard-operable. */
export function openPickerOnEnter(e: KeyboardEvent<HTMLSelectElement>) {
  if (e.key !== "Enter") return;
  const el = e.currentTarget as HTMLSelectElement & { showPicker?: () => void };
  if (typeof el.showPicker === "function") {
    e.preventDefault();
    try {
      el.showPicker();
    } catch {
      /* not supported / not allowed in this context */
    }
  }
}
