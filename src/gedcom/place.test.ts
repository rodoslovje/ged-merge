import { describe, expect, it } from "vitest";
import { decomposePlace, stripParishLabel } from "./place";

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

  it("canonicalizes a renumbering house-number pair to single-spaced slashes", () => {
    const p = decomposePlace("Gradac (Slovenija), Klošter 82 / 63 / 11");
    expect(p.houseNumber).toBe("82 / 63 / 11");

    const packed = decomposePlace("Gradac (Slovenija), Klošter 82/63/11");
    expect(packed.houseNumber).toBe("82 / 63 / 11");
  });

  it("pulls the parish out of a '- župnija X' suffix", () => {
    const p = decomposePlace("Jesenice (Slovenija), Cesta revolucije 2/b - župnija Jesenice");
    expect(p.locality).toBe("Jesenice");
    expect(p.country).toBe("Slovenija");
    expect(p.street).toBe("Cesta revolucije 2/b");
    expect(p.parish).toBe("Jesenice");
  });

  it("also recognizes the Croatian 'župa' and English 'parish' markers", () => {
    const hr = decomposePlace("Jesenice (Slovenija), Cesta revolucije 2/b - župa Jesenice");
    expect(hr.parish).toBe("Jesenice");

    const en = decomposePlace("Jesenice (Slovenija), Cesta revolucije 2/b - parish Jesenice");
    expect(en.parish).toBe("Jesenice");
  });

  it("treats 'Locality 52' as a house number, not a street", () => {
    const p = decomposePlace("Podčetrtek (Slovenija), Podčetrtek 52 - župnija Šmarje pri Jelšah");
    expect(p.locality).toBe("Podčetrtek");
    expect(p.houseNumber).toBe("52");
    expect(p.street).toBeUndefined();
    expect(p.parish).toBe("Šmarje pri Jelšah");
  });

  it("reads a number-only segment as the house number, wherever it appears", () => {
    // Leading (ADDR "26 (Kapela)") — used to become locality "26".
    const lead = decomposePlace("26 (Kapela)");
    expect(lead.houseNumber).toBe("26");
    expect(lead.locality).toBeUndefined();
    expect(lead.facility).toBe("Kapela");

    // Middle ("Hrašenski Vrh, 26, Kapela") — used to become street "26".
    const mid = decomposePlace("Hrašenski Vrh, 26, Kapela");
    expect(mid.locality).toBe("Hrašenski Vrh");
    expect(mid.houseNumber).toBe("26");
    expect(mid.street).toBeUndefined();
  });

  it("does not read a renumbering chain ending in a word as a house number", () => {
    // "99/145/Vrata" ends in a hamlet name — the whole locality must survive.
    const p = decomposePlace("Čepovan 99/145/Vrata (Slovenija), Čepovan 99/145/Vrata 51");
    expect(p.locality).toBe("Čepovan 99/145/Vrata");
    expect(p.houseNumber).toBe("51");
  });

  it("keeps a facility named '<X> Parish (country)' whole instead of reading a parish", () => {
    const p = decomposePlace("Holy Wisdom Parish (USA)");
    expect(p.parish).toBeUndefined();
    expect(p.locality).toBe("Holy Wisdom Parish");
    expect(p.country).toBe("USA");
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

describe("stripParishLabel", () => {
  it("strips 'župnija', Croatian 'župa', and English 'parish' prefixes", () => {
    expect(stripParishLabel("Župnija Kranj")).toBe("Kranj");
    expect(stripParishLabel("Župa Kranj")).toBe("Kranj");
    expect(stripParishLabel("Parish Kranj")).toBe("Kranj");
  });

  it("leaves an unrelated agency value untouched", () => {
    expect(stripParishLabel("Maribor hospital")).toBeUndefined();
  });
});
