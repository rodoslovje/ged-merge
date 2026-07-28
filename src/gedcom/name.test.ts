import { describe, expect, it } from "vitest";
import { splitFullName } from "./name";

describe("splitFullName", () => {
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
