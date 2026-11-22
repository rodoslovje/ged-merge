import { beforeEach, describe, expect, it } from "vitest";
import { clearSavedCalendars, readSavedCalendar, writeSavedCalendar } from "./stored";

describe("saved calendars", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as Storage;
  });

  it("are kept per file and recipient, and forgotten all at once", () => {
    writeSavedCalendar("Novak.ged", "@I1@", { scheme: "sea" });
    writeSavedCalendar("Novak.ged", "@I5@", { scheme: "autumn" });
    // The file's name is keyed as the other per-file choices are: case and save stem aside.
    expect(readSavedCalendar("novak.gedmerge.ged", "@I1@")).toEqual({ scheme: "sea" });
    expect(readSavedCalendar("Novak.ged", "@I5@")).toEqual({ scheme: "autumn" });
    expect(readSavedCalendar("Kos.ged", "@I1@")).toBeUndefined();
    clearSavedCalendars();
    expect(readSavedCalendar("Novak.ged", "@I1@")).toBeUndefined();
  });

  it("read nothing from a broken store", () => {
    store.set("gedmerge.calendar", "{not json");
    expect(readSavedCalendar("Novak.ged", "@I1@")).toBeUndefined();
  });
});
