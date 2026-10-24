import { describe, expect, it } from "vitest";
import type { Translate } from "../locales/i18n";
import { nameTypeLabel } from "./relatives";

const t = ((key: string) => `«${key}»`) as Translate;

describe("nameTypeLabel", () => {
  it("translates a known type in either case", () => {
    expect(nameTypeLabel("married", t)).toBe("«nametype.married»");
    expect(nameTypeLabel("MAIDEN", t)).toBe("«nametype.maiden»");
  });

  it("shows a 7.0 PHRASE in place of the type, translated when it is a word we know", () => {
    expect(nameTypeLabel("OTHER", t, "religious")).toBe("«nametype.religious»");
    expect(nameTypeLabel("OTHER", t, "Klostername")).toBe("Klostername");
  });

  it("shows an unknown type as written", () => {
    expect(nameTypeLabel("Taufname", t)).toBe("Taufname");
  });
});
