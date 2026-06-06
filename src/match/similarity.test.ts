import { describe, expect, it } from "vitest";
import { localityParts, parsePlace } from "../gedcom/place";
import { parseDate } from "../gedcom/date";
import { dateSimilarity, placeSimilarity } from "./similarity";

describe("dateSimilarity", () => {
  const d = (s: string) => parseDate(s);

  it("scores identical dates 1.0 at every precision", () => {
    expect(dateSimilarity(d("12 JAN 1900"), d("12 JAN 1900"))).toBe(1);
    expect(dateSimilarity(d("JAN 1900"), d("JAN 1900"))).toBe(1);
    expect(dateSimilarity(d("1900"), d("1900"))).toBe(1);
    expect(dateSimilarity(d("ABT 1900"), d("ABT 1900"))).toBe(1);
  });

  it("treats dates that agree at the common precision as full matches", () => {
    expect(dateSimilarity(d("12 JAN 1900"), d("1900"))).toBe(1);
  });

  it("downweights real discrepancies", () => {
    expect(dateSimilarity(d("12 JAN 1900"), d("12 FEB 1900"))).toBeLessThan(0.7);
    expect(dateSimilarity(d("1900"), d("1905"))!).toBeLessThan(1);
    expect(dateSimilarity(d("1900"), d("1990"))).toBe(0);
  });
});

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
