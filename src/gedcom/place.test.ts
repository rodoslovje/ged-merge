import { describe, expect, it } from "vitest";
import { decomposePlace } from "./place";

describe("decomposePlace", () => {
  it("splits a structured comma place (Renko PLAC)", () => {
    const p = decomposePlace("Srednje Bitnje,Kranj,Slovenia");
    expect(p.locality).toBe("Srednje Bitnje");
    expect(p.country).toBe("Slovenia");
    expect(p.jurisdiction).toEqual(["Srednje Bitnje", "Kranj", "Slovenia"]);
    expect(p.houseNumber).toBeUndefined();
    expect(p.street).toBeUndefined();
  });

  it("extracts house number and 'po domače' name from a Renko ADDR", () => {
    const p = decomposePlace("Srednje Bitnje 18 (pd Adam)");
    expect(p.locality).toBe("Srednje Bitnje");
    expect(p.houseNumber).toBe("18");
    expect(p.houseName).toBe("Adam");
  });

  it("decomposes a Brother's Keeper packed place with a street and facility", () => {
    const p = decomposePlace("Kranj (Slovenija), Kidričeva   38/a (porodnišnica)");
    expect(p.locality).toBe("Kranj");
    expect(p.country).toBe("Slovenija");
    expect(p.street).toBe("Kidričeva 38/a");
    expect(p.houseNumber).toBe("38/a");
    expect(p.facility).toBe("porodnišnica");
    expect(p.jurisdiction).toEqual(["Kranj", "Slovenija"]);
  });

  it("pulls the parish out of a '- župnija X' suffix", () => {
    const p = decomposePlace("Jesenice (Slovenija), Cesta revolucije 2/b - župnija Jesenice");
    expect(p.locality).toBe("Jesenice");
    expect(p.country).toBe("Slovenija");
    expect(p.street).toBe("Cesta revolucije 2/b");
    expect(p.parish).toBe("Jesenice");
  });

  it("treats 'Locality 52' as a house number, not a street", () => {
    const p = decomposePlace("Podčetrtek (Slovenija), Podčetrtek 52 - župnija Šmarje pri Jelšah");
    expect(p.locality).toBe("Podčetrtek");
    expect(p.houseNumber).toBe("52");
    expect(p.street).toBeUndefined();
    expect(p.parish).toBe("Šmarje pri Jelšah");
  });

  it("routes a bare facility segment to facility, not jurisdiction", () => {
    const p = decomposePlace("Jesenice (Slovenija), porodnišnica");
    expect(p.facility).toBe("porodnišnica");
    expect(p.jurisdiction).toEqual(["Jesenice", "Slovenija"]);
  });

  it("treats a numberless street as a street, not a jurisdiction level", () => {
    const p = decomposePlace("Jesenice (Slovenija), Gosposvetska cesta blok VII");
    expect(p.street).toBe("Gosposvetska cesta blok VII");
    expect(p.jurisdiction).toEqual(["Jesenice", "Slovenija"]);
  });

  it("does not mistake a hyphenated place name for a parish", () => {
    const p = decomposePlace("Kalce - Naklo (Slovenija)");
    expect(p.parish).toBeUndefined();
    expect(p.jurisdiction).toEqual(["Kalce - Naklo", "Slovenija"]);
  });

  it("routes a leading facility segment to facility and the locality from the next segment", () => {
    const p = decomposePlace("Mestno Pokopališče Kranj,Kranj,Slovenia");
    expect(p.facility).toBe("Mestno Pokopališče Kranj");
    expect(p.locality).toBe("Kranj");
    expect(p.jurisdiction).toEqual(["Kranj", "Slovenia"]);
  });

  it("handles a bare 'Locality (Country)' place", () => {
    const p = decomposePlace("Jesenice (Slovenija)");
    expect(p.locality).toBe("Jesenice");
    expect(p.country).toBe("Slovenija");
    expect(p.jurisdiction).toEqual(["Jesenice", "Slovenija"]);
    expect(p.street).toBeUndefined();
    expect(p.houseNumber).toBeUndefined();
  });
});
