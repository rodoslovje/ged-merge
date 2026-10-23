import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsStore } from "./SettingsContext";

/** Preferences live in localStorage; the save report is one of them, opt-in. */

let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
});

describe("settings store: the save report", () => {
  it("is off until the reader ticks it", () => {
    expect(createSettingsStore().get().saveReport).toBe(false);
  });

  it("stays ticked across a reload", () => {
    const store = createSettingsStore();
    const heard = vi.fn();
    store.subscribe(heard);
    store.set({ saveReport: true });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.get("gedmerge.settings")!).saveReport).toBe(true);
    expect(createSettingsStore().get().saveReport).toBe(true);
    store.set({ saveReport: false });
    expect(createSettingsStore().get().saveReport).toBe(false);
  });

  it("reads a stored value that is not a boolean as off", () => {
    storage.set("gedmerge.settings", JSON.stringify({ saveReport: "yes" }));
    expect(createSettingsStore().get().saveReport).toBe(false);
    storage.set("gedmerge.settings", "{not json");
    expect(createSettingsStore().get().saveReport).toBe(false);
  });

  it("keeps working in memory when storage refuses the write", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    });
    const store = createSettingsStore();
    store.set({ saveReport: true });
    expect(store.get().saveReport).toBe(true);
  });
});

describe("settings store: the file author's name", () => {
  it("is empty until the reader types one, and survives a reload as typed", () => {
    expect(createSettingsStore().get().authorName).toBe("");
    createSettingsStore().set({ authorName: "Ana Novak " });
    expect(createSettingsStore().get().authorName).toBe("Ana Novak ");
  });

  it("reads a stored non-string as empty and folds a line break into a space", () => {
    storage.set("gedmerge.settings", JSON.stringify({ authorName: 42 }));
    expect(createSettingsStore().get().authorName).toBe("");
    storage.set("gedmerge.settings", JSON.stringify({ authorName: "Ana\nNovak" }));
    expect(createSettingsStore().get().authorName).toBe("Ana Novak");
  });
});
