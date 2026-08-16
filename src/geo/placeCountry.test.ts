import { describe, it, expect } from "vitest";
import { countryCodeOfName, countryFacetLabel, placeCountryFacet } from "./placeCountry";

describe("countryCodeOfName", () => {
  it("knows a country by its name in any of the languages these files use", () => {
    expect(countryCodeOfName("Slovenija")).toBe("si");
    expect(countryCodeOfName("Slovenia")).toBe("si");
    expect(countryCodeOfName("Slowenien")).toBe("si");
    expect(countryCodeOfName("Ungarn")).toBe("hu");
    expect(countryCodeOfName("Ungheria")).toBe("hu");
    expect(countryCodeOfName("Mađarska")).toBe("hu");
    expect(countryCodeOfName("Poljska")).toBe("pl");
  });

  it("reads past case, accents and the punctuation a file adds", () => {
    expect(countryCodeOfName("SLOVENIA")).toBe("si");
    expect(countryCodeOfName("Slovenija.")).toBe("si");
    expect(countryCodeOfName("Hrvaska")).toBe("hr");
    expect(countryCodeOfName("Bosnia-Herzegovina")).toBe("ba");
  });

  it("does not make a country of a name that is none", () => {
    expect(countryCodeOfName("sv. Martin")).toBeUndefined();
    expect(countryCodeOfName("Marijino vnebovzetje")).toBeUndefined();
    expect(countryCodeOfName("bolnica")).toBeUndefined();
    expect(countryCodeOfName("1.3.1878")).toBeUndefined();
  });
});

describe("placeCountryFacet", () => {
  it("takes the country the value names, wherever in the value it stands", () => {
    expect(placeCountryFacet("Ravna Gora, Primorje-Gorski Kotar, Croatia")).toBe("hr");
    expect(placeCountryFacet("Ljubljana (Slovenija)")).toBe("si");
    expect(placeCountryFacet("Amsterdam, The Netherlands")).toBe("nl");
    // A value that is nothing but a country is that country.
    expect(placeCountryFacet("Avstrija")).toBe("at");
  });

  it("reads a state as the country it belongs to", () => {
    expect(placeCountryFacet("Hobart, Tasmania")).toBe("au");
    expect(placeCountryFacet("Cleveland, Cuyahoga, Ohio")).toBe("us");
    expect(placeCountryFacet("Perth, Western Australia")).toBe("au");
    expect(placeCountryFacet("Toronto, Ontario")).toBe("ca");
  });

  it("lets the country named in the value overrule the state", () => {
    // A "Georgia" between two American levels is the state; standing alone it is
    // the country every other list already reads it as.
    expect(placeCountryFacet("Chicago, Cook, Illinois, United States")).toBe("us");
    expect(placeCountryFacet("Tbilisi, Georgia")).toBe("ge");
  });

  it("does not let an American county named after a country take it", () => {
    // Lebanon County, Pennsylvania — five of these sat under a Lebanon chip,
    // with "United States" written at the end of every one of them.
    expect(placeCountryFacet("Cornwall, Lebanon, Pennsylvania, United States")).toBe("us");
    expect(
      placeCountryFacet("Holy Savior Cemetery, Cornwall, Lebanon, Pennsylvania, United States"),
    ).toBe("us");
  });

  it("counts no country where the value names none", () => {
    expect(placeCountryFacet("Šmartno pri Litiji, sv. Martin")).toBe("");
    expect(placeCountryFacet("Kranjska Gora, Marijino vnebozetje")).toBe("");
    expect(placeCountryFacet("Golnik")).toBe("");
    expect(placeCountryFacet("26.12.1958")).toBe("");
  });

  it("keeps a country the world no longer has under its own name", () => {
    // No ISO code exists for it, and the file's own wording is the only name
    // anyone has for the place.
    expect(placeCountryFacet("Beograd, Jugoslavija")).toBe("Jugoslavija");
  });
});

describe("countryFacetLabel", () => {
  it("writes the flag and the country's name in the reader's language", () => {
    expect(countryFacetLabel("si", "sl")).toBe("🇸🇮 Slovenija");
    expect(countryFacetLabel("si", "en")).toBe("🇸🇮 Slovenia");
    expect(countryFacetLabel("at", "sl")).toBe("🇦🇹 Avstrija");
  });

  it("leaves a codeless country the wording the file gave it", () => {
    expect(countryFacetLabel("Jugoslavija", "sl")).toBe("Jugoslavija");
  });
});
