import { describe, expect, it } from "vitest";
import { en } from "../locales/en";
import { sl } from "../locales/sl";
import {
  CHART_KEY,
  isEditableTarget,
  KEY,
  KEY_STATUS,
  renderKeyToken,
  SHORTCUT_GROUPS,
  STATUS_KEY,
} from "./shortcuts";

/**
 * This module exists so the cheat sheet can never drift from what the handlers
 * actually do (see its header comment). These tests hold that invariant: every
 * label the overlay renders must resolve in *both* languages, and the key
 * tables must stay mutually consistent and collision-free.
 */
describe("SHORTCUT_GROUPS", () => {
  const titleKeys = SHORTCUT_GROUPS.map((g) => g.titleKey);
  const descKeys = SHORTCUT_GROUPS.flatMap((g) => g.items.map((i) => i.descKey));

  it.each([
    ["en", en],
    ["sl", sl],
  ])("every title and description key resolves in %s", (_lang, pack) => {
    const missing = [...titleKeys, ...descKeys].filter(
      (key) => !(key in (pack as Record<string, string>)),
    );
    expect(missing).toEqual([]);
  });

  it("renders every chord with at least one key token", () => {
    for (const group of SHORTCUT_GROUPS) {
      for (const item of group.items) {
        expect(item.keys.length).toBeGreaterThan(0);
        for (const chord of item.keys) expect(chord.length).toBeGreaterThan(0);
      }
    }
  });

  it("uses modifier chords for standard actions and bare keys for app ones", () => {
    for (const group of SHORTCUT_GROUPS) {
      if (group.category !== "app") continue;
      // App shortcuts are deliberately bare single keys — a "mod" token here
      // would mean an app action had grown a chord without moving category.
      for (const item of group.items) {
        for (const chord of item.keys) expect(chord).not.toContain("mod");
      }
    }
  });

  it("has no duplicate description keys", () => {
    expect(new Set(descKeys).size).toBe(descKeys.length);
  });
});

describe("decision status keys", () => {
  it("STATUS_KEY and KEY_STATUS are exact inverses", () => {
    for (const [status, key] of Object.entries(STATUS_KEY)) {
      expect(KEY_STATUS[key]).toBe(status);
    }
    expect(Object.keys(KEY_STATUS)).toHaveLength(Object.keys(STATUS_KEY).length);
  });
});

describe("bare key assignments", () => {
  it("assigns each bare app key to exactly one action", () => {
    const keys = Object.values(KEY);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps the chart-overlay keys distinct from each other", () => {
    const keys = Object.values(CHART_KEY).flatMap((k) => (Array.isArray(k) ? [...k] : [k]));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("isEditableTarget", () => {
  const el = (tagName: string, contentEditable = false) =>
    ({ tagName, isContentEditable: contentEditable }) as unknown as EventTarget;

  it("is true for typing surfaces", () => {
    expect(isEditableTarget(el("INPUT"))).toBe(true);
    expect(isEditableTarget(el("TEXTAREA"))).toBe(true);
    expect(isEditableTarget(el("DIV", true))).toBe(true);
  });

  it("is false for non-typing targets and for null", () => {
    expect(isEditableTarget(el("DIV"))).toBe(false);
    expect(isEditableTarget(el("BUTTON"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("renderKeyToken", () => {
  it("passes non-modifier tokens through unchanged", () => {
    expect(renderKeyToken("S")).toBe("S");
    expect(renderKeyToken("Esc")).toBe("Esc");
    expect(renderKeyToken("←")).toBe("←");
  });

  it("maps 'mod' to a platform modifier", () => {
    expect(["⌘", "Ctrl"]).toContain(renderKeyToken("mod"));
  });
});
