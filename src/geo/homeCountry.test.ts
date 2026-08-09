import { describe, it, expect } from "vitest";
import { buildGazetteerIndex, type GazEntry } from "./gazetteer";
import {
  countrySpelling,
  detectHomeCountry,
  detectHomeCountryFromRegister,
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

/** A directory of settlements, named and nothing more — the vote reads names. */
function directory(country: string, names: string[]) {
  return names.map(
    (name): GazEntry => ({
      name,
      ascii: name,
      alt: [],
      lat: 46,
      lon: 14,
      fclass: "P",
      country: country.toUpperCase(),
      admin1: "",
      population: 100,
    }),
  );
}

const SI_NAMES = ["Poljane", "Lučine", "Šentjošt", "Hotovlja", "Zminec", "Gorenja vas", "Javorje", "Sorica", "Bukov vrh", "Reteče", "Godešič", "Selca"];
const HR_NAMES = ["Delnice", "Karlovac", "Ogulin", "Vrbovsko", "Slunj", "Duga Resa", "Gospić", "Otočac", "Senj", "Novi Vinodolski", "Crikvenica", "Rijeka"];

describe("detectHomeCountryFromRegister", () => {
  const si = buildGazetteerIndex(directory("si", SI_NAMES));
  const both = buildGazetteerIndex([...directory("si", SI_NAMES), ...directory("hr", HR_NAMES)]);

  it("reads the country whose directory holds the file's silent places", () => {
    const vote = detectHomeCountryFromRegister(SI_NAMES, si);
    expect(vote.code).toBe("si");
    expect(vote.won).toBe(SI_NAMES.length);
  });

  it("looks the settlement up, not the house on it", () => {
    // Two thirds of a parish file's values end in a house number.
    const vote = detectHomeCountryFromRegister(SI_NAMES.map((n, i) => `${n} ${i + 1}`), si);
    expect(vote.code).toBe("si");
  });

  it("leaves the places that name their own country out of it", () => {
    // They have already spoken, and counting them twice would let the file's
    // handful of emigrant places settle a question they were never about.
    const vote = detectHomeCountryFromRegister([...SI_NAMES, "Youngstown, USA", "Cleveland, USA"], si);
    expect(vote.examined).toBe(SI_NAMES.length);
  });

  it("says nothing when the only directory on the shelf holds almost none of them", () => {
    // The guard against the reader's own shelf: a Croatian file with only the
    // Slovenian directory imported hits the dozen names the two share, and
    // every one of those hits is unanimously Slovenian.
    const croatian = [...HR_NAMES, ...Array.from({ length: 60 }, (_, i) => `Selo ${i}`), "Poljane"];
    const vote = detectHomeCountryFromRegister(croatian, si);
    expect(vote.code).toBe("");
    expect(vote.examined).toBeGreaterThan(vote.decided);
  });

  it("gives the same file to Croatia once Croatia's directory is on the shelf", () => {
    expect(detectHomeCountryFromRegister(HR_NAMES, both).code).toBe("hr");
  });

  it("takes no notice of a name both countries' directories hold", () => {
    const shared = buildGazetteerIndex([...directory("si", ["Draga"]), ...directory("hr", ["Draga"])]);
    const vote = detectHomeCountryFromRegister(["Draga"], shared);
    expect(vote.decided).toBe(0);
    expect(vote.code).toBe("");
  });

  it("needs more than a handful of names before it speaks", () => {
    expect(detectHomeCountryFromRegister(SI_NAMES.slice(0, 4), si).code).toBe("");
  });

  it("is not decided by a placeholder", () => {
    expect(detectHomeCountryFromRegister(["____", "?", "-"], si)).toMatchObject({ code: "", examined: 0 });
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
