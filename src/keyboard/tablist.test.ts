import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { tabIndexFor, tablistKeyDown } from "./tablist";

/**
 * The helper only touches four DOM surfaces — `currentTarget.querySelectorAll`,
 * `document.activeElement`, `focus()` and `click()` — so a handful of plain
 * objects stand in for a tab row; no jsdom needed.
 */
type FakeTab = { focus: () => void; click: () => void; focused: boolean; clicked: boolean };

function makeRow(count: number, activeAt: number) {
  const tabs: FakeTab[] = Array.from({ length: count }, () => {
    const tab: FakeTab = {
      focused: false,
      clicked: false,
      focus: () => { tab.focused = true; },
      click: () => { tab.clicked = true; },
    };
    return tab;
  });
  vi.stubGlobal("document", { activeElement: activeAt >= 0 ? tabs[activeAt] : null });
  const prevented = { value: false };
  const event = (key: string) =>
    ({
      key,
      currentTarget: { querySelectorAll: () => tabs },
      preventDefault: () => { prevented.value = true; },
    }) as unknown as KeyboardEvent<HTMLElement>;
  return { tabs, event, prevented };
}

afterEach(() => vi.unstubAllGlobals());

describe("tablistKeyDown", () => {
  it("ArrowRight and ArrowDown move to the next tab, selecting it", () => {
    for (const key of ["ArrowRight", "ArrowDown"]) {
      const { tabs, event, prevented } = makeRow(3, 0);
      tablistKeyDown(event(key));
      expect(prevented.value).toBe(true);
      expect(tabs[1].focused && tabs[1].clicked).toBe(true);
      expect(tabs[0].focused || tabs[2].focused).toBe(false);
    }
  });

  it("ArrowLeft and ArrowUp move to the previous tab", () => {
    for (const key of ["ArrowLeft", "ArrowUp"]) {
      const { tabs, event } = makeRow(3, 2);
      tablistKeyDown(event(key));
      expect(tabs[1].focused && tabs[1].clicked).toBe(true);
    }
  });

  it("wraps around at both ends", () => {
    const right = makeRow(3, 2);
    tablistKeyDown(right.event("ArrowRight"));
    expect(right.tabs[0].focused).toBe(true);
    const left = makeRow(3, 0);
    tablistKeyDown(left.event("ArrowLeft"));
    expect(left.tabs[2].focused).toBe(true);
  });

  it("Home and End jump to the first and last tab", () => {
    const home = makeRow(4, 2);
    tablistKeyDown(home.event("Home"));
    expect(home.tabs[0].focused).toBe(true);
    const end = makeRow(4, 1);
    tablistKeyDown(end.event("End"));
    expect(end.tabs[3].focused).toBe(true);
  });

  it("ignores other keys without preventing their default", () => {
    const { tabs, event, prevented } = makeRow(3, 1);
    tablistKeyDown(event("Enter"));
    expect(prevented.value).toBe(false);
    expect(tabs.some((t) => t.focused || t.clicked)).toBe(false);
  });

  it("does nothing when focus is not on a tab of the row", () => {
    const { tabs, event, prevented } = makeRow(3, -1);
    tablistKeyDown(event("ArrowRight"));
    expect(prevented.value).toBe(false);
    expect(tabs.some((t) => t.focused)).toBe(false);
  });

  it("does nothing on an empty row", () => {
    const { event, prevented } = makeRow(0, -1);
    tablistKeyDown(event("End"));
    expect(prevented.value).toBe(false);
  });
});

describe("tabIndexFor", () => {
  it("makes only the selected tab a Tab stop", () => {
    expect(tabIndexFor(true)).toBe(0);
    expect(tabIndexFor(false)).toBe(-1);
  });
});
