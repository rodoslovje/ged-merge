import { describe, expect, it } from "vitest";
import { buildDataset } from "../../gedcom/builder";
import { parseGedcom } from "../../gedcom/parser";
import { buildPlaceSuggestions, placeAddrCoordKey, placeKey } from "./placeSuggestions";

function build(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

// Two Kranj events: one plain (the settlement's own coordinate), one at a house
// with its own. Plus a second event at that same house, uncoordinated.
const FILE = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Kranj, Slovenija
3 MAP
4 LATI N46.23887
4 LONG E14.35561
1 RESI
2 PLAC Kranj, Slovenija
3 MAP
4 LATI N46.24137
4 LONG E14.35580
2 ADDR Kidričeva cesta 38
1 CENS
2 PLAC Kranj, Slovenija
2 ADDR Kidričeva cesta 38
0 TRLR
`;

describe("buildPlaceSuggestions coordinates", () => {
  const sug = buildPlaceSuggestions(build(FILE));

  it("takes a place's coordinate only from events with no address", () => {
    // Otherwise the house at Kidričeva 38 could become "the coordinate of Kranj"
    // and get inherited by every other Kranj event.
    expect(sug.placeCoords.get(placeKey("Kranj, Slovenija"))).toEqual({ lat: 46.23887, lon: 14.35561 });
  });

  it("keeps the house coordinate against its own place+address pair", () => {
    expect(sug.pairCoords.get(placeAddrCoordKey("Kranj, Slovenija", "Kidričeva cesta 38"))).toEqual({
      lat: 46.24137,
      lon: 14.3558,
    });
  });

  it("prefers the most frequent coordinate when occurrences disagree", () => {
    const ds = build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Bled
3 MAP
4 LATI N46.3683
4 LONG E14.1136
1 DEAT
2 PLAC Bled
3 MAP
4 LATI N46.3683
4 LONG E14.1136
1 RESI
2 PLAC Bled
3 MAP
4 LATI N46.0
4 LONG E14.0
0 TRLR
`);
    expect(buildPlaceSuggestions(ds).placeCoords.get(placeKey("Bled"))).toEqual({ lat: 46.3683, lon: 14.1136 });
  });

  it("has no entry for a place the file never coordinates", () => {
    const ds = build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Neznano
0 TRLR
`);
    expect(buildPlaceSuggestions(ds).placeCoords.size).toBe(0);
    expect(buildPlaceSuggestions(ds).pairCoords.size).toBe(0);
  });
});

describe("coordinate maps as the \"file uses locations\" signal", () => {
  // The Edit pin renders only when the file uses coordinates somewhere; between
  // them these two maps cover every PLAC that carries a MAP, so both being empty
  // is that test. Guarding it here keeps the pin from reappearing on files that
  // have no locations at all.
  it("is empty for a file with places but no coordinates", () => {
    const sug = buildPlaceSuggestions(
      build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Kranj, Slovenija
1 RESI
2 PLAC Kranj, Slovenija
2 ADDR Kidričeva cesta 38
0 TRLR
`),
    );
    expect(sug.placeCoords.size + sug.pairCoords.size).toBe(0);
  });

  it("is non-empty as soon as one coordinate exists, whether or not it has an address", () => {
    const onlyAddressed = buildPlaceSuggestions(
      build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 RESI
2 PLAC Kranj, Slovenija
3 MAP
4 LATI N46.24137
4 LONG E14.35580
2 ADDR Kidričeva cesta 38
0 TRLR
`),
    );
    // Covered by pairCoords alone — placeCoords ignores addressed events.
    expect(onlyAddressed.placeCoords.size).toBe(0);
    expect(onlyAddressed.placeCoords.size + onlyAddressed.pairCoords.size).toBe(1);
  });
});

describe("buildPlaceSuggestions place FORM", () => {
  it("offers the FORM the file already writes for that place", () => {
    const sug = buildPlaceSuggestions(build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Kranj, Kranj, Slovenija
3 FORM Place,Upravna Enota,Country
0 TRLR
`));
    expect(sug.placeForms.get(placeKey("Kranj, Kranj, Slovenija"))).toBe("Place,Upravna Enota,Country");
    // Nothing is said about a place the file has never labelled.
    expect(sug.placeForms.get(placeKey("Bled, Slovenija"))).toBeUndefined();
  });

  it("takes the most-used wording when the file disagrees with itself", () => {
    const sug = buildPlaceSuggestions(build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Kranj, Kranj, Slovenija
3 FORM Place,Upravna Enota,Country
1 DEAT
2 PLAC Kranj, Kranj, Slovenija
3 FORM Place,Upravna Enota,Country
0 @I2@ INDI
1 BIRT
2 PLAC Kranj, Kranj, Slovenija
3 FORM Place,Občina,Country
0 TRLR
`));
    expect(sug.placeForms.get(placeKey("Kranj, Kranj, Slovenija"))).toBe("Place,Upravna Enota,Country");
  });

  it("ignores a FORM that doesn't label every part of its place", () => {
    const sug = buildPlaceSuggestions(build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Slovenija, Slovenija
3 FORM Place,Upravna Enota,Country
0 TRLR
`));
    expect(sug.placeForms.size).toBe(0);
  });
});

describe("address ordering", () => {
  it("sorts a place's addresses by house number, not lexicographically", () => {
    const sug = buildPlaceSuggestions(build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Tupaliče, Preddvor, Slovenija
2 ADDR Tupaliče 11
1 RESI
2 PLAC Tupaliče, Preddvor, Slovenija
2 ADDR Tupaliče 8
1 CENS
2 PLAC Tupaliče, Preddvor, Slovenija
2 ADDR Tupaliče 9 (pd Celar)
1 EVEN
2 PLAC Tupaliče, Preddvor, Slovenija
2 ADDR Tupaliče 13
0 TRLR
`));
    expect(sug.placeToAddrs.get(placeKey("Tupaliče, Preddvor, Slovenija"))).toEqual([
      "Tupaliče 8",
      "Tupaliče 9 (pd Celar)",
      "Tupaliče 11",
      "Tupaliče 13",
    ]);
  });
});
