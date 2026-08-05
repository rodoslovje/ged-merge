import { describe, expect, it } from "vitest";
import { capitalizeTypedName, splitFullName } from "./name";

describe("capitalizeTypedName", () => {
  it("gives a hurriedly typed name its capitals", () => {
    expect(capitalizeTypedName("ana stare")).toBe("Ana Stare");
    expect(capitalizeTypedName("ana marija terezija")).toBe("Ana Marija Terezija");
  });

  it("leaves a word that was not typed all in lower case alone", () => {
    // The uppercase-surname convention, and names with a capital inside.
    expect(capitalizeTypedName("ana STARE")).toBe("Ana STARE");
    expect(capitalizeTypedName("john McDonald")).toBe("John McDonald");
    expect(capitalizeTypedName("Ana Stare")).toBe("Ana Stare");
  });

  it("capitalizes each part of a hyphenated or apostrophed name", () => {
    expect(capitalizeTypedName("ana-marija stare")).toBe("Ana-Marija Stare");
    expect(capitalizeTypedName("d'angelo")).toBe("D'Angelo");
  });

  it("handles letters outside ASCII", () => {
    expect(capitalizeTypedName("živa čebular")).toBe("Živa Čebular");
    expect(capitalizeTypedName("šuštaršič")).toBe("Šuštaršič");
  });

  it("leaves empty and blank text as it is", () => {
    expect(capitalizeTypedName("")).toBe("");
    expect(capitalizeTypedName("   ")).toBe("   ");
  });
});

describe("splitFullName", () => {
  it("capitalizes the typed text as it splits it", () => {
    expect(splitFullName("ana stare")).toEqual({ given: "Ana", surname: "Stare" });
    expect(splitFullName("stare ana", "surname-given")).toEqual({ surname: "Stare", given: "Ana" });
  });

  it("takes the last token as the surname in given-surname order", () => {
    expect(splitFullName("Janez Novak")).toEqual({ given: "Janez", surname: "Novak" });
    expect(splitFullName("Ana Marija Novak")).toEqual({ given: "Ana Marija", surname: "Novak" });
  });

  it("takes the first token as the surname in surname-given order", () => {
    expect(splitFullName("Novak Janez", "surname-given")).toEqual({ surname: "Novak", given: "Janez" });
    expect(splitFullName("Novak Ana Marija", "surname-given")).toEqual({ surname: "Novak", given: "Ana Marija" });
  });

  it("treats a single word as a given name in either order", () => {
    expect(splitFullName("Janez")).toEqual({ given: "Janez" });
    expect(splitFullName("Janez", "surname-given")).toEqual({ given: "Janez" });
  });

  it("ignores surrounding and repeated whitespace", () => {
    expect(splitFullName("  Janez   Novak  ")).toEqual({ given: "Janez", surname: "Novak" });
  });

  it("returns nothing for blank input", () => {
    expect(splitFullName("   ")).toEqual({});
  });
});
