import { describe, it, expect } from "vitest";
import {
  countrySpelling,
  detectHomeCountry,
  resolveHomeCountry,
  HOME_COUNTRY_AUTO,
  HOME_COUNTRY_NONE,
} from "./homeCountry";

describe("detectHomeCountry", () => {
  it("reads the country the file's own places mostly name", () => {
    const d = detectHomeCountry([
      "Kranj, Slovenija",
      "Ljubljana, Slovenia",
      "Golnik",
      "Vodice",
      "Šmartno pri Litiji, sv. Martin",
    ]);
    expect(d.code).toBe("si");
    expect(d.named).toBe(2);
    expect(d.namedTotal).toBe(2);
    // The three that name none are exactly what the assumption would cover.
    expect(d.unnamed).toBe(3);
  });

  it("says nothing about a file split between two countries", () => {
    // Two to one is a lead, not a home country: a file that keeps naming both
    // is a file about both, and the silent places could be in either.
    const d = detectHomeCountry(["Kranj, Slovenija", "Zagreb, Hrvaška", "Split, Croatia", "Golnik"]);
    expect(d.code).toBe("");
    expect(d.namedTotal).toBe(3);
  });

  it("does not let one stray country decide for a file of bare names", () => {
    const d = detectHomeCountry(["Kranj, Slovenija", "Golnik", "Vodice", "Ig"]);
    expect(d.code).toBe("");
  });

  it("counts a value once however often the file writes it", () => {
    // Distinct values, not occurrences: one heavily used birthplace must not
    // outvote the rest of the file.
    const d = detectHomeCountry([
      "Kranj, Slovenija",
      "Kranj, Slovenija",
      "Kranj, Slovenija",
      "Bled, Slovenija",
      "Radovljica, Slovenija",
      "Wien, Austria",
    ]);
    expect(d.code).toBe("si");
    expect(d.named).toBe(3);
    expect(d.namedTotal).toBe(4);
  });

  it("never picks a country the world no longer has", () => {
    // A home country exists to point lookups at a register, and no register
    // describes Yugoslavia.
    const d = detectHomeCountry(["Beograd, Jugoslavija", "Zagreb, Jugoslavija", "Golnik"]);
    expect(d.code).toBe("");
    expect(d.namedTotal).toBe(2);
  });

  it("has nothing to say about a file with no places at all", () => {
    expect(detectHomeCountry([])).toEqual({ code: "", spelling: "", named: 0, namedTotal: 0, unnamed: 0 });
  });
});

describe("countrySpelling", () => {
  it("writes the country the way the file already writes it", () => {
    // Two spellings, and the file's own majority decides — a value written into
    // this file must look like the file, not like the reader's interface.
    const d = detectHomeCountry(["Kranj, Slovenija", "Bled, Slovenija", "Ljubljana, Slovenia", "Golnik"]);
    expect(d.code).toBe("si");
    expect(countrySpelling(d, "si", "en")).toBe("Slovenija");
  });

  it("falls back to the reader's language for a country the file never names", () => {
    const d = detectHomeCountry(["Kranj, Slovenija", "Bled, Slovenija"]);
    expect(countrySpelling(d, "at", "sl")).toBe("Avstrija");
    expect(countrySpelling(d, "at", "en")).toBe("Austria");
  });
});

describe("resolveHomeCountry", () => {
  it("follows the file only where the reader has not chosen", () => {
    expect(resolveHomeCountry(HOME_COUNTRY_AUTO, "si")).toBe("si");
    expect(resolveHomeCountry(HOME_COUNTRY_NONE, "si")).toBe("");
    expect(resolveHomeCountry("at", "si")).toBe("at");
  });
});
