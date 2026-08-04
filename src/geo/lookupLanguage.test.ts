import { describe, expect, it } from "vitest";
import { placeLookupLanguage } from "./lookupLanguage";

describe("placeLookupLanguage", () => {
  it("asks in English for a file that writes its countries in English", () => {
    // The case this exists for: a Slovenian interface over an American file.
    expect(placeLookupLanguage("Joliet Township, , Will, Illinois, United States", "sl")).toBe("en");
    expect(placeLookupLanguage("Kranj, Slovenia", "sl")).toBe("en");
  });

  it("keeps the reader's language when the file writes in it", () => {
    expect(placeLookupLanguage("Kranj, Slovenija", "sl")).toBe("sl");
    expect(placeLookupLanguage("Ravna Gora, Primorje-Gorski Kotar, Hrvaška", "sl")).toBe("sl");
  });

  it("falls back to the reader's language when the place names no country it knows", () => {
    expect(placeLookupLanguage("Kranj", "sl")).toBe("sl");
    expect(placeLookupLanguage("", "sl")).toBe("sl");
    // Austria-Hungary is not a country any register knows today.
    expect(placeLookupLanguage("Krainburg, Krain, Österreich-Ungarn", "sl")).toBe("sl");
  });

  it("asks in the file's language under an English interface too", () => {
    expect(placeLookupLanguage("Kranj, Slovenia", "en")).toBe("en");
    // The file writes Slovenian, so the answer should come back Slovenian —
    // the register's spelling is what a proposal is composed from.
    expect(placeLookupLanguage("Kranj, Slovenija", "en")).toBe("sl");
  });

  it("recognizes a neighbour's language the app itself does not speak", () => {
    expect(placeLookupLanguage("Wien, Österreich", "sl")).toBe("de");
    expect(placeLookupLanguage("Zagreb, Hrvatska", "en")).toBe("hr");
  });
});
