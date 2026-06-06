import { describe, expect, it } from "vitest";
import { localityParts, parsePlace } from "../gedcom/place";
import { placeSimilarity } from "./similarity";

describe("parsePlace place detail", () => {
  it("extracts a trailing house number from the leading part", () => {
    expect(parsePlace("Šentvid 23").detail).toBe("23");
    expect(parsePlace("Šentvid 72, Vuzenica").detail).toBe("72");
    expect(parsePlace("Vuzenica 12a").detail).toBe("12a");
  });

  it("leaves places without a house number undetailed", () => {
    expect(parsePlace("Šentvid").detail).toBeUndefined();
    expect(parsePlace("Suhi vrh (Št.Janž nad Radljami)").detail).toBeUndefined();
  });

  it("extracts a house number followed by a parenthetical (ADDR style)", () => {
    const addr = parsePlace("Zgornje Bitnje 52 (pd Urbanov Jaka)");
    expect(addr.detail).toBe("52");
    expect(localityParts(addr)).toEqual(["Zgornje Bitnje"]);
  });

  it("strips the house number for locality comparison", () => {
    expect(localityParts(parsePlace("Šentvid 23"))).toEqual(["Šentvid"]);
    expect(localityParts(parsePlace("Šentvid 72, Vuzenica"))).toEqual(["Šentvid", "Vuzenica"]);
  });
});

describe("placeSimilarity with house numbers", () => {
  const p = parsePlace;

  it("scores identical locality + house number highest", () => {
    expect(placeSimilarity(p("Šentvid 23"), p("Šentvid 23"))).toBe(1);
  });

  it("downweights the same village with a different house number", () => {
    const sim = placeSimilarity(p("Šentvid 23"), p("Šentvid 25"))!;
    expect(sim).toBeCloseTo(0.5, 5);
    expect(sim).toBeLessThan(placeSimilarity(p("Šentvid 23"), p("Šentvid 23"))!);
  });

  it("does not penalize when one side lacks the house number", () => {
    expect(placeSimilarity(p("Šentvid 23"), p("Šentvid"))).toBe(1);
  });

  it("keeps different localities low", () => {
    expect(placeSimilarity(p("Maribor 5"), p("Šentvid 5"))!).toBeLessThan(0.75);
  });
});
