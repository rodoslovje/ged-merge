import { beforeEach, describe, expect, it } from "vitest";
import { defaultPublishOptions } from "./model";
import { clearStoredPublish, mergeStoredOptions, readStoredPublish, writeStoredPublish } from "./stored";

const defaults = defaultPublishOptions("Rodbina", "sl");

describe("mergeStoredOptions", () => {
  it("keeps what was stored, field by field", () => {
    const stored = {
      ...defaults, title: "Novak", living: "hide", intro: { sl: "Pozdravljeni", en: "Hello" }, include: { ...defaults.include, notes: true },
      photoFolders: { portraits: "tray", records: "out", "records/matricula": "pages" },
    };
    expect(mergeStoredOptions(defaults, stored)).toEqual(stored);
  });

  it("keeps a default where the stored value is missing or of the wrong kind", () => {
    const merged = mergeStoredOptions(defaults, { title: 42, exports: true, display: { showAge: "yes" }, include: "all", extra: 1 });
    expect(merged).toEqual({ ...defaults, exports: true });
    expect(mergeStoredOptions(defaults, null)).toBe(defaults);
  });
});

describe("stored choices", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as Storage;
  });

  it("are kept per file and forgotten all at once", () => {
    writeStoredPublish("Novak.ged", { options: { ...defaults, title: "Novak" }, start: "@I1@" });
    writeStoredPublish("Kos.ged", { options: { ...defaults, title: "Kos" } });
    // Keyed as the start person is: the file's name, case and save stem aside.
    expect(readStoredPublish("Novak.gedmerge.ged", defaults)).toEqual({ options: { ...defaults, title: "Novak" }, start: "@I1@" });
    expect(readStoredPublish("Kos.ged", defaults)?.options.title).toBe("Kos");
    clearStoredPublish();
    expect(readStoredPublish("Kos.ged", defaults)).toBeUndefined();
  });
});
