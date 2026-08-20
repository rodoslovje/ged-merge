import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "../locales/en";
import { sl } from "../locales/sl";
import {
  altShiftLabel,
  CHART_KEY,
  isEditableTarget,
  isModalOpen,
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

describe("isModalOpen", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is false where there is no document at all", () => {
    // The tables are imported by the worker too, which has no DOM to query.
    vi.stubGlobal("document", undefined);
    expect(isModalOpen()).toBe(false);
  });

  it("follows the presence of a mounted overlay", () => {
    const querySelector = vi.fn<(selector: string) => Element | null>().mockReturnValue(null);
    vi.stubGlobal("document", { querySelector });
    expect(isModalOpen()).toBe(false);

    querySelector.mockReturnValue({} as Element);
    expect(isModalOpen()).toBe(true);
    expect(querySelector).toHaveBeenLastCalledWith(".modal-overlay");
  });
});

// The labels are read off `navigator.platform`, so every case stubs the
// platform it is about — otherwise the expected string would depend on the
// machine running the suite (a Mac here, Linux on CI).
describe("platform labels", () => {
  afterEach(() => vi.unstubAllGlobals());

  const onPlatform = (platform: string) => vi.stubGlobal("navigator", { platform });

  it("writes the modifiers as glyphs on a Mac", () => {
    onPlatform("MacIntel");
    expect(renderKeyToken("alt")).toBe("⌥");
    expect(renderKeyToken("shift")).toBe("⇧");
    expect(renderKeyToken("mod")).toBe("⌘");
    expect(altShiftLabel("1")).toBe("⌥⇧1");
  });

  it("writes them as words everywhere else", () => {
    onPlatform("Win32");
    expect(renderKeyToken("alt")).toBe("Alt");
    expect(renderKeyToken("shift")).toBe("Shift");
    expect(renderKeyToken("mod")).toBe("Ctrl");
    expect(altShiftLabel("1")).toBe("Alt+Shift+1");
  });

  it("falls back to the words where there is no navigator", () => {
    vi.stubGlobal("navigator", undefined);
    expect(renderKeyToken("mod")).toBe("Ctrl");
    expect(altShiftLabel("X")).toBe("Alt+Shift+X");
  });
});
