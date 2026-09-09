import type { KeyboardEvent } from "react";

/**
 * A row of tabs is one Tab stop: the selected tab, and ←/→ (or ↑/↓), Home and
 * End move along the row, selecting as they go — the pattern a `role="tablist"`
 * announces. Put this on the tablist element and give each tab
 * `tabIndex={tabIndexFor(selected)}`.
 */
export function tablistKeyDown(e: KeyboardEvent<HTMLElement>): void {
  const delta =
    e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
    : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1
    : 0;
  if (delta === 0 && e.key !== "Home" && e.key !== "End") return;
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])'));
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  if (at < 0 || tabs.length === 0) return;
  const next =
    e.key === "Home" ? 0
    : e.key === "End" ? tabs.length - 1
    : (at + delta + tabs.length) % tabs.length;
  e.preventDefault();
  tabs[next].focus();
  tabs[next].click();
}

/** The selected tab is the row's Tab stop; the others are reached with the arrows. */
export function tabIndexFor(selected: boolean): 0 | -1 {
  return selected ? 0 : -1;
}
