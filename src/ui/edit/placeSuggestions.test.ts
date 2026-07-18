import { describe, expect, it } from "vitest";
import { parseGedcom } from "../../gedcom/parser";
import { buildDataset } from "../../gedcom/builder";
import { buildPlaceSuggestions, placeCombosOf, placeKey } from "./placeSuggestions";

function buildFromText(text: string) {
  const buf = new TextEncoder().encode(text);
  return buildDataset(parseGedcom(buf.buffer));
}

const SAMPLE = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Janez /Novak/
1 BIRT
2 PLAC Kranj, Slovenija
2 ADDR Cesta 1
1 RESI
2 PLAC kranj, slovenija
2 ADDR Cesta 2
1 DEAT
2 PLAC Kranj, Slovenija
2 ADDR Cesta 1
0 @F1@ FAM
1 HUSB @I1@
1 MARR
2 PLAC Ljubljana
0 TRLR
`;

describe("buildPlaceSuggestions + placeCombosOf", () => {
  const sug = buildPlaceSuggestions(buildFromText(SAMPLE));

  it("canonicalizes case variants to the most frequent form", () => {
    // "Kranj, Slovenija" occurs twice, the lowercase variant once.
    expect(sug.placeCanonical.get(placeKey("KRANJ, Slovenija"))).toBe("Kranj, Slovenija");
    expect(sug.placeSuggestions).toContain("Ljubljana");
  });

  it("flattens every place+address pair into combos with canonical casing", () => {
    const combos = placeCombosOf(sug.placeToAddrs, sug.placeCanonical);
    // Both addresses seen at Kranj, each once, under the canonical spelling;
    // Ljubljana has no address so it contributes no combo.
    expect(combos).toEqual([
      { place: "Kranj, Slovenija", addr: "Cesta 1" },
      { place: "Kranj, Slovenija", addr: "Cesta 2" },
    ]);
  });

  it("caches the flattening per placeToAddrs map identity", () => {
    const a = placeCombosOf(sug.placeToAddrs, sug.placeCanonical);
    expect(placeCombosOf(sug.placeToAddrs, sug.placeCanonical)).toBe(a);
    // A rebuilt suggestions object gets a fresh flattening.
    const sug2 = buildPlaceSuggestions(buildFromText(SAMPLE));
    expect(placeCombosOf(sug2.placeToAddrs, sug2.placeCanonical)).not.toBe(a);
  });
});
